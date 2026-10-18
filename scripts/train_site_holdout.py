"""Train the run-2 recipe on a site-held-out tile set (docs/LANE_A_ML.md §6.3a).

    python scripts/train_site_holdout.py data/heridal/yolo_tiles_site_mask site_mask

Copies every training setting from run 2's ``data/runs/tiles_s_v2/args.yaml`` and changes only
the data, so the masked and unmasked tile sets can be compared with
``scripts/compare_on_holdout.py``. About 70 s per epoch on the RTX 4080 SUPER (80 epochs).
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KEYS = [
    "epochs", "patience", "batch", "imgsz", "workers", "seed", "deterministic", "single_cls",
    "close_mosaic", "amp", "lr0", "lrf", "momentum", "weight_decay", "warmup_epochs", "hsv_h",
    "hsv_s", "hsv_v", "degrees", "translate", "scale", "shear", "perspective", "flipud", "fliplr",
    "mosaic", "mixup", "optimizer", "cos_lr", "box", "cls", "dfl", "nbs", "auto_augment",
]  # fmt: skip


def main() -> int:
    import yaml
    from ultralytics import YOLO

    tiles, name = Path(sys.argv[1]), sys.argv[2]
    args = yaml.safe_load((ROOT / "data/runs/tiles_s_v2/args.yaml").read_text(encoding="utf-8"))
    YOLO(str(ROOT / "data/weights/yolo11s.pt")).train(
        data=str(tiles / "dataset.yaml"),
        project=str(ROOT / "data/runs"),
        name=name,
        exist_ok=True,
        plots=False,
        **{k: args[k] for k in KEYS},
    )
    return 0


if __name__ == "__main__":  # needed on Windows: dataloader workers re-import this module
    raise SystemExit(main())
