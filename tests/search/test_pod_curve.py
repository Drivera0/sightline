"""The measured POD size curve (docs/report/POD.md): lookup, clamps, fallback, and its use."""

from __future__ import annotations

import itertools
import json
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

from sightline.contract import LatLon, Pose
from sightline.search.live import RECALL, LiveMap
from sightline.search.pod import (
    DETECTION_FLOOR_PX,
    PERSON_WIDTH_M,
    POD_CURVE_PATH,
    TERRAIN_ENV,
    TERRAIN_FACTORS,
    FrameInput,
    PodCurve,
    frame_recall,
    load_pod_curve,
    person_px,
    terrain_factor,
)

LKP = LatLon(lat=49.37, lon=-122.945)
CURVE = PodCurve(((10.0, 0.2), (20.0, 0.6), (40.0, 0.8), (80.0, 0.9)))


def _frame(detector_gsd_m: float | None) -> FrameInput:
    return FrameInput(
        frame_id="f0001",
        pose=Pose(lat=LKP.lat, lon=LKP.lon, alt_agl_m=None, heading_deg=0.0, gsd_m=0.02),
        width_px=1000,
        height_px=750,
        image=Path("unused.jpg"),
        candidates=[],
        detector_gsd_m=detector_gsd_m,
    )


def test_lookup_interpolates_between_points() -> None:
    assert CURVE.recall_at(20.0) == pytest.approx(0.6)
    assert CURVE.recall_at(30.0) == pytest.approx(0.7)
    assert CURVE.recall_at(60.0) == pytest.approx(0.85)


def test_lookup_holds_above_and_falls_to_the_floor_below_the_measured_range() -> None:
    assert DETECTION_FLOOR_PX == 4.0
    assert CURVE.recall_at(500.0) == pytest.approx(0.9)  # held above the largest point
    # Below the smallest point (10 px, 0.2): linear to 0 at the 4 px floor, 0 under it.
    assert CURVE.recall_at(7.0) == pytest.approx(0.1)
    assert CURVE.recall_at(4.0) == 0.0
    assert CURVE.recall_at(3.0) == 0.0
    assert CURVE.recall_at(0.0) == 0.0
    assert CURVE.recall_at(10.0) == pytest.approx(0.2)


def test_lookup_without_a_floor_holds_the_first_value() -> None:
    held = PodCurve(CURVE.points, floor_px=None)
    assert held.recall_at(3.0) == pytest.approx(0.2)
    assert held.recall_at(0.0) == pytest.approx(0.2)


def test_lookup_is_monotone_in_size() -> None:
    values = [CURVE.recall_at(px) for px in np.linspace(0, 200, 401)]
    assert all(b >= a for a, b in itertools.pairwise(values))


@pytest.mark.parametrize(
    "points",
    [
        (),
        ((10.0, 0.5), (10.0, 0.6)),  # px not increasing
        ((10.0, 0.6), (20.0, 0.5)),  # recall falls with size
        ((10.0, 1.2),),  # not a probability
    ],
)
def test_bad_curves_are_refused(points) -> None:
    with pytest.raises(ValueError):
        PodCurve(points)


@pytest.mark.parametrize("floor_px", [10.0, 12.0, -1.0])
def test_a_floor_at_or_above_the_first_point_is_refused(floor_px: float) -> None:
    with pytest.raises(ValueError):
        PodCurve(CURVE.points, floor_px=floor_px)


def test_person_px() -> None:
    assert person_px(0.02) == pytest.approx(PERSON_WIDTH_M / 0.02)
    assert person_px(0.05, width_m=1.0) == pytest.approx(20.0)
    with pytest.raises(ValueError):
        person_px(0.0)


def test_frame_recall_uses_the_curve_at_the_detector_gsd() -> None:
    gsd = PERSON_WIDTH_M / 20.0  # a person spans 20 px
    assert frame_recall(_frame(gsd), RECALL, CURVE) == pytest.approx(0.6)


def test_frame_recall_falls_back_to_the_constant() -> None:
    assert frame_recall(_frame(None), RECALL, CURVE) == RECALL  # GSD unknown
    assert frame_recall(_frame(0.025), RECALL, None) == RECALL  # no curve
    assert frame_recall(_frame(0.025), RECALL, False) == RECALL


def test_missing_or_broken_curve_file_gives_none(tmp_path: Path) -> None:
    assert load_pod_curve(tmp_path / "absent.json") is None
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"points": [[10, 0.9], [20, 0.1]]}), encoding="utf-8")
    assert load_pod_curve(bad) is None
    assert frame_recall(_frame(0.025), RECALL, load_pod_curve(bad)) == RECALL


def test_shipped_curve_is_the_measured_one() -> None:
    curve = load_pod_curve(POD_CURVE_PATH)
    assert curve is not None
    doc = json.loads(POD_CURVE_PATH.read_text(encoding="utf-8"))
    assert doc["split"] == "val" and doc["threshold"] == 0.29
    assert curve.source.startswith("docs/evidence/pod/") and curve.source.endswith("/pod.json")
    evidence = json.loads(
        (Path(__file__).resolve().parents[2] / curve.source).read_text(encoding="utf-8")
    )
    assert [[p["px"], p["recall"]] for p in evidence["curve"]["points"]] == doc["points"]
    # Monotone (the constructor checks it) and below the whole-split recall for small people.
    px = [p for p, _ in curve.points]
    assert curve.recall_at(px[0]) < curve.recall_at(px[-1])
    # The low-n points are labelled in both files, with their n, and sit below the others.
    low = [p for p in evidence["curve"]["points"] if p.get("low_n")]
    assert [p["px"] for p in low] == doc["low_n_px"]
    assert low and all(p["people"] < evidence["curve"]["min_people_per_point"] for p in low)
    assert max(doc["low_n_px"]) < min(
        p["px"] for p in evidence["curve"]["points"] if not p.get("low_n")
    )
    assert doc["floor_px"] == curve.floor_px == DETECTION_FLOOR_PX
    assert curve.recall_at(DETECTION_FLOOR_PX) == 0.0


