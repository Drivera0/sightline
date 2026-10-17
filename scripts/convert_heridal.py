"""Convert HERIDAL (VOC XML, Zenodo 5662351) to YOLO txt. Data prep, lane A.

    python scripts/convert_heridal.py [--raw data/heridal/raw/heridal_keras_retinanet_voc]
                                      [--out data/heridal/yolo_full] [--val-frac 0.1] [--seed 7]

Output layout (docs/LANE_A_ML.md §4):

    data/heridal/yolo_full/{train,val,test}/images/<id>.jpg
    data/heridal/yolo_full/{train,val,test}/labels/<id>.txt      # "0 cx cy w h", normalised
    data/heridal/yolo_full/convert_report.json

Splits come from the official ``ImageSets/Main/{trainval,test}.txt``; val is a seeded 10 %
of trainval, split by image. The raw folder has a few extra XMLs/JPEGs that are not in those
lists; they are reported and ignored. Images are hard-linked when possible (no 8 GB copy),
otherwise copied. Pass ``--copy`` to force copies.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:  # until the package is installed with uv
    sys.path.insert(0, str(ROOT))


SPLITS = ("train", "val", "test")


def read_ids(list_file: Path) -> list[str]:
    return [ln.strip() for ln in list_file.read_text(encoding="utf-8").splitlines() if ln.strip()]


def place_image(src: Path, dst: Path, copy: bool) -> str:
    """Hard-link ``src`` at ``dst`` (same volume, instant) or copy. Returns the method used."""
    if dst.exists():
        dst.unlink()
    if not copy:
        try:
            os.link(src, dst)
            return "link"
        except OSError:
            pass
    shutil.copy2(src, dst)
    return "copy"


def convert_split(
    name: str, ids: list[str], raw: Path, out: Path, copy: bool
) -> tuple[dict[str, object], list[str]]:
    from sightline.ml.types import LabeledImage
    from sightline.ml.voc import clip_box, image_size, parse_voc, yolo_lines

    images_dir, labels_dir = out / name / "images", out / name / "labels"
    images_dir.mkdir(parents=True, exist_ok=True)
    labels_dir.mkdir(parents=True, exist_ok=True)
    n_boxes = 0
    n_no_size = 0
    n_clipped = 0
    missing: list[str] = []
    methods: set[str] = set()
    for i, image_id in enumerate(ids, 1):
        xml = raw / "Annotations" / f"{image_id}.xml"
        jpg = raw / "JPEGImages" / f"{image_id}.jpg"
        if not xml.exists() or not jpg.exists():
            missing.append(image_id)
            continue
        width, height, raw_boxes = parse_voc(xml.read_text(encoding="utf-8"))
        if width is None or height is None:
            n_no_size += 1
            width, height = image_size(jpg)
        boxes = [c for b in raw_boxes if (c := clip_box(b, width, height)) is not None]
        n_clipped += sum(1 for b in raw_boxes if clip_box(b, width, height) != b)
        labeled = LabeledImage(path=jpg, width=width, height=height, boxes=boxes)
        n_boxes += len(boxes)
        (labels_dir / f"{image_id}.txt").write_text(
            "\n".join(yolo_lines(labeled)) + "\n", encoding="utf-8"
        )
        methods.add(place_image(jpg, images_dir / f"{image_id}.jpg", copy))
        if i % 200 == 0 or i == len(ids):
            print(f"  {name}: {i}/{len(ids)}", flush=True)
    summary: dict[str, object] = {
        "images": len(ids) - len(missing),
        "boxes": n_boxes,
        "xml_without_size": n_no_size,
        "boxes_clipped_to_image": n_clipped,
        "missing_files": missing,
        "image_placement": sorted(methods),
    }
    return summary, ids


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--raw", type=Path, default=ROOT / "data/heridal/raw/heridal_keras_retinanet_voc"
    )
    ap.add_argument("--out", type=Path, default=ROOT / "data/heridal/yolo_full")
    ap.add_argument("--val-frac", type=float, default=0.1)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--copy", action="store_true", help="copy images instead of hard-linking")
    args = ap.parse_args(argv)

    from sightline.ml.voc import split_train_val

    raw: Path = args.raw
    sets = raw / "ImageSets" / "Main"
    if not sets.exists():
        print(
            f"error: {sets} not found. Unzip heridal_keras_retinanet_voc.zip under {raw.parent}",
            file=sys.stderr,
        )
        return 2

    t0 = time.time()
    trainval_ids = read_ids(sets / "trainval.txt")
    test_ids = read_ids(sets / "test.txt")
    train_ids, val_ids = split_train_val(trainval_ids, args.val_frac, args.seed)

    # Acceptance: no image may be in two splits.
    assert set(train_ids).isdisjoint(val_ids), "train/val overlap"
    assert set(train_ids + val_ids).isdisjoint(test_ids), "train+val/test overlap"

    # Files on disk that the official lists don't mention (raw zip has a few).
    xml_ids = {p.stem for p in (raw / "Annotations").glob("*.xml")}
    jpg_ids = {p.stem for p in (raw / "JPEGImages").glob("*.jpg")}
    listed = set(trainval_ids) | set(test_ids)
    extras = {
        "xml_not_in_lists": sorted(xml_ids - listed),
        "jpg_not_in_lists": sorted(jpg_ids - listed),
        "listed_without_xml": sorted(listed - xml_ids),
        "listed_without_jpg": sorted(listed - jpg_ids),
    }

    report: dict[str, object] = {
        "source": str(raw),
        "seed": args.seed,
        "val_frac": args.val_frac,
        "official_counts": {"trainval": len(trainval_ids), "test": len(test_ids)},
        "expected_from_docs": {
            "train_images": 1546,
            "test_images": 101,
            "train_boxes": 2892,
            "test_boxes": 337,
        },
        "raw_folder_extras": extras,
        "splits": {},
    }
    for name, ids in (("train", train_ids), ("val", val_ids), ("test", test_ids)):
        print(f"{name}: {len(ids)} images")
        summary, _ = convert_split(name, ids, raw, args.out, args.copy)
        report["splits"][name] = summary  # type: ignore[index]

    splits = report["splits"]
    assert isinstance(splits, dict)
    report["totals"] = {
        "trainval_boxes": splits["train"]["boxes"] + splits["val"]["boxes"],
        "test_boxes": splits["test"]["boxes"],
    }
    report["seconds"] = round(time.time() - t0, 1)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "convert_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
