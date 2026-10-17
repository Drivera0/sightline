"""Replaying search steps, and making any lane-C map obey the contract's rounding rules."""

from __future__ import annotations

import math
from collections.abc import Sequence

from sightline.contract import Distribution, MapFile, Step, TopCell
from sightline.pipeline.geometry import cell_center

POD_DECIMALS = 4
MIN_POD = 0.001  # steps omit cells below this (contract section 8)


def replay_steps(
    prior_p: Sequence[float], outside: float, steps: Sequence[Step]
) -> tuple[list[float], float]:
    """Apply each step's update (contract section 8) to the prior. The inputs are not changed.

    denominator = 1 - sum(p[idx] * pod over the step's cells)
    p[idx] *= (1 - pod) for the step's cells, then every p and `outside` is divided by it
    """
    p = list(prior_p)
    for step in steps:
        denominator = 1 - math.fsum(p[idx] * pod for idx, pod in step.cells)
        if denominator <= 0:
            raise ValueError(f"{step.frame_id}: the step leaves no probability mass")
        for idx, pod in step.cells:
            p[idx] *= 1 - pod
        p = [x / denominator for x in p]
        outside /= denominator
    return p, outside


def normalise_map(map_file: MapFile) -> MapFile:
    """Round pods to 4 decimals, drop pods below 0.001, then recompute `final` and `top_cells`.

    The contract defines `final` as the replay of the steps *as written* (rounded pods) on the
    unrounded prior, so whatever lane C computed is replaced by that replay. Idempotent.
    """
    steps = [
        Step(
            frame_id=step.frame_id,
            cells=[
                (idx, rounded)
                for idx, pod in step.cells
                if (rounded := round(pod, POD_DECIMALS)) >= MIN_POD
            ],
        )
        for step in map_file.steps
    ]
    final_p, final_outside = replay_steps(map_file.prior.p, map_file.prior.outside, steps)
    ranked = sorted(range(len(final_p)), key=lambda idx: (-final_p[idx], idx))[:5]
    top_cells = []
    for idx in ranked:
        lat, lon = cell_center(map_file.grid, idx)
        top_cells.append(
            TopCell(idx=idx, lat=lat, lon=lon, p=final_p[idx], canopy=map_file.canopy[idx])
        )
    return MapFile(
        contract_version=map_file.contract_version,
        grid=map_file.grid,
        lkp=map_file.lkp,
        params=map_file.params,
        prior=map_file.prior,
        canopy=map_file.canopy,
        steps=steps,
        final=Distribution(p=final_p, outside=final_outside),
        top_cells=top_cells,
    )
