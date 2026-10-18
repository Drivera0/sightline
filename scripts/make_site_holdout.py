"""Build a site-held-out split from HERIDAL trainval (never touches test). Data prep, lane A.

    python scripts/make_site_holdout.py [--sites GOR RAK] [--src data/heridal/yolo_full] \
        [--out data/heridal/yolo_site]

Our normal val split is a random 10 % of trainval photos, so it shares all 13 training sites,
while the test split has four sites nobody trained on (docs/DETECTOR_LIMITS.md §5). This builds

    <out>/train    annotated train photos from every site except ``--sites``
    <out>/val      annotated val photos from every site except ``--sites`` (YOLO's checkpoint pick)
    <out>/holdout  every annotated train + val photo from ``--sites`` (model comparison)

Default held-out sites GOR and RAK: neither appears in the test split, and together they hold
331 people, about as many as the normal val split (333). Images are hard-linked, labels copied.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def site_of(stem: str) -> str:
    """``train_GOR_0012`` -> ``GOR``."""
    return stem.split("_")[1]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--sites", nargs="+", default=["GOR", "RAK"])
    ap.add_argument("--src", type=Path, default=ROOT / "data/heridal/yolo_full")
    ap.add_argument("--out", type=Path, default=ROOT / "data/heridal/yolo_site")
    args = ap.parse_args(argv)
    held = set(args.sites)

    report: dict[str, dict[str, int]] = {}
    for split in ("train", "val"):
        for jpg in sorted((args.src / split / "images").glob("*.jpg")):
            label = args.src / split / "labels" / f"{jpg.stem}.txt"
            text = label.read_text(encoding="utf-8")
            if not text.strip():
                continue  # empty annotation stub (see tile_dataset.py)
            dest = "holdout" if site_of(jpg.stem) in held else split
            (args.out / dest / "images").mkdir(parents=True, exist_ok=True)
            (args.out / dest / "labels").mkdir(parents=True, exist_ok=True)
            img_out = args.out / dest / "images" / jpg.name
            if not img_out.exists():
                try:
                    os.link(jpg, img_out)
                except OSError:
                    shutil.copy2(jpg, img_out)
            (args.out / dest / "labels" / label.name).write_text(text, encoding="utf-8")
            r = report.setdefault(dest, {"photos": 0, "people": 0})
            r["photos"] += 1
            r["people"] += len([ln for ln in text.splitlines() if ln.strip()])
    report_all = {"held_out_sites": sorted(held), "splits": report}
    (args.out / "site_split_report.json").write_text(
        json.dumps(report_all, indent=2), encoding="utf-8"
    )
    print(json.dumps(report_all, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
