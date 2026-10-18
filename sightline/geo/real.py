"""Selection and clustering helpers for real EXIF/XMP photo positions."""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

from .pose import RealPoseInfo, read_pose

EARTH_RADIUS_M = 6_371_008.8


@dataclass(frozen=True)
class RealPhoto:
    """One source photo whose metadata is complete enough for nadir projection."""

    image: Path
    pose_info: RealPoseInfo


@dataclass(frozen=True)
class RealPhotoSelection:
    """Accepted nadir photos plus explicit reasons for every rejected photo."""

    accepted: tuple[RealPhoto, ...]
    oblique: tuple[Path, ...]
    missing_pose: tuple[Path, ...]


# Keep photos supported by the flat-ground model and flag every rejection reason.
def select_real_photos(
    images: Iterable[Path],
    *,
    pose_reader: Callable[[Path], RealPoseInfo | None] = read_pose,
) -> RealPhotoSelection:
    """Read source metadata and partition photos into nadir, oblique, and incomplete groups."""
    accepted: list[RealPhoto] = []
    oblique: list[Path] = []
    missing_pose: list[Path] = []
    for image in sorted((Path(path) for path in images), key=lambda path: path.name):
        info = pose_reader(image)
        if info is None:
            missing_pose.append(image)
        elif not info.nadir:
            oblique.append(image)
        else:
            accepted.append(RealPhoto(image=image, pose_info=info))
    return RealPhotoSelection(
        accepted=tuple(accepted),
        oblique=tuple(oblique),
        missing_pose=tuple(missing_pose),
    )


# Group nearby photos so the map never joins unrelated collection sites into a fictitious flight.
def cluster_real_photos(
    photos: Sequence[RealPhoto],
    *,
    max_separation_m: float = 500.0,
) -> tuple[tuple[RealPhoto, ...], ...]:
    """Return connected geographic clusters, largest first, with stable filename ordering."""
    if max_separation_m <= 0:
        raise ValueError("max_separation_m must be positive")

    remaining = set(range(len(photos)))
    clusters: list[tuple[RealPhoto, ...]] = []
    while remaining:
        component = {min(remaining)}
        frontier = list(component)
        remaining -= component
        while frontier:
            current = frontier.pop()
            neighbours = {
                candidate
                for candidate in remaining
                if _distance_m(photos[current], photos[candidate]) <= max_separation_m
            }
            component |= neighbours
            remaining -= neighbours
            frontier.extend(sorted(neighbours))
        cluster = tuple(sorted((photos[index] for index in component), key=lambda p: p.image.name))
        clusters.append(cluster)

    return tuple(sorted(clusters, key=lambda cluster: (-len(cluster), cluster[0].image.name)))


# Measure the great-circle separation between two camera positions.
def _distance_m(first: RealPhoto, second: RealPhoto) -> float:
    first_pose = first.pose_info.pose
    second_pose = second.pose_info.pose
    lat1 = math.radians(first_pose.lat)
    lat2 = math.radians(second_pose.lat)
    delta_lat = lat2 - lat1
    delta_lon = math.radians(second_pose.lon - first_pose.lon)
    haversine = (
        math.sin(delta_lat / 2.0) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2.0) ** 2
    )
    return 2.0 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(haversine)))
