"""Tests for selecting geographically coherent real-pose photos."""

from __future__ import annotations

from pathlib import Path

import pytest

from sightline.contract import Pose
from sightline.geo.pose import RealPoseInfo
from sightline.geo.real import cluster_real_photos, select_real_photos


# Build a complete test pose without requiring JPEG metadata fixtures.
def _info(lat: float, lon: float, pitch_deg: float = -90.0) -> RealPoseInfo:
    return RealPoseInfo(
        pose=Pose(
            lat=lat,
            lon=lon,
            alt_agl_m=50.0,
            heading_deg=90.0,
            gsd_m=0.02,
        ),
        pitch_deg=pitch_deg,
        camera_model="DJI TEST",
        nadir=abs(pitch_deg + 90.0) <= 10.0,
    )


# Keep nadir photos while separately reporting missing and oblique metadata.
def test_select_real_photos_flags_rejected_images() -> None:
    images = [Path("nadir.jpg"), Path("oblique.jpg"), Path("missing.jpg")]
    metadata = {
        images[0]: _info(43.37, 17.59),
        images[1]: _info(43.37, 17.59, pitch_deg=-55.0),
        images[2]: None,
    }

    selection = select_real_photos(images, pose_reader=metadata.get)

    assert [photo.image.name for photo in selection.accepted] == ["nadir.jpg"]
    assert selection.oblique == (images[1],)
    assert selection.missing_pose == (images[2],)


# Split photos at separate sites and put the largest coherent site first.
def test_cluster_real_photos_does_not_invent_cross_site_flight() -> None:
    images = [Path(f"p{index}.jpg") for index in range(4)]
    metadata = {
        images[0]: _info(43.37000, 17.59000),
        images[1]: _info(43.37010, 17.59010),
        images[2]: _info(43.37020, 17.59020),
        images[3]: _info(44.00000, 18.00000),
    }
    photos = select_real_photos(images, pose_reader=metadata.get).accepted

    clusters = cluster_real_photos(photos, max_separation_m=100.0)

    assert [[photo.image.name for photo in cluster] for cluster in clusters] == [
        ["p0.jpg", "p1.jpg", "p2.jpg"],
        ["p3.jpg"],
    ]


# Reject invalid clustering distances before any geographic calculations.
def test_cluster_real_photos_requires_positive_distance() -> None:
    with pytest.raises(ValueError, match="positive"):
        cluster_real_photos((), max_separation_m=0)