def test_person_width_is_the_measured_median_box_size() -> None:
    curve = load_pod_curve(POD_CURVE_PATH)
    assert curve is not None
    evidence = json.loads(
        (Path(__file__).resolve().parents[2] / curve.source).read_text(encoding="utf-8")
    )
    size = evidence["box_size_m"]
    assert size["boxes"] >= 100
    assert PERSON_WIDTH_M == pytest.approx(size["median_m"], abs=0.025)
    used = [r for r in evidence["sensitivity"] if r["used"]]
    assert {r["width_m"] for r in used} == {PERSON_WIDTH_M}
    for r in evidence["sensitivity"]:
        assert curve.recall_at(person_px(r["gsd_m"], r["width_m"])) == pytest.approx(
            r["recall"], abs=5e-4
        )


def test_live_map_discounts_a_photo_with_small_people() -> None:
    m = LiveMap.start(LKP)
    grey = np.full((750, 1000, 3), 128, np.uint8)
    curve = load_pod_curve()
    assert curve is not None
    far = replace(_frame(None), detector_gsd_m=0.05)  # 10 px per person
    unknown = _frame(None)
    near = m.frame_update(unknown, recall=RECALL, held=[], rgb=grey)
    small = m.frame_update(far, recall=RECALL, held=[], rgb=grey)
    ratio = curve.recall_at(person_px(0.05)) / RECALL
    assert ratio < 1
    before, after = dict(near.cells), dict(small.cells)
    assert after and set(after) <= set(before)
    for i, b in after.items():
        assert b == pytest.approx(min(0.95, before[i] * ratio), abs=2e-4)


# --- terrain ----------------------------------------------------------------------------------


def test_terrain_factor_defaults_to_heridal_and_reads_the_env(monkeypatch) -> None:
    monkeypatch.delenv(TERRAIN_ENV, raising=False)
    assert terrain_factor() == 1.0
    monkeypatch.setenv(TERRAIN_ENV, "snow")
    assert terrain_factor() == TERRAIN_FACTORS["snow"]
    assert terrain_factor("winter_other") == TERRAIN_FACTORS["winter_other"]  # explicit wins
    with pytest.raises(ValueError):
        terrain_factor("moon")


def test_terrain_scales_the_curve_and_the_constant(monkeypatch) -> None:
    monkeypatch.delenv(TERRAIN_ENV, raising=False)
    gsd = PERSON_WIDTH_M / 20.0
    snow = TERRAIN_FACTORS["snow"]
    assert frame_recall(_frame(gsd), RECALL, CURVE, terrain="snow") == pytest.approx(0.6 * snow)
    assert frame_recall(_frame(None), RECALL, CURVE, terrain="snow") == pytest.approx(RECALL * snow)


def test_terrain_factors_are_the_measured_ladd_over_heridal_val_recalls() -> None:
    root = Path(__file__).resolve().parents[2]
    ladd = json.loads(
        (root / "docs/evidence/ladd/20261022T174430Z/breakdown.json").read_text(encoding="utf-8")
    )
    curve = load_pod_curve(POD_CURVE_PATH)
    assert curve is not None
    pod = json.loads((root / curve.source).read_text(encoding="utf-8"))
    val = next(c for c in pod["conditions"] if c["name"] == "baseline")["recall"]
    snow = ladd["by_snow_cover_proxy"]
    assert TERRAIN_FACTORS["snow"] == pytest.approx(snow["snow"]["recall"] / val, abs=5e-4)
    assert TERRAIN_FACTORS["winter_other"] == pytest.approx(
        snow["no snow"]["recall"] / val, abs=5e-4
    )
    assert TERRAIN_FACTORS["heridal_like"] == 1.0


# --- the batch map (build_map) uses the same curve as the live map ----------------------------


def test_build_map_reads_the_curve_at_the_detector_gsd(tmp_path: Path, monkeypatch) -> None:
    from PIL import Image

    from sightline.search import build_map
    from sightline.search.grid import make_grid
    from sightline.search.prior import placeholder_prior

    monkeypatch.delenv(TERRAIN_ENV, raising=False)
    image = tmp_path / "grey.png"
    Image.fromarray(np.full((750, 1000, 3), 128, np.uint8)).save(image)
    grid = make_grid(LKP)
    prior = placeholder_prior(grid)
    curve = load_pod_curve()
    assert curve is not None
    gsd = 0.05  # 16 px per person: well below the constant
    maps = {
        k: build_map(grid, LKP, prior, [replace(_frame(g), image=image)], RECALL, "test")[0]
        for k, g in (("constant", None), ("curve", gsd))
    }
    ratio = curve.recall_at(person_px(gsd)) / RECALL
    assert ratio < 1
    before = dict(maps["constant"].steps[0].cells)
    after = dict(maps["curve"].steps[0].cells)
    assert before and set(after) <= set(before)
    for i, pod in after.items():
        assert pod == pytest.approx(min(0.95, before[i] * ratio), abs=2e-4)
