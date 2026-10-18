"""Compare detectors on the site-held-out split (val-type data only; never reads test).

    python scripts/compare_on_holdout.py --model run2=data/runs/tiles_s_v2/weights/best.pt \
        --model new=data/runs/site_mask/weights/best.pt [--baseline run2] \
        [--holdout data/heridal/yolo_site] [--out data/work/tune/holdout_compare.json]

Tiled inference with the default settings on every photo of ``<holdout>/holdout``; each model's
threshold is chosen there by max F2; every other model is compared with ``--baseline`` (and
with each other) by a paired bootstrap over photos (2,000 resamples, seed 7).
"""

from __future__ import annotations

import argparse
import itertools
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--model", action="append", required=True, help="name=weights.pt")
    ap.add_argument("--holdout", type=Path, default=ROOT / "data/heridal/yolo_site")
    ap.add_argument("--out", type=Path, default=ROOT / "data/work/tune/holdout_compare.json")
    ap.add_argument("--resamples", type=int, default=2000)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args(argv)

    from sightline.ml.data import load_split
    from sightline.ml.detect import Detector
    from sightline.ml.evaluate import choose_threshold_from_preds, predict_split, score_voc
    from sightline.ml.tuning import paired_bootstrap_f2, scores_at

    images = load_split("holdout", args.holdout)  # type: ignore[arg-type]
    print(f"holdout: {len(images)} photos, {sum(len(i.boxes) for i in images)} people")
    models = dict(m.split("=", 1) for m in args.model)
    preds: dict[str, tuple[dict, float]] = {}
    out: dict[str, object] = {"photos": len(images), "models": {}, "comparisons": {}}
    truth: dict = {}
    for name, weights in models.items():
        p, truth, spi = predict_split(Detector(Path(weights)), images, "tiled")
        thr = choose_threshold_from_preds(p, truth)
        s = scores_at(p, truth, thr)
        out["models"][name] = {  # type: ignore[index]
            "weights": weights,
            "threshold": thr,
            "precision": s.precision,
            "recall": s.recall,
            "f2": s.f2,
            "ap50": score_voc(p, truth, thr).ap50,
            "seconds_per_image": spi,
        }
        preds[name] = (p, thr)
        print(name, out["models"][name])  # type: ignore[index]
    for a, b in itertools.combinations(models, 2):
        r = paired_bootstrap_f2(
            preds[a][0], preds[a][1], preds[b][0], preds[b][1], truth, args.resamples, args.seed
        )
        out["comparisons"][f"{b} - {a}"] = {  # type: ignore[index]
            "delta_f2": r.delta,
            "ci95": [r.ci_low, r.ci_high],
            "p_better": r.p_b_better,
            "clearly_better": r.clearly_better,
            "clearly_worse": r.ci_high < 0,
        }
        print(f"{b} - {a}", out["comparisons"][f"{b} - {a}"])  # type: ignore[index]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
