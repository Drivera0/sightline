"""Mine hard negatives from the training images and write the fine-tune dataset YAML (§6.5).

    python scripts/mine_hard_negatives.py --weights data/runs/tiles_s/weights/best.pt
    yolo detect train model=data/runs/tiles_s/weights/best.pt data=data/heridal/dataset_hn.yaml \
        imgsz=1024 epochs=20 lr0=0.002 batch=-1 seed=7 single_cls=True degrees=180 flipud=0.5 fliplr=0.5 \
        close_mosaic=5 project=data/runs name=tiles_s_hn

Needs the GPU. Tiled inference over 1,391 training images takes a while.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--weights", type=Path, required=True)
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--max-tiles", type=int, default=2000)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--data-root", type=Path, default=ROOT / "data/heridal/yolo_full")
    ap.add_argument("--tiles", type=Path, default=ROOT / "data/heridal/yolo_tiles")
    ap.add_argument("--out", type=Path, default=ROOT / "data/heridal/hard_negatives")
    ap.add_argument("--yaml", type=Path, default=ROOT / "data/heridal/dataset_hn.yaml")
    ap.add_argument("--device", default="cuda:0")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args(argv)

    from sightline.ml.data import load_split
    from sightline.ml.detect import Detector
    from sightline.ml.hard_negatives import mine, write_dataset_yaml

    train = load_split("train", args.data_root)[: args.limit]
    det = Detector(args.weights, device=args.device)
    written = mine(det, train, conf=args.conf, max_tiles=args.max_tiles, seed=args.seed, out_dir=args.out)
    write_dataset_yaml(args.tiles, args.out, args.yaml)
    n_empty = sum(1 for p in written if not (args.out / "labels" / f"{p.stem}.txt").read_text().strip())
    print(f"{len(written)} hard-negative tiles written to {args.out} ({n_empty} with no people); yaml: {args.yaml}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
