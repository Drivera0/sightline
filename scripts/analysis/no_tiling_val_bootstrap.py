"""Val-only paired bootstrap: run 2 tiled (the reported setting) vs no-tiling rows.

    python scripts/analysis/no_tiling_val_bootstrap.py [--whole data/runs/whole_s_1920/weights/best.pt@1920]

Each configuration at its own max-F2 threshold on the 95 annotated val photos; 2,000 paired
resamples over photos, seed 7 (``sightline.ml.tuning.paired_bootstrap_f2``). Never reads test.
Writes ``data/work/tune/no_tiling_val.json``.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--whole", default=None, help="whole-photo weights@imgsz")
    args = ap.parse_args()

    from sightline.ml.data import load_split
    from sightline.ml.detect import Detector
    from sightline.ml.evaluate import choose_threshold_from_preds, predict_split
    from sightline.ml.tuning import paired_bootstrap_f2, scores_at

    run2 = ROOT / "data/runs/tiles_s_v2/weights/best.pt"
    val = load_split("val", ROOT / "data/heridal/yolo_full", annotated_only=True)
    configs: list[tuple[str, Path, int, str]] = [
        ("run 2, tiled (reported)", run2, 1024, "tiled"),
        ("run 2, full-resolution photo (imgsz 4000)", run2, 4000, "resized"),
    ]
    if args.whole:
        w, sz = args.whole.rsplit("@", 1)
        configs.append((f"trained on whole photos (imgsz {sz})", Path(w), int(sz), "resized"))

    runs = {}
    for name, weights, imgsz, mode in configs:
        preds, truth, spi = predict_split(Detector(weights, imgsz=imgsz), val, mode)  # type: ignore[arg-type]
        thr = choose_threshold_from_preds(preds, truth)
        pt = scores_at(preds, truth, thr)
        runs[name] = (preds, truth, thr)
        print(
            f"{name}: thr {thr:.2f} P {pt.precision:.3f} R {pt.recall:.3f} F2 {pt.f2:.3f} {spi:.2f}s"
        )

    base = configs[0][0]
    bp, truth, bt = runs[base]
    out: dict[str, object] = {"baseline": base, "val_photos": len(val), "comparisons": {}}
    for name, (p, _, t) in runs.items():
        pt = scores_at(p, truth, t)
        entry: dict[str, object] = {
            "threshold": t,
            "precision": round(pt.precision, 3),
            "recall": round(pt.recall, 3),
            "f2": round(pt.f2, 3),
        }
        if name != base:
            b = paired_bootstrap_f2(bp, bt, p, t, truth)
            entry["delta_f2_vs_baseline"] = {
                k: round(v, 4) if isinstance(v, float) else v for k, v in b.__dict__.items()
            }
            print(f"{name} vs {base}: {entry['delta_f2_vs_baseline']}")
        out["comparisons"][name] = entry  # type: ignore[index]
    dst = ROOT / "data/work/tune/no_tiling_val.json"
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
