"""run_survey and hard-negative mining with a fake detector (no GPU, no weights)."""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image

from sightline.ml.data import load_split
from sightline.ml.hard_negatives import false_positives, mine, tile_around, write_dataset_yaml
from sightline.ml.survey import run_survey
from sightline.ml.tiling import Tile
from sightline.ml.types import Box, LabeledImage, RawDetection
from sightline.ml.voc import yolo_line


class FakeDetector:
    """Returns canned detections per image stem."""

    def __init__(self, table: dict[str, list[RawDetection]]) -> None:
        self.table = table
        self.calls: list[tuple[str, float]] = []

    def detect_frame(self, image: Path, conf: float = 0.05) -> list[RawDetection]:
        self.calls.append((image.stem, conf))
        return [d for d in self.table.get(image.stem, []) if d.conf >= conf]

    def detect_tiled(
        self, image: Path, conf: float = 0.05, slice_px: int = 1024, overlap: float = 0.2
    ) -> list[RawDetection]:
        return self.detect_frame(image, conf)


def _frames(tmp_path: Path, n: int = 3) -> Path:
    d = tmp_path / "frames"
    d.mkdir()
    for i in range(1, n + 1):
        Image.new("RGB", (1000, 750), (30, 90, 30)).save(d / f"f{i:04d}.jpg")
    return d


def test_run_survey_writes_contract_shaped_files(tmp_path: Path) -> None:
    frames = _frames(tmp_path)
    fake = FakeDetector(
        {
            "f0001": [
                RawDetection(Box(10, 10, 60, 70), 0.2),
                RawDetection(Box(500, 300, 560, 360), 0.9),
            ],
            "f0003": [RawDetection(Box(1, 1, 30, 30), 0.07)],
        }
    )
    out = tmp_path / "detect"
    run_survey(frames, Path("w.pt"), out, candidate_threshold=0.5, model_name="fake", detector=fake)

    raw = json.loads((out / "detections_raw.json").read_text())
    assert raw["model"] == "fake"
    assert raw["save_threshold"] == 0.05 and raw["candidate_threshold"] == 0.5
    assert list(raw["frames"]) == ["f0001", "f0002", "f0003"]  # every frame, flight order
    assert raw["frames"]["f0002"] == []
    assert [d["conf"] for d in raw["frames"]["f0001"]] == [0.9, 0.2]  # descending
    assert raw["frames"]["f0001"][0]["box"] == [500, 300, 560, 360]

    # crops only for conf ≥ candidate_threshold, numbered by descending conf
    assert sorted(p.name for p in (out / "crops").glob("*.jpg")) == ["f0001-d01.jpg"]
    with Image.open(out / "crops" / "f0001-d01.jpg") as c:
        assert c.size == (256, 256)

    cfg = json.loads((out / "config.json").read_text())
    assert cfg == {
        "weights": "w.pt",
        "model": "fake",
        "candidate_threshold": 0.5,
        "save_threshold": 0.05,
    }
    assert all(conf == 0.05 for _, conf in fake.calls)


def test_false_positives_rule() -> None:
    truth = [Box(100, 100, 160, 160)]
    dets = [
        RawDetection(Box(100, 100, 160, 160), 0.9),  # TP
        RawDetection(Box(140, 140, 200, 200), 0.9),  # IoU 400/6800 ≈ 0.06 < 0.1 → FP
        RawDetection(Box(800, 800, 860, 860), 0.3),  # FP
        RawDetection(Box(900, 900, 960, 960), 0.2),  # below conf → ignored
    ]
    assert false_positives(dets, truth) == [Box(140, 140, 200, 200), Box(800, 800, 860, 860)]


def test_tile_around_clamps_to_image() -> None:
    assert tile_around(Box(2000, 1500, 2060, 1560), 4000, 3000) == Tile(1518, 1018, 2542, 2042)
    assert tile_around(Box(10, 10, 70, 70), 4000, 3000) == Tile(0, 0, 1024, 1024)
    assert tile_around(Box(3990, 2990, 4000, 3000), 4000, 3000) == Tile(2976, 1976, 4000, 3000)
    assert tile_around(Box(10, 10, 70, 70), 800, 600) == Tile(0, 0, 800, 600)


def test_mine_writes_tiles_with_true_labels_and_caps(tmp_path: Path) -> None:
    img = tmp_path / "train_X_0001.jpg"
    Image.new("RGB", (4000, 3000), (40, 60, 40)).save(img, quality=50)
    truth = [Box(1700, 1300, 1760, 1360)]
    train = [LabeledImage(img, 4000, 3000, truth)]
    fake = FakeDetector(
        {
            "train_X_0001": [
                RawDetection(Box(1700, 1300, 1760, 1360), 0.95),  # TP, not mined
                RawDetection(
                    Box(2000, 1500, 2060, 1560), 0.8
                ),  # FP near the person: tile includes the person label
                RawDetection(Box(300, 300, 360, 360), 0.5),  # FP far away: empty label
                RawDetection(Box(302, 301, 362, 361), 0.4),  # same tile → deduped
            ]
        }
    )
    out = tmp_path / "hn"
    written = mine(fake, train, conf=0.25, max_tiles=10, seed=7, out_dir=out)
    assert sorted(p.name for p in written) == [
        "train_X_0001_hn_0_0.jpg",
        "train_X_0001_hn_1518_1018.jpg",
    ]
    with Image.open(out / "images" / "train_X_0001_hn_1518_1018.jpg") as t:
        assert t.size == (1024, 1024)
    assert (out / "labels" / "train_X_0001_hn_0_0.txt").read_text() == ""
    expected = yolo_line(Box(1700 - 1518, 1300 - 1018, 1760 - 1518, 1360 - 1018), 1024, 1024)
    assert (out / "labels" / "train_X_0001_hn_1518_1018.txt").read_text().strip() == expected

    capped = mine(fake, train, conf=0.25, max_tiles=1, seed=7, out_dir=tmp_path / "hn1")
    assert len(capped) == 1

    yaml = tmp_path / "d.yaml"
    write_dataset_yaml(tmp_path / "tiles", out, yaml)
    assert "hn/images" in yaml.read_text() and "tiles/val/images" in yaml.read_text()


def test_load_split(tmp_path: Path) -> None:
    root = tmp_path / "yolo_full"
    (root / "val" / "images").mkdir(parents=True)
    (root / "val" / "labels").mkdir(parents=True)
    Image.new("RGB", (400, 300)).save(root / "val" / "images" / "b.jpg")
    Image.new("RGB", (400, 300)).save(root / "val" / "images" / "a.jpg")
    (root / "val" / "labels" / "a.txt").write_text(yolo_line(Box(10, 20, 50, 60), 400, 300) + "\n")
    items = load_split("val", root)
    assert [i.path.stem for i in items] == ["a", "b"]
    assert items[0].boxes == [Box(10, 20, 50, 60)] and items[0].width == 400
    assert items[1].boxes == []
