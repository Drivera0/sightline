"""Retroactive val-only check of two earlier model choices (scripts/README.md, "Disclosure").

    python scripts/analysis/retro_val_check.py   # -> data/work/tune/retro_val.json

Run 1 vs run 2, and run 2 vs its hard-negative fine-tune, scored on the annotated val photos with
single-view tiled inference (how those choices were made), each at its own max-F2 threshold,
compared by a paired bootstrap over photos (2,000 resamples, seed 7). Never reads test.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

WEIGHTS = {
    "run1": "data/runs/tiles_s/weights/best.pt",
    "run2": "data/runs/tiles_s_v2/weights/best.pt",
    "run2_hn": "data/runs/tiles_s_v2_hn/weights/best.pt",
}


class _SingleView:
    def __init__(self, detector: object) -> None:
        self.detector = detector

    def detect_tiled(self, image: Path, conf: float = 0.05) -> list:
        return self.detector.detect_tiled(image, conf=conf, tta=("id",))  # type: ignore[attr-defined]


def main() -> int:
    from sightline.ml.data import load_split
    from sightline.ml.detect import Detector
    from sightline.ml.evaluate import choose_threshold_from_preds, predict_split, score_voc
    from sightline.ml.tuning import paired_bootstrap_f2, scores_at

    val = load_split("val", ROOT / "data/heridal/yolo_full", annotated_only=True)
    preds: dict[str, tuple[dict, float]] = {}
    out: dict[str, object] = {}
    truth: dict = {}
    for name, w in WEIGHTS.items():
        p, truth, _ = predict_split(_SingleView(Detector(ROOT / w)), val, "tiled")
        thr = choose_threshold_from_preds(p, truth)
        s = scores_at(p, truth, thr)
        out[name] = {
            "threshold": thr,
            "precision": s.precision,
            "recall": s.recall,
            "f2": s.f2,
            "ap50": score_voc(p, truth, thr).ap50,
        }
        preds[name] = (p, thr)
        print(name, out[name])
    for a, b in [("run1", "run2"), ("run2", "run2_hn")]:
        r = paired_bootstrap_f2(preds[a][0], preds[a][1], preds[b][0], preds[b][1], truth, 2000, 7)
        out[f"{b}_minus_{a}"] = {
            "delta_f2": r.delta,
            "ci95": [r.ci_low, r.ci_high],
            "p_better": r.p_b_better,
        }
        print(f"{b} - {a}", out[f"{b}_minus_{a}"])
    dest = ROOT / "data/work/tune/retro_val.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
