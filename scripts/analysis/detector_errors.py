"""Detector error analysis on the HERIDAL test split (Task 4: honest limits). Analysis only.

    python scripts/analysis/detector_errors.py \
        [--weights data/weights/release_v2/yolo11s_tiles_run1_best.pt] \
        [--metrics data/weights/release_v2/detector_metrics.json] \
        [--out data/work/analysis] [--figures docs/figures/limits]

Runs the final detector (weights-v2) with the same tiled inference and the same VOC matching as
``scripts/evaluate_model.py``, at the threshold recorded in the release's detector_metrics.json
(never chosen here: the test set is never used for tuning). Predictions are cached in
``<out>/preds.json``; delete it to re-run inference. Writes:

- ``<out>/limits.json``: every number quoted in docs/DETECTOR_LIMITS.md;
- ``<figures>/*.png``: threshold curve, recall by size / light / vegetation / site, galleries.

Two label sets are scored. "official" is the converted test split exactly as
``scripts/evaluate_model.py`` scores it (it reproduces the published metrics). "label_checked"
fixes one data bug found here: four MED photos are 4000x2250 JPEGs whose VOC files say
4000x3000, so the converter squashed their boxes to 0.75 of their height. For those photos the
raw VOC pixel coordinates are used as they are (they lie inside the real image). The breakdowns
use the label-checked set, so they describe the detector, not the bug.

HERIDAL's annotations carry no occlusion or lighting tags (every box is truncated=0,
difficult=0), so "shade" and "vegetation" are image measurements, documented as proxies:

- shade: mean luma of a ring around the box (2x its size) relative to the photo's median luma;
- vegetation: share of pixels inside the box with excess green 2G - R - B > 20 (0-255 scale).

Needs the ``ml`` extra (torch, ultralytics, sahi) for inference; the rest is numpy/PIL/matplotlib.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import numpy as np
from PIL import Image

from sightline.ml.data import load_split
from sightline.ml.evaluate import SAVE_THRESHOLD, VOC_IOU, iou, score_voc
from sightline.ml.types import Box, RawDetection

SIZE_BINS_PX = [(0, 40), (40, 60), (60, 90), (90, 10_000)]
SHADE_RATIO = 0.75
EXG_MIN = 20
VEG_SHARE = 0.35


@dataclass(frozen=True)
class Truth:
    image: str
    box: Box
    found: bool
    size_px: float
    shade_ratio: float
    veg_share: float


@dataclass(frozen=True)
class Alarm:
    image: str
    box: Box
    conf: float
    size_px: float
    shade_ratio: float


def site_of(image_id: str) -> str:
    """'test_BRS_0006' -> 'BRS'."""
    parts = image_id.split("_")
    return parts[1] if len(parts) >= 3 else image_id


def size_bin(size_px: float) -> str:
    for lo, hi in SIZE_BINS_PX:
        if lo <= size_px < hi:
            return f"{lo}-{hi}" if hi < 10_000 else f"{lo}+"
    return "?"


def match(
    preds: dict[str, list[RawDetection]], truth: dict[str, list[Box]], threshold: float
) -> tuple[dict[str, set[int]], list[tuple[str, RawDetection]]]:
    """Greedy one-to-one VOC matching, identical in order and rule to evaluate._voc_hits, but
    keeping which truth box each kept prediction took. Returns (found truth indices per image,
    unmatched predictions at or above ``threshold``)."""
    flat = [(d, img) for img, dets in preds.items() for d in dets]
    flat.sort(key=lambda t: (-t[0].conf, t[1], t[0].box.x1, t[0].box.y1, t[0].box.x2, t[0].box.y2))
    used: dict[str, set[int]] = {img: set() for img in truth}
    alarms: list[tuple[str, RawDetection]] = []
    for det, img in flat:
        best_iou, best_j = 0.0, -1
        for j, gt in enumerate(truth.get(img, [])):
            if j in used.setdefault(img, set()):
                continue
            v = iou(det.box, gt)
            if v > best_iou:
                best_iou, best_j = v, j
        if best_j >= 0 and best_iou >= VOC_IOU:
            used[img].add(best_j)
        elif det.conf >= threshold:
            alarms.append((img, det))
    return used, alarms


def found_at(
    preds: dict[str, list[RawDetection]], truth: dict[str, list[Box]], threshold: float
) -> dict[str, set[int]]:
    """Truth boxes matched by a prediction at or above ``threshold`` (score only that subset,
    which _voc_hits guarantees gives the same matching as slicing the full list)."""
    kept = {img: [d for d in dets if d.conf >= threshold] for img, dets in preds.items()}
    used, _ = match(kept, truth, threshold)
    return used


def checked_truth(
    images: list, truth: dict[str, list[Box]], raw_annotations: Path
) -> tuple[dict[str, list[Box]], dict[str, int]]:
    """Truth with the size bug undone: where the VOC <size> disagrees with the JPEG, use the raw
    VOC pixel boxes (clipped to the real image) instead of the converted, rescaled ones."""
    from sightline.ml.voc import parse_voc

    fixed = dict(truth)
    relabelled: dict[str, int] = {}
    for im in images:
        xml = raw_annotations / f"{im.path.stem}.xml"
        if not xml.exists():
            continue
        w, h, boxes = parse_voc(xml.read_text(encoding="utf-8"))
        if w is None or (w, h) == (im.width, im.height):
            continue
        fixed[im.path.stem] = [c for b in boxes if (c := b.clipped(0, 0, im.width, im.height))]
        relabelled[im.path.stem] = len(fixed[im.path.stem])
    return fixed, relabelled


def luma(rgb: np.ndarray) -> np.ndarray:
    return 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]


def box_measures(rgb: np.ndarray, median_luma: float, box: Box) -> tuple[float, float]:
    """(shade ratio of the surroundings, vegetation share inside the box)."""
    h, w = rgb.shape[:2]
    bw, bh = box.x2 - box.x1, box.y2 - box.y1
    x1, y1 = max(0, box.x1 - bw), max(0, box.y1 - bh)
    x2, y2 = min(w, box.x2 + bw), min(h, box.y2 + bh)
    outer = rgb[y1:y2, x1:x2].astype(np.float32)
    mask = np.ones(outer.shape[:2], dtype=bool)
    mask[box.y1 - y1 : box.y2 - y1, box.x1 - x1 : box.x2 - x1] = False
    ring = luma(outer)[mask]
    shade = float(ring.mean() / median_luma) if ring.size and median_luma > 0 else 1.0
    inner = rgb[box.y1 : box.y2, box.x1 : box.x2].astype(np.float32)
    exg = 2 * inner[..., 1] - inner[..., 0] - inner[..., 2]
    veg = float((exg > EXG_MIN).mean()) if exg.size else 0.0
    return shade, veg


def run_inference(weights: Path, images: list, cache: Path) -> dict[str, list[RawDetection]]:
    if cache.exists():
        raw = json.loads(cache.read_text())
        return {
            k: [RawDetection(box=Box(*d["box"]), conf=d["conf"]) for d in v] for k, v in raw.items()
        }
    from sightline.ml.detect import Detector

    det = Detector(weights)
    preds: dict[str, list[RawDetection]] = {}
    for i, im in enumerate(images, 1):
        preds[im.path.stem] = det.detect_tiled(im.path, conf=SAVE_THRESHOLD)
        print(
            f"  {i}/{len(images)} {im.path.stem}: {len(preds[im.path.stem])} detections", flush=True
        )
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(
        json.dumps(
            {
                k: [
                    {"box": [d.box.x1, d.box.y1, d.box.x2, d.box.y2], "conf": round(d.conf, 5)}
                    for d in v
                ]
                for k, v in preds.items()
            }
        )
    )
    return preds


def recall_table(rows: list[Truth], key) -> list[dict[str, object]]:
    groups: dict[str, list[Truth]] = defaultdict(list)
    for t in rows:
        groups[key(t)].append(t)
    out = []
    for name, items in groups.items():
        found = sum(t.found for t in items)
        out.append(
            {
                "group": name,
                "people": len(items),
                "found": found,
                "missed": len(items) - found,
                "recall": round(found / len(items), 3),
            }
        )
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--weights", type=Path, default=ROOT / "data/weights/release_v2/yolo11s_tiles_run1_best.pt"
    )
    ap.add_argument(
        "--metrics", type=Path, default=ROOT / "data/weights/release_v2/detector_metrics.json"
    )
    ap.add_argument("--data-root", type=Path, default=ROOT / "data/heridal/yolo_full")
    ap.add_argument(
        "--raw-annotations",
        type=Path,
        default=ROOT / "data/heridal/raw/heridal_keras_retinanet_voc/Annotations",
        help="original VOC XML, for the label check",
    )
    ap.add_argument("--out", type=Path, default=ROOT / "data/work/analysis")
    ap.add_argument("--figures", type=Path, default=ROOT / "docs/figures/limits")
    args = ap.parse_args(argv)

    recorded = json.loads(args.metrics.read_text())["detector"]
    threshold = float(recorded["threshold"])
    images = load_split("test", args.data_root)
    print(f"test {len(images)} images, threshold {threshold} (from {args.metrics.name})")
    preds = run_inference(args.weights, images, args.out / "preds.json")
    truth = {im.path.stem: list(im.boxes) for im in images}
    official_truth = truth

    official = score_voc(preds, truth, threshold)
    truth, relabelled = checked_truth(images, truth, args.raw_annotations)
    checked = score_voc(preds, truth, threshold)
    found = found_at(preds, truth, threshold)
    _, alarms_raw = match(preds, truth, threshold)
    n_truth = sum(len(v) for v in truth.values())
    n_found = sum(len(v) for v in found.values())
    assert abs(n_found / n_truth - checked.recall) < 1e-9, (n_found / n_truth, checked.recall)

    rows: list[Truth] = []
    alarms: list[Alarm] = []
    by_image_alarms: dict[str, list[RawDetection]] = defaultdict(list)
    for img, det in alarms_raw:
        by_image_alarms[img].append(det)
    for im in images:
        rgb = np.asarray(Image.open(im.path).convert("RGB"))
        med = float(np.median(luma(rgb[::8, ::8].astype(np.float32))))
        img = im.path.stem
        for j, b in enumerate(truth[img]):
            shade, veg = box_measures(rgb, med, b)
            rows.append(
                Truth(img, b, j in found.get(img, set()), float(np.sqrt(b.area_px)), shade, veg)
            )
        for d in by_image_alarms.get(img, []):
            shade, _ = box_measures(rgb, med, d.box)
            alarms.append(Alarm(img, d.box, d.conf, float(np.sqrt(d.box.area_px)), shade))

    missed = [t for t in rows if not t.found]
    curve = []
    for thr in [round(x, 2) for x in np.arange(0.05, 0.96, 0.01)]:
        s = score_voc(preds, truth, thr)
        o = score_voc(preds, official_truth, thr)
        curve.append(
            {
                "threshold": thr,
                "recall": round(s.recall, 4),
                "precision": round(s.precision, 4),
                "official_recall": round(o.recall, 4),
                "official_precision": round(o.precision, 4),
            }
        )

    def light(t: Truth) -> str:
        return "shade" if t.shade_ratio < SHADE_RATIO else "sun"

    def veg(t: Truth) -> str:
        return "in vegetation" if t.veg_share >= VEG_SHARE else "open ground"

    summary = {
        "weights": str(args.weights.relative_to(ROOT))
        if args.weights.is_relative_to(ROOT)
        else str(args.weights),
        "threshold": threshold,
        "test_images": len(images),
        "official": {
            "recall": round(official.recall, 3),
            "precision": round(official.precision, 3),
            "ap50": round(official.ap50, 3),
            "recorded_in_release": recorded["voc"],
        },
        "label_checked": {
            "relabelled_images": sorted(relabelled),
            "relabelled_boxes": sum(relabelled.values()),
            "recall": round(checked.recall, 3),
            "precision": round(checked.precision, 3),
            "ap50": round(checked.ap50, 3),
        },
        "people": n_truth,
        "found": n_found,
        "missed": len(missed),
        "false_alarms": len(alarms),
        "proxies": {
            "shade_ratio_below": SHADE_RATIO,
            "exg_min": EXG_MIN,
            "veg_share_at_least": VEG_SHARE,
        },
        "by_size_px": sorted(
            recall_table(rows, lambda t: size_bin(t.size_px)),
            key=lambda r: int(str(r["group"]).split("-")[0].rstrip("+")),
        ),
        "by_light": recall_table(rows, light),
        "by_vegetation": recall_table(rows, veg),
        "by_site": sorted(
            recall_table(rows, lambda t: site_of(t.image)), key=lambda r: -int(r["missed"])
        ),
        "missed_median_size_px": round(float(np.median([t.size_px for t in missed])), 1)
        if missed
        else None,
        "found_median_size_px": round(float(np.median([t.size_px for t in rows if t.found])), 1),
        "false_alarms_by_site": sorted(
            [
                {"group": k, "false_alarms": v}
                for k, v in _count(site_of(a.image) for a in alarms).items()
            ],
            key=lambda r: -r["false_alarms"],
        ),
        "false_alarms_by_size_px": [
            {"group": k, "false_alarms": v}
            for k, v in _count(size_bin(a.size_px) for a in alarms).items()
        ],
        "false_alarm_median_conf": round(float(np.median([a.conf for a in alarms])), 3)
        if alarms
        else None,
        "threshold_curve": curve,
    }
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "limits.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps({k: v for k, v in summary.items() if k != "threshold_curve"}, indent=2))

    figures(args.figures, summary, rows, alarms, images)
    return 0


def _count(items) -> dict[str, int]:
    out: dict[str, int] = defaultdict(int)
    for x in items:
        out[x] += 1
    return dict(out)


def figures(out: Path, s: dict, rows: list[Truth], alarms: list[Alarm], images: list) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    out.mkdir(parents=True, exist_ok=True)
    plt.rcParams.update({"font.size": 11, "axes.spines.top": False, "axes.spines.right": False})
    accent, grey = "#ff7a1a", "#8a8a93"

    # 1. Recall and precision against the threshold, ours marked.
    c = s["threshold_curve"]
    fig, ax = plt.subplots(figsize=(7.5, 4.8))
    ax.plot(
        [p["threshold"] for p in c], [p["recall"] for p in c], color=accent, lw=2.2, label="Recall"
    )
    ax.plot(
        [p["threshold"] for p in c],
        [p["official_recall"] for p in c],
        color=accent,
        lw=1.2,
        ls=":",
        label="Recall, published labels",
    )
    ax.plot(
        [p["threshold"] for p in c if p["recall"] > 0],
        [p["precision"] for p in c if p["recall"] > 0],
        color=grey,
        lw=2,
        label="Precision (undefined once nothing is kept)",
    )
    ax.axvline(s["threshold"], color="black", lw=1, ls="--")
    ax.annotate(
        f"our threshold {s['threshold']}\n"
        f"label-checked: recall {s['label_checked']['recall']:.3f}, "
        f"precision {s['label_checked']['precision']:.3f}\n"
        f"published: recall {s['official']['recall']:.3f}, "
        f"precision {s['official']['precision']:.3f}",
        (s["threshold"], s["label_checked"]["recall"]),
        xytext=(0.36, 0.2),
        fontsize=10,
        arrowprops={"arrowstyle": "-", "color": "black", "lw": 0.8},
    )
    ax.set(
        xlabel="Confidence threshold",
        ylabel="Score",
        ylim=(0, 1),
        xlim=(0.05, 0.95),
        title=f"HERIDAL test set, {s['test_images']} photos, {s['people']} people",
    )
    ax.legend(frameon=False, loc="upper center", bbox_to_anchor=(0.5, -0.16), ncol=3, fontsize=9)
    fig.tight_layout()
    fig.savefig(out / "threshold_curve.png", dpi=160)
    plt.close(fig)

    # 2. Recall by person size, light and vegetation, one panel each.
    fig, axes = plt.subplots(1, 3, figsize=(12, 3.8), gridspec_kw={"width_ratios": [4, 2, 2]})
    for ax, key, title in zip(
        axes,
        ["by_size_px", "by_light", "by_vegetation"],
        ["Person size (sqrt of box area, px)", "Surroundings (proxy)", "Inside the box (proxy)"],
    ):
        groups = s[key]
        ax.bar([g["group"] for g in groups], [g["recall"] for g in groups], color=accent, width=0.6)
        for i, g in enumerate(groups):
            ax.text(
                i,
                g["recall"] + 0.02,
                f"{g['recall']:.2f}\n{g['found']}/{g['people']}",
                ha="center",
                fontsize=9,
            )
        ax.set(ylim=(0, 1.15), title=title, ylabel="Recall" if key == "by_size_px" else None)
    fig.suptitle("Where the detector misses people", fontsize=12)
    fig.tight_layout()
    fig.savefig(out / "recall_by_kind.png", dpi=160)
    plt.close(fig)

    # 3. Misses per site.
    sites = sorted(s["by_site"], key=lambda r: r["group"])
    fig, ax = plt.subplots(figsize=(9, 3.6))
    xs = np.arange(len(sites))
    ax.bar(xs, [r["found"] for r in sites], color=accent, label="Found")
    ax.bar(
        xs,
        [r["missed"] for r in sites],
        bottom=[r["found"] for r in sites],
        color=grey,
        label="Missed",
    )
    ax.set_xticks(xs, [r["group"] for r in sites], rotation=45, ha="right")
    ax.set(ylabel="People", title="People found and missed, by HERIDAL site (file prefix)")
    ax.legend(frameon=False)
    fig.tight_layout()
    fig.savefig(out / "misses_by_site.png", dpi=160)
    plt.close(fig)

    # 4/5. Galleries: missed people (smallest first) and false alarms (most confident first).
    paths = {im.path.stem: im.path for im in images}
    missed = sorted([t for t in rows if not t.found], key=lambda t: t.size_px)
    gallery(
        out / "gallery_missed.jpg",
        [
            (
                t.image,
                t.box,
                (
                    f"{site_of(t.image)}  {t.size_px:.0f}px  "
                    f"{'shade' if t.shade_ratio < SHADE_RATIO else 'sun'}"
                ),
            )
            for t in missed[:40]
        ],
        paths,
        grey,
    )
    top_alarms = sorted(alarms, key=lambda a: -a.conf)
    gallery(
        out / "gallery_false_alarms.jpg",
        [(a.image, a.box, f"{site_of(a.image)}  conf {a.conf:.2f}") for a in top_alarms[:40]],
        paths,
        accent,
    )


def gallery(
    path: Path, items: list[tuple[str, Box, str]], paths: dict[str, Path], colour: str
) -> None:
    from PIL import ImageDraw

    tile, cols = 220, 8
    rows = max(1, (len(items) + cols - 1) // cols)
    sheet = Image.new("RGB", (cols * tile, rows * (tile + 22)), (16, 16, 18))
    draw = ImageDraw.Draw(sheet)
    rgb_colour = tuple(int(colour[i : i + 2], 16) for i in (1, 3, 5))
    cache: dict[str, Image.Image] = {}
    for k, (img, b, label) in enumerate(items):
        im = cache.setdefault(img, Image.open(paths[img]).convert("RGB"))
        cx, cy = (b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2
        r = max(b.x2 - b.x1, b.y2 - b.y1) * 1.8 + 20
        crop = im.crop((int(cx - r), int(cy - r), int(cx + r), int(cy + r))).resize((tile, tile))
        scale = tile / (2 * r)
        d = ImageDraw.Draw(crop)
        d.rectangle(
            [
                (b.x1 - (cx - r)) * scale,
                (b.y1 - (cy - r)) * scale,
                (b.x2 - (cx - r)) * scale,
                (b.y2 - (cy - r)) * scale,
            ],
            outline=rgb_colour,
            width=2,
        )
        x, y = (k % cols) * tile, (k // cols) * (tile + 22)
        sheet.paste(crop, (x, y))
        draw.text((x + 4, y + tile + 4), label, fill=(230, 230, 230))
    sheet.save(path, quality=88)


if __name__ == "__main__":
    raise SystemExit(main())
