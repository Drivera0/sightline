"""VOC XML → YOLO txt conversion (docs/LANE_A_ML.md §4, §7)."""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

from sightline.ml.types import Box
from sightline.ml.voc import (
    clip_box,
    parse_voc,
    read_voc,
    read_yolo_labels,
    split_train_val,
    yolo_line,
    yolo_line_to_box,
)

FIXTURES = Path(__file__).parent / "fixtures"


def test_parse_real_heridal_xml_objects_before_size() -> None:
    """HERIDAL XMLs put <object> before <size>; both must still parse."""
    width, height, boxes = parse_voc((FIXTURES / "train_BRS_0052.xml").read_text())
    assert (width, height) == (4000, 3000)
    assert boxes == [Box(2795, 122, 2843, 191), Box(2029, 1850, 2064, 1882)]


def test_parse_xml_without_size_returns_none_dims() -> None:
    xml = """<annotation><object><name>person</name>
    <bndbox><xmin>10</xmin><xmax>20</xmax><ymin>30</ymin><ymax>45</ymax></bndbox>
    </object></annotation>"""
    width, height, boxes = parse_voc(xml)
    assert width is None and height is None
    assert boxes == [Box(10, 30, 20, 45)]


def test_parse_ignores_non_person_objects() -> None:
    xml = """<annotation><size><width>100</width><height>50</height></size>
    <object><name>rock</name><bndbox><xmin>1</xmin><xmax>2</xmax><ymin>1</ymin><ymax>2</ymax></bndbox></object>
    <object><name>person</name><bndbox><xmin>5</xmin><xmax>9</xmax><ymin>5</ymin><ymax>9</ymax></bndbox></object>
    </annotation>"""
    assert parse_voc(xml)[2] == [Box(5, 5, 9, 9)]


def test_yolo_line_exact() -> None:
    # cx = (2795+2843)/2/4000, cy = (122+191)/2/3000, w = 48/4000, h = 69/3000
    assert yolo_line(Box(2795, 122, 2843, 191), 4000, 3000) == "0 0.704750 0.052167 0.012000 0.023000"


def test_yolo_line_round_trips_to_box() -> None:
    box = Box(2795, 122, 2843, 191)
    line = yolo_line(box, 4000, 3000)
    assert yolo_line_to_box(line, 4000, 3000) == box


def test_clip_box_to_image() -> None:
    assert clip_box(Box(-5, 10, 20, 30), 100, 100) == Box(0, 10, 20, 30)
    assert clip_box(Box(90, 90, 120, 130), 100, 100) == Box(90, 90, 100, 100)
    assert clip_box(Box(100, 0, 120, 10), 100, 100) is None  # entirely outside


def test_read_voc_falls_back_to_image_size(tmp_path: Path) -> None:
    img = tmp_path / "a.jpg"
    Image.new("RGB", (640, 480)).save(img)
    xml = tmp_path / "a.xml"
    xml.write_text(
        "<annotation><object><name>person</name><bndbox>"
        "<xmin>10</xmin><xmax>20</xmax><ymin>30</ymin><ymax>45</ymax></bndbox></object></annotation>"
    )
    labeled = read_voc(xml, img)
    assert (labeled.width, labeled.height) == (640, 480)
    assert labeled.path == img
    assert labeled.boxes == [Box(10, 30, 20, 45)]


def test_read_voc_clips_out_of_range_boxes(tmp_path: Path) -> None:
    img = tmp_path / "a.jpg"
    Image.new("RGB", (100, 100)).save(img)
    xml = tmp_path / "a.xml"
    xml.write_text(
        "<annotation><size><width>100</width><height>100</height></size>"
        "<object><name>person</name><bndbox>"
        "<xmin>95</xmin><xmax>110</xmax><ymin>0</ymin><ymax>10</ymax></bndbox></object>"
        "<object><name>person</name><bndbox>"
        "<xmin>5</xmin><xmax>5</xmax><ymin>0</ymin><ymax>10</ymax></bndbox></object>"
        "</annotation>"
    )
    labeled = read_voc(xml, img)
    assert labeled.boxes == [Box(95, 0, 100, 10)]  # zero-width box dropped


def test_split_is_seeded_by_image_and_disjoint() -> None:
    ids = [f"train_X_{i:04d}" for i in range(100)]
    train, val = split_train_val(ids, val_frac=0.1, seed=7)
    assert len(val) == 10 and len(train) == 90
    assert set(train).isdisjoint(val)
    assert sorted(train + val) == ids
    assert split_train_val(list(reversed(ids)), val_frac=0.1, seed=7) == (train, val)
    assert split_train_val(ids, val_frac=0.1, seed=8) != (train, val)


def test_read_yolo_labels(tmp_path: Path) -> None:
    label = tmp_path / "a.txt"
    label.write_text("0 0.704750 0.052167 0.012000 0.023000\n\n0 0.5 0.5 0.1 0.1\n")
    boxes = read_yolo_labels(label, 4000, 3000)
    assert boxes == [Box(2795, 122, 2843, 191), Box(1800, 1350, 2200, 1650)]
    assert read_yolo_labels(tmp_path / "missing.txt", 10, 10) == []


def test_box_rejects_degenerate() -> None:
    with pytest.raises(ValueError):
        Box(5, 5, 5, 10)
