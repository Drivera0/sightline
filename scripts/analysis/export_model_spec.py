"""Export the detector's real layer table for the website's "Inside the detector" panel.

    python scripts/analysis/export_model_spec.py \
        [--weights data/weights/release_v2/yolo11s_tiles_run1_best.pt] \
        [--imgsz 1024] [--out web/src/metrics/detectorSpec.json]

Loads the weights with ultralytics, runs one dummy forward pass on a 1 x 3 x imgsz x imgsz input
(zeros: only the shapes matter), and records for every layer its index, type, the layers it reads
from, its parameter count and its output shape. Also records the totals, the strides, the class
names as stored in the weights, the training run's epochs / tile size / base model (from the
checkpoint's train_args), the input size and the weights file's sha256, so the panel can say exactly which file the
drawing describes. No numbers in the panel's architecture graph are typed by hand.

imgsz defaults to 1024 because sightline/ml/detect.py runs the detector at imgsz=1024.

Needs the ``ml`` extra (torch, ultralytics).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_WEIGHTS = ROOT / "data/weights/release_v2/yolo11s_tiles_run1_best.pt"
DEFAULT_OUT = ROOT / "web/src/metrics/detectorSpec.json"


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def shape_of(value: Any) -> list[int] | list[list[int]]:
    """Shape of a tensor without the batch dimension; for a tuple/list output, the first tensor's
    shape (Detect returns (predictions, raw maps) in eval mode)."""
    import torch

    if isinstance(value, torch.Tensor):
        return [int(s) for s in value.shape[1:]]
    if isinstance(value, (tuple, list)) and value:
        return shape_of(value[0])
    raise TypeError(f"unexpected layer output: {type(value)!r}")


def export_spec(weights: Path, imgsz: int) -> dict[str, Any]:
    import torch
    from ultralytics import YOLO

    yolo = YOLO(str(weights))
    model = yolo.model.float().eval()
    layers = list(model.model)
    outputs: dict[int, Any] = {}
    hooks = [
        layer.register_forward_hook(lambda _m, _inp, out, i=i: outputs.__setitem__(i, out))
        for i, layer in enumerate(layers)
    ]
    with torch.no_grad():
        model(torch.zeros(1, 3, imgsz, imgsz))
    for h in hooks:
        h.remove()

    rows = []
    for i, layer in enumerate(layers):
        frm = layer.f
        rows.append(
            {
                "index": i,
                "type": type(layer).__name__,
                "from": list(frm) if isinstance(frm, (list, tuple)) else int(frm),
                "params": int(sum(p.numel() for p in layer.parameters())),
                "out_shape": shape_of(outputs[i]),
            }
        )

    detect = layers[-1]
    strides = [int(s) for s in detect.stride.tolist()]
    names = model.names
    train_args = getattr(yolo, "ckpt", None) or {}
    train_args = train_args.get("train_args", {}) if isinstance(train_args, dict) else {}
    return {
        "source": "scripts/analysis/export_model_spec.py",
        "weights_file": weights.name,
        "weights_sha256": sha256_of(weights),
        "imgsz": imgsz,
        "nc": int(detect.nc),
        "names": [names[k] for k in sorted(names)],
        "strides": strides,
        "n_layers": len(layers),
        "total_params": int(sum(p.numel() for p in model.parameters())),
        "detect_from": list(detect.f),
        "train_epochs": train_args.get("epochs"),
        "train_imgsz": train_args.get("imgsz"),
        "train_base_model": train_args.get("model"),
        "layers": rows,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--weights", type=Path, default=DEFAULT_WEIGHTS)
    ap.add_argument("--imgsz", type=int, default=1024)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args(argv)

    if not args.weights.is_file():
        print(f"weights not found: {args.weights}", file=sys.stderr)
        return 1
    spec = export_spec(args.weights, args.imgsz)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(spec, indent=2) + "\n", encoding="utf-8")
    print(
        f"{spec['n_layers']} layers, {spec['total_params']:,} parameters, "
        f"strides {spec['strides']}, nc {spec['nc']} -> {args.out}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
