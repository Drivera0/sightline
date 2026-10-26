"""How far apart two OpenCV builds' imgproc outputs are, on one real photo.

    # once per build, same photo (scripts/cool_bench.sh's environments):
    python scripts/cool_pixel_diff.py dump --photo <jpg> --out runs/cool/ops-cool.npz
    python scripts/cool_pixel_diff.py dump --photo <jpg> --out runs/cool/ops-pip.npz
    python scripts/cool_pixel_diff.py diff runs/cool/ops-pip.npz runs/cool/ops-cool.npz

``cool_imgproc_bench.py`` hashes each output; this saves them and prints, per operation, the
largest absolute difference and the share of values that differ.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT, ROOT / "scripts"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("dump")
    d.add_argument("--photo", type=Path, required=True)
    d.add_argument("--out", type=Path, required=True)
    c = sub.add_parser("diff")
    c.add_argument("a", type=Path)
    c.add_argument("b", type=Path)
    args = ap.parse_args(argv)

    import numpy as np

    if args.cmd == "dump":
        import cv2
        from cool_imgproc_bench import _ops

        bgr = cv2.imread(str(args.photo), cv2.IMREAD_COLOR)
        outs = {name: np.asarray(fn()) for name, fn in _ops(cv2, np, bgr).items()}
        args.out.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(args.out, imread=bgr, **outs)
        print(f"{cv2.__version__}: wrote {args.out}")
        return 0

    a, b = np.load(args.a), np.load(args.b)
    for name in a.files:
        x, y = a[name].astype(np.float64), b[name].astype(np.float64)
        if x.shape != y.shape:
            print(f"{name:26s} shapes differ {x.shape} {y.shape}")
            continue
        diff = np.abs(x - y)
        print(
            f"{name:26s} max |diff| {diff.max():.6g}, values that differ "
            f"{100 * np.count_nonzero(diff) / diff.size:.3f} %"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
