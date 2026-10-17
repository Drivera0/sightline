"""Tests 2 and 3 (LANE_D section 7): cut_frames and build_survey, plus write_survey."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import pytest
from PIL import Image

from sightline.pipeline.survey import FrameCandidate, build_survey, cut_frames, write_survey


# Stand-ins with the same shape as lane A's sightline.ml.types (Box, LabeledImage): survey.py only
# relies on that shape, so these keep the tests independent of lane A's branch.
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


def photo(name: str, boxes: list[Box], width: int = 4000, height: int = 3000) -> LabeledImage:
    return LabeledImage(Path(f"/data/test/{name}"), width, height, boxes)


def by_label(cut, label):
    return [(c, boxes) for c, lab, boxes in cut if lab == label]


# ---------------------------------------------------------------- test 2: cut_frames


def test_cut_frames_splits_a_4000x3000_photo_into_a_4x4_grid():
    cut = cut_frames([photo("a.jpg", [])])

    assert len(cut) == 16
    assert {(c.x0, c.y0) for c, _, _ in cut} == {
        (x, y) for x in range(0, 4000, 1000) for y in range(0, 3000, 750)
    }
    assert all((c.w, c.h) == (1000, 750) and c.source_image == "a.jpg" for c, _, _ in cut)


def test_cut_frames_splits_a_4000x2250_photo_into_a_4x3_grid():
    assert len(cut_frames([photo("wide.jpg", [], height=2250)])) == 12


def test_box_fully_inside_one_frame_makes_it_positive_and_the_rest_negative():
    inside = Box(2100, 900, 2160, 960)  # frame row 1, col 2: x 2000-3000, y 750-1500
    crossing = Box(990, 100, 1010, 140)  # straddles the col 0 / col 1 edge of row 0

    cut = cut_frames([photo("a.jpg", [inside, crossing])])

    positives = by_label(cut, "positive")
    ambiguous = by_label(cut, "ambiguous")
    assert [(c.x0, c.y0) for c, _ in positives] == [(2000, 750)]
    assert sorted((c.x0, c.y0) for c, _ in ambiguous) == [(0, 0), (1000, 0)]
    assert len(by_label(cut, "negative")) == 13


def test_positive_frame_reports_its_boxes_in_frame_coordinates():
    cut = cut_frames([photo("a.jpg", [Box(2100, 900, 2160, 960)])])

    [(_, boxes)] = by_label(cut, "positive")

    assert boxes == [Box(100, 150, 160, 210)]


def test_negative_frames_have_no_boxes():
    cut = cut_frames([photo("a.jpg", [Box(2100, 900, 2160, 960)])])

    assert all(boxes == [] for _, boxes in by_label(cut, "negative"))


def test_frame_with_a_whole_person_and_a_cut_person_is_ambiguous():
    whole = Box(100, 100, 150, 160)
    cut_in_half = Box(970, 300, 1030, 360)

    cut = cut_frames([photo("a.jpg", [whole, cut_in_half])])

    assert by_label(cut, "positive") == []
    assert {(c.x0, c.y0) for c, _ in by_label(cut, "ambiguous")} == {(0, 0), (1000, 0)}


def test_box_touching_the_frame_edge_from_inside_is_still_inside():
    flush = Box(940, 690, 1000, 750)  # ends exactly on the right/bottom edge of frame (0, 0)

    cut = cut_frames([photo("a.jpg", [flush])])

    assert [(c.x0, c.y0) for c, _ in by_label(cut, "positive")] == [(0, 0)]
    assert by_label(cut, "ambiguous") == []


def test_box_that_only_borders_a_frame_does_not_touch_it():
    box = Box(1000, 0, 1060, 60)  # starts exactly where frame (0, 0) ends

    cut = cut_frames([photo("a.jpg", [box])])

    assert [(c.x0, c.y0) for c, _ in by_label(cut, "positive")] == [(1000, 0)]
    assert by_label(cut, "ambiguous") == []


def test_frame_candidates_are_hashable_values():
    a = FrameCandidate("a.jpg", 0, 0, 1000, 750)
    assert {a, FrameCandidate("a.jpg", 0, 0, 1000, 750)} == {a}


# ---------------------------------------------------------------- test 3: build_survey


def survey_photos(n_images: int = 40) -> list[LabeledImage]:
    """n_images photos, each with one person in a different frame (frame index i % 16)."""
    images = []
    for i in range(n_images):
        col, row = (i % 16) % 4, (i % 16) // 4
        x, y = col * 1000 + 300, row * 750 + 200
        images.append(photo(f"test_{i:03d}.jpg", [Box(x, y, x + 50, y + 60)]))
    return images


def test_survey_has_exactly_500_frames_and_6_positives():
    frames, truth = build_survey(survey_photos())

    assert len(frames) == 500
    assert sum(1 for boxes in truth.values() if boxes) == 6


def test_frame_ids_are_unique_and_numbered_in_flight_order():
    frames, _ = build_survey(survey_photos())

    assert [f.id for f in frames] == [f"f{i:04d}" for i in range(1, 501)]
    assert [f.flight_index for f in frames] == list(range(500))


def test_same_seed_gives_identical_output():
    assert build_survey(survey_photos(), seed=7) == build_survey(survey_photos(), seed=7)


def test_output_does_not_depend_on_input_order():
    images = survey_photos()

    assert build_survey(images, seed=7) == build_survey(list(reversed(images)), seed=7)


def test_different_seed_gives_a_different_survey():
    frames_7, _ = build_survey(survey_photos(), seed=7)
    frames_8, _ = build_survey(survey_photos(), seed=8)

    assert [(f.source_image, f.x0, f.y0) for f in frames_7] != [
        (f.source_image, f.x0, f.y0) for f in frames_8
    ]


def test_positives_come_from_six_different_photos_when_possible():
    frames, truth = build_survey(survey_photos())

    positive_sources = [f.source_image for f in frames if truth[f.id]]

    assert len(set(positive_sources)) == 6


def test_positives_reuse_photos_only_when_there_are_too_few():
    two_people = [
        photo(f"t_{i}.jpg", [Box(300, 200, 350, 260), Box(2300, 1700, 2350, 1760)])
        for i in range(4)
    ]

    frames, truth = build_survey(two_people, n_frames=40, n_positive=6)

    positive_sources = [f.source_image for f in frames if truth[f.id]]
    assert len(positive_sources) == 6 and len(set(positive_sources)) == 4


def test_truth_lists_every_frame_and_boxes_are_in_frame_coordinates():
    frames, truth = build_survey(survey_photos())

    assert set(truth) == {f.id for f in frames}
    for boxes in truth.values():
        assert all(0 <= b.x1 < b.x2 <= 1000 and 0 <= b.y1 < b.y2 <= 750 for b in boxes)


def test_positives_are_not_hand_placed_in_flight_order():
    positions = set()
    for seed in range(1, 6):
        frames, truth = build_survey(survey_photos(), seed=seed)
        positions.add(tuple(f.flight_index for f in frames if truth[f.id]))

    assert len(positions) == 5


def test_ambiguous_frames_are_never_in_the_survey():
    straddling = [photo(f"s_{i}.jpg", [Box(990, 100, 1010, 140)]) for i in range(5)]
    frames, _ = build_survey(survey_photos() + straddling)

    straddled = {(f"s_{i}.jpg", x0, 0) for i in range(5) for x0 in (0, 1000)}
    assert not straddled & {(f.source_image, f.x0, f.y0) for f in frames}


def test_not_enough_positive_frames_raises():
    with pytest.raises(ValueError, match="positive"):
        build_survey(survey_photos(n_images=3), n_frames=100, n_positive=6)


def test_not_enough_negative_frames_raises():
    with pytest.raises(ValueError, match="negative"):
        build_survey(survey_photos(n_images=1), n_frames=50, n_positive=1)


def test_frame_paths_point_into_the_survey_folder():
    frames, _ = build_survey(survey_photos(), survey_dir=Path("data/survey"))

    assert frames[0].path == Path("data/survey/frames/f0001.jpg")


# ---------------------------------------------------------------- write_survey


def test_write_survey_writes_jpegs_frames_json_and_truth_json(tmp_path):
    source = tmp_path / "raw" / "test_000.jpg"
    source.parent.mkdir()
    Image.new("RGB", (4000, 3000), (90, 120, 80)).save(source)
    image = LabeledImage(source, 4000, 3000, [Box(2100, 900, 2160, 960)])
    frames, truth = build_survey([image], n_frames=5, n_positive=1, survey_dir=tmp_path / "survey")

    write_survey(frames, truth, [image], tmp_path / "survey")

    assert all(Image.open(f.path).size == (1000, 750) for f in frames)
    listed = json.loads((tmp_path / "survey" / "frames.json").read_text())
    assert [f["id"] for f in listed] == [f.id for f in frames]
    saved_truth = json.loads((tmp_path / "survey" / "truth.json").read_text())
    assert saved_truth == {k: [[b.x1, b.y1, b.x2, b.y2] for b in v] for k, v in truth.items()}
