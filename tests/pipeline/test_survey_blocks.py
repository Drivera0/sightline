"""Block layout for the demo survey: neighbouring crops of the same photo sit next to each other on the
ground, so canopy (and the heatmap) is spatially coherent. Agreed with lane C: test images only,
positives placed at random, every photo's layout matches the ground on both flight directions."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import pytest

from sightline.pipeline.survey import BLOCK_LINES, build_block_survey, cut_frames

FPL = 25  # frames per flight line, as in lane B's 500-frame flight (20 lines x 25)


@dataclass(frozen=True)
class Box:
    x1: int
    y1: int
    x2: int
    y2: int

    def shifted(self, dx: int, dy: int) -> Box:
        return Box(self.x1 + dx, self.y1 + dy, self.x2 + dx, self.y2 + dy)


@dataclass(frozen=True)
class LabeledImage:
    path: Path
    width: int
    height: int
    boxes: list[Box]


def photos(n: int = 60) -> list[LabeledImage]:
    """4000x3000 test photos with one person fully inside row 0, column 1 (a "positive row"), and a
    second person crossing the row 3 / column 2-3 edge in every fifth photo (row 3 unusable)."""
    out = []
    for i in range(n):
        boxes = [Box(1400, 300, 1460, 360)]
        if i % 5 == 0:
            boxes.append(Box(2980, 2300, 3040, 2360))  # crosses x = 3000
        out.append(LabeledImage(Path(f"/data/test/test_{i:03d}.jpg"), 4000, 3000, boxes))
    return out


def ground(flight_index: int) -> tuple[int, int]:
    """(line, east position) of a flight index on an alternating 25-frame lawnmower path."""
    line, k = divmod(flight_index, FPL)
    return line, (k if line % 2 == 0 else FPL - 1 - k)


@pytest.fixture(scope="module")
def survey():
    return build_block_survey(photos(), n_frames=500, n_positive=6, seed=7)


def test_500_frames_in_flight_order_with_exactly_6_positives(survey):
    frames, truth = survey
    assert [f.id for f in frames] == [f"f{k:04d}" for k in range(1, 501)]
    assert [f.flight_index for f in frames] == list(range(500))
    positives = [k for k, boxes in truth.items() if boxes]
    assert len(positives) == 6
    for k in positives:
        assert all(0 <= b.x1 < b.x2 <= 1000 and 0 <= b.y1 < b.y2 <= 750 for b in truth[k])


def test_no_ambiguous_crop_is_used_and_negatives_touch_no_person(survey):
    frames, truth = survey
    labels = {(c.source_image, c.x0, c.y0): lab for c, lab, _ in cut_frames(photos())}
    for f in frames:
        label = labels[(f.source_image, f.x0, f.y0)]
        assert label != "ambiguous"
        assert (label == "positive") == bool(truth[f.id])


def test_each_crop_is_used_once(survey):
    frames, _ = survey
    keys = Counter((f.source_image, f.x0, f.y0) for f in frames)
    assert max(keys.values()) == 1


def test_photo_layout_matches_the_ground(survey):
    """South neighbour (next line, same band) = the crop to the right; east neighbour = the crop above."""
    frames, _ = survey
    at = {ground(f.flight_index): f for f in frames}
    south = east = same_south = same_east = 0
    for (line, pos), f in at.items():
        below = at.get((line + 1, pos))
        if below and line // BLOCK_LINES == (line + 1) // BLOCK_LINES:
            south += 1
            if below.source_image == f.source_image:
                same_south += 1
                assert (below.x0, below.y0) == (f.x0 + 1000, f.y0)
        right = at.get((line, pos + 1))
        if right:
            east += 1
            if right.source_image == f.source_image:
                same_east += 1
                assert (right.x0, right.y0) == (f.x0, f.y0 - 750)
    assert same_south == south  # a band is always one photo row wide: every across pair matches
    assert same_east / east > 0.5  # most along-track neighbours come from the same photo


def test_positives_are_placed_at_random(survey):
    frames, truth = survey
    other_frames, other_truth = build_block_survey(photos(), n_frames=500, n_positive=6, seed=8)
    where = {f.flight_index for f in frames if truth[f.id]}
    other = {f.flight_index for f in other_frames if other_truth[f.id]}
    assert where != other


def test_same_seed_same_survey_whatever_the_input_order(survey):
    again = build_block_survey(list(reversed(photos())), n_frames=500, n_positive=6, seed=7)
    assert [(f.source_image, f.x0, f.y0) for f in again[0]] == [
        (f.source_image, f.x0, f.y0) for f in survey[0]
    ]


def test_needs_whole_bands():
    with pytest.raises(ValueError, match="multiple of"):
        build_block_survey(photos(), n_frames=450, n_positive=6, seed=7)


def test_ground_mapping_agrees_with_lane_b_flight():
    """The (line, east position) mapping above is how lane B flies: lines go south, even lines east."""
    geo = pytest.importorskip("sightline.geo")
    poses = geo.simulate_flight(500).poses if hasattr(geo.simulate_flight(500), "poses") else None
    if poses is None:
        pytest.skip("lane B flight returns no poses")
    for k in range(0, 500, 7):
        line, pos = ground(k)
        if pos + 1 < FPL:
            east_k = (line * FPL + pos + 1) if line % 2 == 0 else (line * FPL + FPL - 2 - pos)
            assert poses[east_k].lon > poses[k].lon
        if line + 1 < 500 // FPL:
            south_k = (line + 1) * FPL + (pos if (line + 1) % 2 == 0 else FPL - 1 - pos)
            assert poses[south_k].lat < poses[k].lat


def test_layout_is_a_pipeline_setting_defaulting_to_the_shuffled_survey():
    from sightline.pipeline.stages import SURVEY_LAYOUTS, Context
    from sightline.pipeline.survey import build_survey

    assert Context().layout == "shuffle"
    assert SURVEY_LAYOUTS == {"shuffle": build_survey, "blocks": build_block_survey}


def test_cli_offers_the_layout_option_and_rejects_unknown_layouts():
    import re

    from typer.testing import CliRunner

    from sightline.pipeline.__main__ import app

    runner = CliRunner()
    # CI terminals force colour: Rich's escape codes can split "--layout", so compare plain text
    plain = lambda args: re.sub(
        r"\x1b\[[0-9;]*m", "", runner.invoke(app, args, env={"COLUMNS": "200"}).output
    )
    assert "--layout" in plain(["run", "--help"])
    assert "--layout" in plain(["frames", "--help"])
    assert runner.invoke(app, ["frames", "--layout", "spiral"]).exit_code != 0


def test_auto_layout_uses_blocks_when_the_frame_count_allows_it():
    from sightline.pipeline.stages import resolve_layout

    assert resolve_layout("auto", 500) == "blocks"
    assert resolve_layout("auto", 40) == "shuffle"  # small test surveys can't fill a 100-frame band
    assert (
        resolve_layout("blocks", 40) == "blocks"
    )  # explicit choice is kept (and fails loudly later)
    assert resolve_layout("shuffle", 500) == "shuffle"


def test_cli_defaults_to_auto():
    from typer.testing import CliRunner

    from sightline.pipeline.__main__ import app

    help_text = CliRunner().invoke(app, ["run", "--help"], env={"COLUMNS": "200"}).output
    assert "auto" in help_text and "[default: auto]" in help_text
