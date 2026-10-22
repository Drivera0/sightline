"""Where the frozen detector misses on LADD: a read-only breakdown of one ``eval_ladd.py`` run.

    uv run python scripts/analysis/ladd_breakdown.py runs/ladd/<ts> \
        [--data-root data/ladd/extracted] [--no-evidence]

Reads ``<run>/preds.jsonl`` (no detection is re-run) and scores it at the same frozen threshold
0.29 with the same one-to-one VOC matching as ``evaluate_model.py``, split by:

- person size, sqrt of box area, in the bins of ``detector_errors.py`` (HERIDAL test recall per
  bin is in docs/DETECTOR_LIMITS.md:72-75);
- photo size (a proxy for the camera);
- people per photo;
- snow cover, a proxy (LADD has no season tags): the share of pixels in a 1/8-scale decode with
  HSV value >= 180 and saturation <= 40; a photo with half or more such pixels counts as "snow";

plus recall with a loose box (IoU >= 0.1, one box per person), which separates "not seen" from
"seen but boxed differently from the label". Nothing here picks a threshold or a setting.
Writes ``<run>/breakdown.json`` and copies it to ``docs/evidence/ladd/<ts>/``.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
for p in (ROOT, ROOT / "scripts", ROOT / "scripts" / "analysis"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

from eval_ladd import _read_done, load_ladd
from reproduce_cv2 import THRESHOLD

from sightline.ml.tuning import scores_at
from sightline.ml.types import Box, RawDetection

SIZE_BINS_PX = [(0, 40), (40, 60), (60, 90), (90, 10_000)]  # as scripts/analysis/detector_errors.py
COUNT_BINS = [(1, 1), (2, 3), (4, 9), (10, 10_000)]
SNOW_V, SNOW_S, SNOW_SHARE = 180, 40, 0.5


def snow_share(path: Path) -> float:
    import cv2

    im = cv2.imread(str(path), cv2.IMREAD_REDUCED_COLOR_8)
    hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV)
    return float(((hsv[..., 2] >= SNOW_V) & (hsv[..., 1] <= SNOW_S)).mean())


def _bin(v: float, bins: list[tuple[int, int]], closed: bool = False) -> str:
    for lo, hi in bins:
        if (lo <= v <= hi) if closed else (lo <= v < hi):
            return f"{lo}-{hi}" if hi < 10_000 else f"{lo}+"
    return "?"


def recall_by(preds: dict, truth: dict, key) -> dict[str, dict[str, float]]:
    """Recall per group of true boxes; predictions stay whole, so each group's people are matched
    against every box the detector drew on their photo."""
    groups: dict[str, dict[str, list[Box]]] = defaultdict(lambda: defaultdict(list))
    for img, boxes in truth.items():
        for b in boxes:
            groups[key(img, b)][img].append(b)
    out = {}
    for g in sorted(groups):
        sub_truth = groups[g]
        sub_preds = {img: preds[img] for img in sub_truth}
        s = scores_at(sub_preds, sub_truth, THRESHOLD)
        out[g] = {"people": s.n_truth, "recall": round(s.recall, 3)}
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("run", type=Path)
    ap.add_argument("--data-root", type=Path, default=ROOT / "data/ladd/extracted")
    ap.add_argument("--no-evidence", action="store_true")
    args = ap.parse_args(argv)

    photos, which = load_ladd(args.data_root)
    done = _read_done(args.run / "preds.jsonl")
    preds = {
        p.name: [RawDetection(Box(*map(int, r[:4])), float(r[4])) for r in done[p.name]]
        for p in photos
    }
    truth = {p.name: list(p.boxes) for p in photos}
    size_of = {p.name: f"{p.width}x{p.height}" for p in photos}
    count_of = {p.name: len(p.boxes) for p in photos}
    snowy = {p.name: snow_share(p.path) >= SNOW_SHARE for p in photos}

    strict = scores_at(preds, truth, THRESHOLD)
    loose = scores_at(preds, truth, THRESHOLD, iou_threshold=0.1)
    result = {
        "run": args.run.name,
        "which": which,
        "threshold": THRESHOLD,
        "recall_voc_iou_0.5": round(strict.recall, 3),
        "recall_loose_iou_0.1": round(loose.recall, 3),
        "precision_loose_iou_0.1": round(loose.precision, 3),
        "by_person_size_sqrt_area_px": recall_by(
            preds, truth, lambda _i, b: _bin(b.area_px**0.5, SIZE_BINS_PX)
        ),
        "by_photo_size": recall_by(preds, truth, lambda i, _b: size_of[i]),
        "by_people_in_photo": recall_by(
            preds, truth, lambda i, _b: _bin(count_of[i], COUNT_BINS, closed=True)
        ),
        "by_snow_cover_proxy": recall_by(
            preds, truth, lambda i, _b: "snow" if snowy[i] else "no snow"
        ),
        "snow_photos": sum(snowy.values()),
        "heridal_test_recall_by_size": {"0-40": 0.88, "40-60": 0.83, "60-90": 0.92, "90+": 0.70},
    }
    text = json.dumps(result, indent=2) + "\n"
    (args.run / "breakdown.json").write_text(text, encoding="utf-8")
    print(text)
    if not args.no_evidence:
        ev = ROOT / "docs/evidence/ladd" / args.run.name
        ev.mkdir(parents=True, exist_ok=True)
        shutil.copy2(args.run / "breakdown.json", ev / "breakdown.json")
        print(f"copied to {ev}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
