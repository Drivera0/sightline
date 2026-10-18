"""Train the run-2 recipe on whole photos instead of tiles: the fair trained no-tiling baseline.

    python scripts/train_whole_photos.py [--imgsz 1920] [--name whole_s_1920] [--workers 4]

Uses the same training photos as run 2 (the 890 *annotated* train photos; val = the 95 annotated
val photos), copies every training setting from ``data/runs/tiles_s_v2/args.yaml`` and changes
only the input: each whole 4000x3000 photo, pre-resized on disk so its long side is ``imgsz``
(1920 px: a person about 50 px tall becomes about 24 px), trained at ``imgsz``. YOLO labels are
normalised, so they are copied unchanged. Pre-resizing only saves decoding a 12 MP JPEG every
step; training sees the same pixels as letting ultralytics resize. Score the result with
``scripts/evaluate_no_tiling.py --row whole=data/runs/<name>/weights/best.pt@<imgsz>``.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

KEYS = [
    "epochs", "patience", "seed", "deterministic", "single_cls",
    "close_mosaic", "amp", "lr0", "lrf", "momentum", "weight_decay", "warmup_epochs", "hsv_h",
    "hsv_s", "hsv_v", "degrees", "translate", "scale", "shear", "perspective", "flipud", "fliplr",
    "mosaic", "mixup", "optimizer", "cos_lr", "box", "cls", "dfl", "nbs", "auto_augment",
]  # fmt: skip


def build_dataset(src: Path, dst: Path, long_side: int) -> int:
    """Annotated train/val photos resized to ``long_side``, labels copied. Returns photo count."""
    from PIL import Image

    from sightline.ml.data import load_split

    n = 0
    for split in ("train", "val"):
        (dst / split / "images").mkdir(parents=True, exist_ok=True)
        (dst / split / "labels").mkdir(parents=True, exist_ok=True)
        for im in load_split(split, src, annotated_only=True):  # type: ignore[arg-type]
            out = dst / split / "images" / im.path.name
            if not out.exists():
                with Image.open(im.path) as photo:
                    scale = long_side / max(photo.size)
                    size = (round(photo.width * scale), round(photo.height * scale))
                    photo.convert("RGB").resize(size, Image.Resampling.LANCZOS).save(
                        out, quality=95
                    )
            label = src / split / "labels" / f"{im.path.stem}.txt"
            shutil.copyfile(label, dst / split / "labels" / label.name)
            n += 1
    (dst / "dataset.yaml").write_text(
        f"# Whole HERIDAL photos resized to {long_side} px (scripts/train_whole_photos.py)\n"
        f"path: {dst.as_posix()}\ntrain: train/images\nval: val/images\nnames:\n  0: person\n",
        encoding="utf-8",
    )
    return n


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--imgsz", type=int, default=1920)
    ap.add_argument("--name", default=None)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--epochs", type=int, default=None, help="default: run 2's (80)")
    ap.add_argument(
        "--patience", type=int, default=None, help="default: run 2's (15); 0 = all epochs"
    )
    ap.add_argument(
        "--batch",
        type=int,
        default=3,
        help="run 2 let AutoBatch pick (9 at 1024 px, 8.7 GB); its probe runs out of memory at "
        "1920 px on a 16 GB card, so the batch is fixed. Gradients still accumulate to nbs=64.",
    )
    args = ap.parse_args()

    import yaml
    from ultralytics import YOLO

    data = ROOT / f"data/heridal/yolo_whole_{args.imgsz}"
    n = build_dataset(ROOT / "data/heridal/yolo_full", data, args.imgsz)
    print(f"{n} annotated photos in {data}")
    run2 = yaml.safe_load((ROOT / "data/runs/tiles_s_v2/args.yaml").read_text(encoding="utf-8"))
    settings = {k: run2[k] for k in KEYS}
    settings["batch"] = args.batch
    if args.patience is not None:
        settings["patience"] = args.patience
    if args.epochs is not None:
        settings["epochs"] = args.epochs
    YOLO(str(ROOT / "data/weights/yolo11s.pt")).train(
        data=str(data / "dataset.yaml"),
        imgsz=args.imgsz,
        workers=args.workers,
        project=str(ROOT / "data/runs"),
        name=args.name or f"whole_s_{args.imgsz}",
        exist_ok=True,
        plots=False,
        **settings,
    )
    return 0


if __name__ == "__main__":  # needed on Windows: dataloader workers re-import this module
    raise SystemExit(main())
