"""Export the detector to an ONNX with a variable input size, for OpenCV 5 cv2.dnn.

    uv run --extra ml python scripts/export_onnx.py \
        [--pt data/weights/release_v2/yolo11s_tiles_run1_best.pt] [--out <pt stem>-dynamic.onnx]

Same weights, imgsz 1024, opset 17 as release ``model-onnx-v2``, plus ``dynamic=True``: then
``CvDetector`` can pad an input only to a multiple of 32, as ``YOLO.predict`` does, and a
1000×750 demo frame runs as 1024×768 instead of on a grey 1024×1024 square. On full 1024 px
slices both exports give the same boxes. ``make_detector`` prefers ``<stem>-dynamic.onnx`` next
to the weights. Needs the ``ml`` extra.
"""

from __future__ import annotations

import argparse
import shutil
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--pt", type=Path, default=ROOT / "data/weights/release_v2/yolo11s_tiles_run1_best.pt"
    )
    ap.add_argument("--out", type=Path, default=None, help="default: <pt stem>-dynamic.onnx")
    args = ap.parse_args(argv)
    out = args.out or args.pt.with_name(f"{args.pt.stem}-dynamic.onnx")

    from ultralytics import YOLO

    # Export from a copy: Ultralytics writes <stem>.onnx next to the .pt, which would replace the
    # fixed-size export already there.
    with tempfile.TemporaryDirectory() as tmp:
        pt = Path(tmp) / args.pt.name
        shutil.copy2(args.pt, pt)
        exported = YOLO(str(pt)).export(
            format="onnx", imgsz=1024, opset=17, dynamic=True, simplify=True
        )
        shutil.move(exported, out)
    print(f"export_onnx: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
