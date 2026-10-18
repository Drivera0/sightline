"""build_map tests (LANE_C_SEARCH sections 5 and 6.3, contract sections 8 and 11)."""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from sightline.contract import Grid, LatLon, MapFile, Pose
from sightline.pipeline.mapmath import normalise_map
from sightline.search import build_map
from sightline.search.build import FrameCells
from sightline.search.grid import cell_center, local_m_to_latlon, make_grid
from sightline.search.pod import FrameInput
from sightline.search.prior import placeholder_prior
from sightline.search.update import replay

DEMO_LKP = LatLon(lat=49.37, lon=-122.945)
# Small images keep the tests fast: 100 x 75 px at 0.2 m per pixel is still 20 m x 15 m.
W_PX, H_PX = 100, 75
GSD_M = 0.2
RECALL = 0.8
GREY = (128, 128, 128)  # not green, not shadow: canopy 0
# Edge neighbours of a cell centre are 10 m away, diagonal ones 14.1 m: 12 m holds 5 cells.
HELD_RADIUS_M = 12.0


@pytest.fixture
def grid() -> Grid:
    return make_grid(DEMO_LKP)


def _idx(grid: Grid, row: int, col: int) -> int:
    return row * grid.cols + col


def _image(path: Path, w_px: int = W_PX, h_px: int = H_PX, half_black: bool = False) -> Path:
    rgb = np.zeros((h_px, w_px, 3), dtype=np.uint8)
    rgb[...] = GREY
    if half_black:
        rgb[:, : w_px // 2] = 0  # shadow: canopy 1 on the left half
    Image.fromarray(rgb).save(path)
    return path


def _frame(
    frame_id: str,
    at: LatLon,
    image: Path,
    candidates: list[tuple[LatLon, float]] | None = None,
) -> FrameInput:
    return FrameInput(
        frame_id=frame_id,
        pose=Pose(lat=at.lat, lon=at.lon, alt_agl_m=None, heading_deg=0.0, gsd_m=GSD_M),
        width_px=W_PX,
        height_px=H_PX,
        image=image,
        candidates=candidates or [],
    )


def _decimals_ok(x: float, n: int = 4) -> bool:
    return round(x, n) == x


@pytest.fixture
def survey(grid: Grid, tmp_path: Path) -> list[FrameInput]:
    """Five frames in flight order: open ground, a straddling half-shadow frame, a repeat
    look, a frame fully outside the grid and one more open frame."""
    grey = _image(tmp_path / "grey.png")
    mixed = _image(tmp_path / "mixed.png", half_black=True)
    straddle = local_m_to_latlon(grid, 12 * 20.0, 10.5 * 20.0)  # on the edge of two columns
    return [
        _frame("f0001", cell_center(grid, _idx(grid, 10, 10)), grey),
        _frame("f0002", straddle, mixed),
        _frame("f0003", cell_center(grid, _idx(grid, 10, 10)), mixed),
        _frame("f0004", local_m_to_latlon(grid, -500.0, -500.0), grey),
        _frame("f0005", cell_center(grid, _idx(grid, 30, 30)), grey),
    ]


def _build(grid: Grid, frames: list[FrameInput]) -> tuple[MapFile, list[FrameCells]]:
    return build_map(grid, DEMO_LKP, placeholder_prior(grid), frames, RECALL, "placeholder")


# --- steps ------------------------------------------------------------------------------


def test_one_step_per_frame_in_flight_order(grid: Grid, survey: list[FrameInput]) -> None:
    map_file, per_frame = _build(grid, survey)
    assert [s.frame_id for s in map_file.steps] == [f.frame_id for f in survey]
    assert len(per_frame) == len(survey)
    assert map_file.steps[3].cells == []  # fully outside the grid
    assert per_frame[3] == {}
    assert all(map_file.steps[k].cells for k in (0, 1, 2, 4))


def test_step_pods_rounded_sorted_and_above_minimum(grid: Grid, survey: list[FrameInput]) -> None:
    map_file, _ = _build(grid, survey)
    for step in map_file.steps:
        idxs = [i for i, _ in step.cells]
        assert idxs == sorted(idxs)
        for _, pod in step.cells:
            assert pod >= 0.001
            assert _decimals_ok(pod)
    # Open ground, frame centred on a cell: pod = recall * 1 * 0.75.
    first = dict(map_file.steps[0].cells)
    assert first[_idx(grid, 10, 10)] == pytest.approx(RECALL * 0.75, abs=1e-3)


# --- final ------------------------------------------------------------------------------


def test_final_is_replay_of_written_steps(grid: Grid, survey: list[FrameInput]) -> None:
    map_file, _ = _build(grid, survey)
    prior_p, prior_outside = placeholder_prior(grid)
    p, outside = replay(prior_p, prior_outside, [s.cells for s in map_file.steps])
    assert np.max(np.abs(p - np.array(map_file.final.p))) <= 1e-9
    assert abs(outside - map_file.final.outside) <= 1e-9
    assert abs(math.fsum(map_file.final.p) + map_file.final.outside - 1.0) <= 1e-9
    assert map_file.prior.p == list(prior_p)
    assert map_file.prior.outside == prior_outside


def test_pipeline_normalise_leaves_final_unchanged(grid: Grid, survey: list[FrameInput]) -> None:
    map_file, _ = _build(grid, survey)
    normalised = normalise_map(map_file)
    assert normalised.steps == map_file.steps
    diff = np.abs(np.array(normalised.final.p) - np.array(map_file.final.p))
    assert np.max(diff) <= 1e-12
    assert abs(normalised.final.outside - map_file.final.outside) <= 1e-12
    assert [c.idx for c in normalised.top_cells] == [c.idx for c in map_file.top_cells]


def test_top_cells_are_five_largest_descending(grid: Grid, survey: list[FrameInput]) -> None:
    map_file, _ = _build(grid, survey)
    final = np.array(map_file.final.p)
    expected = sorted(range(final.size), key=lambda i: (-final[i], i))[:5]
    assert [c.idx for c in map_file.top_cells] == expected
    for cell in map_file.top_cells:
        centre = cell_center(grid, cell.idx)
        assert cell.lat == round(centre.lat, 6)
        assert cell.lon == round(centre.lon, 6)
        assert cell.p == round(final[cell.idx], 4)
        assert cell.canopy == map_file.canopy[cell.idx]


# --- canopy -----------------------------------------------------------------------------


def test_canopy_is_overlap_weighted_and_null_where_uncovered(
    grid: Grid, survey: list[FrameInput]
) -> None:
    map_file, per_frame = _build(grid, survey)
    assert len(map_file.canopy) == grid.rows * grid.cols
    covered = set().union(*per_frame)
    for idx, c in enumerate(map_file.canopy):
        if idx not in covered:
            assert c is None
            continue
        assert c is not None and _decimals_ok(c)
        looks = [cells[idx] for cells in per_frame if idx in cells]
        weighted = sum(cc * a for cc, a in looks) / sum(a for _, a in looks)
        assert c == round(weighted, 4)
    # Cell (10, 10): one open look and one half-shadow look of equal overlap.
    centre = _idx(grid, 10, 10)
    assert per_frame[0][centre][0] == 0.0
    assert 0.3 < per_frame[2][centre][0] < 0.7
    assert map_file.canopy[centre] == pytest.approx(per_frame[2][centre][0] / 2, abs=1e-4)


def test_per_frame_cells_are_unrounded_floats(grid: Grid, survey: list[FrameInput]) -> None:
    _, per_frame = _build(grid, survey)
    for cells in per_frame:
        for idx, (canopy, overlap) in cells.items():
            assert isinstance(idx, int)
            assert isinstance(canopy, float) and 0.0 <= canopy <= 1.0
            assert isinstance(overlap, float) and 0.0 < overlap <= 1.0


# --- held for review (fix A) ------------------------------------------------------------


def test_candidate_in_one_frame_holds_cells_in_every_frame(grid: Grid, tmp_path: Path) -> None:
    grey = _image(tmp_path / "grey.png")
    centre = _idx(grid, 10, 10)
    at = cell_center(grid, centre)
    frames = [
        _frame("f0001", at, grey),
        _frame("f0002", at, grey, candidates=[(at, HELD_RADIUS_M)]),
        _frame("f0003", cell_center(grid, _idx(grid, 30, 30)), grey),
    ]
    map_file, per_frame = _build(grid, frames)
    assert centre not in dict(map_file.steps[0].cells)
    assert centre not in dict(map_file.steps[1].cells)
    assert centre in per_frame[0] and centre in per_frame[1]
    assert map_file.steps[2].cells  # an unrelated frame still clears its cell


# --- contract and inputs ----------------------------------------------------------------


def test_map_file_validates_and_passes_params_through(grid: Grid, survey: list[FrameInput]) -> None:
    map_file, _ = build_map(
        grid, DEMO_LKP, placeholder_prior(grid), survey, 0.71, "metrics.detector.recall"
    )
    again = MapFile.model_validate(map_file.model_dump(mode="json"))
    assert again == map_file
    assert map_file.contract_version == "1.0"
    assert map_file.grid == grid
    assert map_file.lkp == DEMO_LKP
    assert map_file.params.recall == 0.71
    assert map_file.params.recall_source == "metrics.detector.recall"
    assert map_file.params.pod_cap == 0.95
    assert map_file.params.review_pod == 0.90


def test_build_is_deterministic(grid: Grid, survey: list[FrameInput]) -> None:
    assert _build(grid, survey) == _build(grid, survey)


def test_no_frames_gives_prior_as_final(grid: Grid) -> None:
    map_file, per_frame = _build(grid, [])
    assert map_file.steps == [] and per_frame == []
    assert map_file.final == map_file.prior
    assert all(c is None for c in map_file.canopy)


def test_bad_prior_is_rejected(grid: Grid) -> None:
    p, outside = placeholder_prior(grid)
    with pytest.raises(ValueError, match="rows"):
        build_map(grid, DEMO_LKP, (p[:-1], outside), [], RECALL, "placeholder")
    with pytest.raises(ValueError, match="sum"):
        build_map(grid, DEMO_LKP, (p, outside + 0.01), [], RECALL, "placeholder")


# --- lane D's adapter -------------------------------------------------------------------


def test_pipeline_adapter_accepts_native_build_map(tmp_path: Path) -> None:
    from sightline.pipeline.geometry import FRAME_H_PX, FRAME_W_PX
    from sightline.pipeline.lanes import Lanes, MapFrame

    lanes = Lanes()
    grid = make_grid(DEMO_LKP)
    image = _image(tmp_path / "frame.jpg", FRAME_W_PX, FRAME_H_PX)
    frames = []
    for k, (row, col) in enumerate([(20, 20), (20, 21)]):
        at = cell_center(grid, _idx(grid, row, col))
        pose = Pose(lat=at.lat, lon=at.lon, alt_agl_m=None, heading_deg=0.0, gsd_m=0.02)
        candidates = ((at.lat, at.lon, 10.0),) if k == 1 else ()
        frames.append(
            MapFrame(
                id=f"f{k + 1:04d}",
                image_path=image,
                pose=pose,
                footprint=lanes.footprint(pose),
                flight_index=k,
                candidates=candidates,
            )
        )
    map_file, cells = lanes.build_map(frames, DEMO_LKP, RECALL, "placeholder")
    assert "build_map" not in lanes.placeholder_notes()
    assert "build_map" not in lanes.unavailable
    assert [s.frame_id for s in map_file.steps] == ["f0001", "f0002"]
    assert map_file.params.recall_source == "placeholder"
    assert set(cells) == {"f0001", "f0002"}
    assert all(cells[fid] for fid in cells)
    held = _idx(grid, 20, 21)
    assert all(held not in dict(s.cells) for s in map_file.steps)
