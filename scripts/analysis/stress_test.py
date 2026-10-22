"""Stress test of the detector and its probability of detection (POD) by person size, on val.

    uv run python scripts/analysis/stress_test.py \
        [--onnx data/weights/release_v2/yolo11s_tiles_run1_best.onnx] \
        [--data-root data/heridal/yolo_full] [--backend cpu|cuda] [--workers N] \
        [--cache runs/pod/cache] [--out runs/pod] [--write-curve]

    # on the GPU with the CUDA build of OpenCV (docs/report/CV2_CUDA.md):
    PYTHONPATH=<dir with the built cv2/> uv run python scripts/analysis/stress_test.py --backend cuda

Analysis only. Every annotated val photo (``annotated_only=True``, as ``evaluate_model.py``;
the Zenodo copy has empty annotation stubs) is degraded by one transform at a time and run through the frozen
``cv2.dnn`` path (``CvDetector.detect_tiled``: 1024 px SAHI slices, 0.2 overlap, merge NMS at IoU
0.5) and scored with the VOC matching of ``sightline.ml.evaluate`` at the **frozen** threshold 0.29
(chosen on val in sprint 1). Nothing is tuned. The test split is not run: the only test numbers
are a read-only rebinning of the existing per-box test predictions in
``data/work/analysis/preds.json`` (written by ``detector_errors.py``), when that file exists.

Conditions (one parameter changed at a time, applied to the 4000x3000 original):

- ``downscale`` s: INTER_AREA down to s x the size, INTER_LINEAR back up (a higher flight: fewer
  pixels per person, same photo size);
- ``fog`` a: alpha blend with light grey (192) at weight a;
- ``motion`` k: horizontal line kernel of k px;
- ``dusk`` g: gamma g (out = in^g on 0..1), then brightness x 0.6;
- ``jpeg`` q: re-encoded at JPEG quality q.

Person size is the **shorter side of the labelled box** in pixels. "Recall by size" is reported on
the original val boxes (``size_bins``) and, for the POD curve, pooled over the original and the
downscaled conditions with each box's size multiplied by the downscale factor (``curve``): the
originals have no person under 25 px, the downscales reach 12 px. Bins with at least
``CURVE_MIN_PEOPLE`` people are curve points; a bin below the smallest of them with at least
``CURVE_LOW_N_MIN_PEOPLE`` is added as a point labelled ``low_n`` (the only measurement of the
smallest sizes; under it ``sightline.search.pod`` falls to 0 at ``DETECTION_FLOOR_PX``). The
points are made monotone (non-decreasing in size) by pool-adjacent-violators weighted by the number
of people; ``--write-curve`` copies them to ``sightline/search/pod_curve.json``, which
``sightline.search.pod`` reads.

``box_size_m``: the labelled val boxes' shorter side in metres, at the EXIF GSD of each photo that
has a pose (``sightline.geo.pose.read_pose``); its median is ``pod.PERSON_WIDTH_M``. ``sensitivity``
reads the curve at 2 and 3 cm/px for several assumed widths.

Resumable: each condition's boxes are cached per photo in ``<cache>/<onnx stem>/<condition>.jsonl``
(all boxes at conf >= 0.05); a rerun skips what is there. Writes ``<out>/<ts>/pod.json`` and
``pod.md``, ``docs/report/figures/pod_curve.png`` and a copy of both files in
``docs/evidence/pod/<ts>/``. Prints the wall time.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import sys
import time
from collections import deque
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
from multiprocessing import get_context
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sightline.search.pod import DETECTION_FLOOR_PX

THRESHOLD = 0.29  # frozen on val in sprint 1; never re-chosen here
FOG_GREY = 192
DUSK_BRIGHTNESS = 0.6  # brightness -40 %
SIZE_BINS = [(0, 20), (20, 40), (40, 60), (60, 100), (100, math.inf)]
CURVE_BINS = [
    (0, 15),
    (15, 20),
    (20, 25),
    (25, 30),
    (30, 35),
    (35, 40),
    (40, 50),
    (50, 60),
    (60, 80),
    (80, 100),
    (100, math.inf),
]
CURVE_MIN_PEOPLE = 20  # a curve bin with fewer people is reported but not used...
CURVE_LOW_N_MIN_PEOPLE = 5  # ...unless it is below every used bin: then it is a `low_n` point
SENSITIVITY_GSD_M = (0.02, 0.03)
SENSITIVITY_WIDTH_M = (0.4, 0.5, 0.6, 0.7)
FIGURE_MAX_BYTES = 300_000

Row = tuple[int, int, int, int, float]


@dataclass(frozen=True)
class Condition:
    name: str
    family: str
    param: float
    label: str


CONDITIONS = [
    Condition("baseline", "baseline", 0.0, "original"),
    *[
        Condition(f"downscale_{s}", "downscale", s, f"downscale x{s}")
        for s in (0.9, 0.75, 0.6, 0.5)
    ],
    *[Condition(f"fog_{a}", "fog", a, f"fog {a:.0%}") for a in (0.2, 0.4, 0.6)],
    *[Condition(f"motion_{k}", "motion", k, f"motion blur {k} px") for k in (5, 9, 15)],
    *[Condition(f"dusk_{g}", "dusk", g, f"dusk gamma {g}, -40 %") for g in (1.8, 2.5)],
    *[Condition(f"jpeg_{q}", "jpeg", q, f"JPEG q{q}") for q in (50, 30)],
]
BY_NAME = {c.name: c for c in CONDITIONS}


# ---------------------------------------------------------------------------- transforms


def transform(bgr: np.ndarray, c: Condition) -> np.ndarray:
    """The photo as it would look under condition ``c`` (same size, uint8 BGR)."""
    h, w = bgr.shape[:2]
    if c.family == "baseline":
        return bgr
    if c.family == "downscale":
        small = cv2.resize(
            bgr, (round(w * c.param), round(h * c.param)), interpolation=cv2.INTER_AREA
        )
        return cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)
    if c.family == "fog":
        grey = np.full_like(bgr, FOG_GREY)
        return cv2.addWeighted(bgr, 1.0 - c.param, grey, c.param, 0.0)
    if c.family == "motion":
        k = int(c.param)
        kernel = np.zeros((k, k), np.float32)
        kernel[k // 2, :] = 1.0 / k
        return cv2.filter2D(bgr, -1, kernel, borderType=cv2.BORDER_REFLECT)
    if c.family == "dusk":
        lut = np.array(
            [np.clip(255.0 * (i / 255.0) ** c.param * DUSK_BRIGHTNESS, 0, 255) for i in range(256)]
        )
        return cv2.LUT(bgr, lut.round().astype(np.uint8))
    if c.family == "jpeg":
        ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, int(c.param)])
        if not ok:
            raise RuntimeError("JPEG encode failed")
        return cv2.imdecode(buf, cv2.IMREAD_COLOR)
    raise ValueError(c.family)


def load_transformed(path: str, name: str) -> np.ndarray:
    bgr = cv2.imread(path, cv2.IMREAD_COLOR)
    if bgr is None:
        raise FileNotFoundError(path)
    return transform(bgr, BY_NAME[name])


# ---------------------------------------------------------------------------- detection

_detector = None  # one CvDetector per process


def _init_worker(onnx: str, threads: int, backend: str | None) -> None:
    global _detector
    from sightline.ml.detect_cv import CvDetector

    _detector = CvDetector(Path(onnx), threads=threads, backend=backend)


def _rows(bgr: np.ndarray) -> list[Row]:
    assert _detector is not None
    return [(d.box.x1, d.box.y1, d.box.x2, d.box.y2, d.conf) for d in _detector.detect_tiled(bgr)]


def _detect_job(job: tuple[str, str]) -> list[Row]:
    return _rows(load_transformed(*job))


def run_condition(
    c: Condition,
    images: list,
    cache: Path,
    onnx: Path,
    backend: str,
    workers: int,
    threads: int,
) -> dict[str, list[Row]]:
    """Boxes per photo id for condition ``c``, from the cache where present."""
    done: dict[str, list[Row]] = {}
    if cache.exists():
        for line in cache.read_text(encoding="utf-8").splitlines():
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:  # a line cut short by an interrupted run
                continue
            done[rec["id"]] = [tuple(r) for r in rec["rows"]]
    todo = [im for im in images if im.path.stem not in done]
    if not todo:
        return done
    print(f"  {c.name}: {len(todo)} photos to run ({len(images) - len(todo)} cached)", flush=True)
    cache.parent.mkdir(parents=True, exist_ok=True)
    with cache.open("a", encoding="utf-8") as fh:
        if cache.stat().st_size and not cache.read_bytes().endswith(b"\n"):
            fh.write("\n")  # start after a line cut short

        def save(stem: str, rows: list[Row]) -> None:
            done[stem] = rows
            fh.write(json.dumps({"id": stem, "rows": rows}) + "\n")
            fh.flush()

        if backend != "cpu" or workers <= 1:
            if _detector is None:
                _init_worker(str(onnx), threads, backend)
            # Read and degrade the next few photos on threads while the network runs.
            with ThreadPoolExecutor(max_workers=3) as pool:
                window: deque = deque()
                it = iter(todo)
                for im in it:
                    window.append((im, pool.submit(load_transformed, str(im.path), c.name)))
                    if len(window) >= 3:
                        break
                while window:
                    im, fut = window.popleft()
                    nxt = next(it, None)
                    if nxt is not None:
                        window.append((nxt, pool.submit(load_transformed, str(nxt.path), c.name)))
                    save(im.path.stem, _rows(fut.result()))
        else:
            with ProcessPoolExecutor(
                max_workers=workers,
                mp_context=get_context("spawn"),
                initializer=_init_worker,
                initargs=(str(onnx), threads, backend),
            ) as pool:
                jobs = [(str(im.path), c.name) for im in todo]
                for im, rows in zip(todo, pool.map(_detect_job, jobs), strict=True):
                    save(im.path.stem, rows)
    return done


# ---------------------------------------------------------------------------- scoring


def short_side(box) -> float:
    return float(min(box.x2 - box.x1, box.y2 - box.y1))


def matched_truth(preds: dict, truth: dict, threshold: float) -> dict[str, set[int]]:
    """Greedy one-to-one VOC matching in the order and rule of ``evaluate._voc_hits``, on the
    boxes at or above ``threshold``; the truth indices each photo's boxes found."""
    from sightline.ml.evaluate import VOC_IOU, iou

    flat = [
        (d.conf, img, d.box) for img, dets in preds.items() for d in dets if d.conf >= threshold
    ]
    flat.sort(key=lambda t: (-t[0], t[1], t[2].x1, t[2].y1, t[2].x2, t[2].y2))
    used: dict[str, set[int]] = {img: set() for img in truth}
    for _, img, box in flat:
        best, best_j = 0.0, -1
        for j, gt in enumerate(truth.get(img, [])):
            if j in used.setdefault(img, set()):
                continue
            v = iou(box, gt)
            if v > best:
                best, best_j = v, j
        if best_j >= 0 and best >= VOC_IOU:
            used[img].add(best_j)
    return used


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def bin_table(sizes: list[float], found: list[bool], bins) -> list[dict]:
    out = []
    for lo, hi in bins:
        idx = [i for i, s in enumerate(sizes) if lo <= s < hi]
        k, n = sum(found[i] for i in idx), len(idx)
        lo_ci, hi_ci = wilson(k, n)
        out.append(
            {
                "bin": f"<{hi:g}"
                if lo == 0
                else (f">{lo:g}" if hi == math.inf else f"{lo:g}-{hi:g}"),
                "lo_px": lo,
                "hi_px": None if hi == math.inf else hi,
                "people": n,
                "found": k,
                "recall": round(k / n, 4) if n else None,
                "ci95": [round(lo_ci, 4), round(hi_ci, 4)] if n else None,
                "median_px": round(float(np.median([sizes[i] for i in idx])), 1) if n else None,
            }
        )
    return out


def monotone(points: list[dict]) -> list[float]:
    """Pool-adjacent-violators: the non-decreasing fit of the bins' recalls, weighted by people."""
    blocks = [[p["found"] / p["people"], p["people"], 1] for p in points]
    i = 0
    while i < len(blocks) - 1:
        if blocks[i][0] > blocks[i + 1][0] + 1e-12:
            a, b = blocks[i], blocks[i + 1]
            n = a[1] + b[1]
            blocks[i] = [(a[0] * a[1] + b[0] * b[1]) / n, n, a[2] + b[2]]
            del blocks[i + 1]
            i = max(0, i - 1)
        else:
            i += 1
    out: list[float] = []
    for v, _, count in blocks:
        out += [v] * count
    return out


def score_condition(c: Condition, rows: dict, images: list) -> dict:
    from sightline.ml.evaluate import score_voc
    from sightline.ml.types import Box, RawDetection

    preds = {
        im.path.stem: [RawDetection(Box(*r[:4]), r[4]) for r in rows[im.path.stem]] for im in images
    }
    truth = {im.path.stem: list(im.boxes) for im in images}
    voc = score_voc(preds, truth, THRESHOLD)
    used = matched_truth(preds, truth, THRESHOLD)
    sizes, found = [], []
    for im in images:
        for j, b in enumerate(im.boxes):
            sizes.append(short_side(b))
            found.append(j in used.get(im.path.stem, set()))
    kept = sum(1 for dets in preds.values() for d in dets if d.conf >= THRESHOLD)
    assert sum(found) == round(voc.recall * len(found)), "matching differs from score_voc"
    return {
        "name": c.name,
        "family": c.family,
        "param": c.param,
        "label": c.label,
        "precision": round(voc.precision, 4),
        "recall": round(voc.recall, 4),
        "ap50": round(voc.ap50, 4),
        "people": len(found),
        "found": sum(found),
        "boxes_kept": kept,
        "_sizes": sizes,
        "_found": found,
    }


def _display(path: Path) -> str:
    """``data/...`` from wherever the checkout keeps it."""
    parts = path.resolve().parts
    return "/".join(parts[parts.index("data") :]) if "data" in parts else str(path)


def test_rebin(data_root: Path, preds_json: Path) -> dict | None:
    """Read-only: recall by size on the frozen test predictions already on disk."""
    if not preds_json.exists():
        return None
    from sightline.ml.data import load_split
    from sightline.ml.types import Box, RawDetection

    raw = json.loads(preds_json.read_text(encoding="utf-8"))
    images = load_split("test", data_root)
    if {im.path.stem for im in images} != set(raw):
        return None
    preds = {k: [RawDetection(Box(*d["box"]), d["conf"]) for d in v] for k, v in raw.items()}
    truth = {im.path.stem: list(im.boxes) for im in images}
    used = matched_truth(preds, truth, THRESHOLD)
    sizes, found = [], []
    for im in images:
        for j, b in enumerate(im.boxes):
            sizes.append(short_side(b))
            found.append(j in used.get(im.path.stem, set()))
    return {
        "source": _display(preds_json),
        "people": len(found),
        "found": sum(found),
        "recall": round(sum(found) / len(found), 4),
        "size_bins": bin_table(sizes, found, SIZE_BINS),
    }


# ---------------------------------------------------------------------------- outputs


def make_curve(results: list[dict]) -> dict:
    sizes: list[float] = []
    found: list[bool] = []
    for r in results:
        if r["family"] in ("baseline", "downscale"):
            s = 1.0 if r["family"] == "baseline" else r["param"]
            sizes += [x * s for x in r["_sizes"]]
            found += r["_found"]
    table = bin_table(sizes, found, CURVE_BINS)
    used = [t for t in table if t["people"] >= CURVE_MIN_PEOPLE]
    low = [
        t
        for t in table
        if used
        and CURVE_LOW_N_MIN_PEOPLE <= t["people"] < CURVE_MIN_PEOPLE
        and t["lo_px"] < used[0]["lo_px"]
    ]
    used = low + used
    fit = monotone(used)
    return {
        "size_measure": "shorter side of the labelled box, px",
        "pooled_from": [
            "baseline",
            "downscale_0.9",
            "downscale_0.75",
            "downscale_0.6",
            "downscale_0.5",
        ],
        "min_people_per_point": CURVE_MIN_PEOPLE,
        "min_people_low_n_point": CURVE_LOW_N_MIN_PEOPLE,
        "floor_px": DETECTION_FLOOR_PX,
        "bins": table,
        "points": [
            {
                "px": t["median_px"],
                "recall": round(v, 4),
                "measured": t["recall"],
                "people": t["people"],
                **({"low_n": True} if t["people"] < CURVE_MIN_PEOPLE else {}),
            }
            for t, v in zip(used, fit, strict=True)
        ],
    }


def box_size_m(images: list) -> dict:
    """The labelled boxes' shorter side in metres, on the photos whose EXIF gives a GSD."""
    from sightline.geo.pose import read_pose

    metres, pixels, gsds = [], [], []
    for im in images:
        info = read_pose(im.path)
        if info is None:
            continue
        gsds.append(info.pose.gsd_m)
        pixels += [short_side(b) for b in im.boxes]
        metres += [short_side(b) * info.pose.gsd_m for b in im.boxes]
    q1, med, q3 = (float(v) for v in np.percentile(metres, [25, 50, 75]))
    return {
        "measure": "shorter side of the labelled box x the photo's EXIF GSD, m",
        "photos": len(images),
        "photos_with_pose": len(gsds),
        "boxes": len(metres),
        "median_m": round(med, 3),
        "q1_m": round(q1, 3),
        "q3_m": round(q3, 3),
        "median_px": float(np.median(pixels)),
        "median_gsd_m": round(float(np.median(gsds)), 5),
    }


def sensitivity(points: list[dict]) -> list[dict]:
    """Map recall (the curve as ``sightline.search.pod`` reads it) per GSD and assumed width."""
    from sightline.search.pod import PERSON_WIDTH_M, PodCurve, person_px

    curve = PodCurve(tuple((p["px"], p["recall"]) for p in points), floor_px=DETECTION_FLOOR_PX)
    widths = sorted({*SENSITIVITY_WIDTH_M, PERSON_WIDTH_M})
    return [
        {
            "gsd_m": g,
            "width_m": w,
            "px": round(person_px(g, w), 1),
            "recall": round(curve.recall_at(person_px(g, w)), 3),
            "used": w == PERSON_WIDTH_M,
        }
        for g in SENSITIVITY_GSD_M
        for w in widths
    ]


def figure(results: list[dict], curve: dict, test: dict | None, path: Path, n_photos: int) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    ink, muted, grid = "#0b0b0b", "#52514e", "#e4e3df"
    blue, orange = "#2a78d6", "#eb6834"
    plt.rcParams.update(
        {
            "font.size": 9,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "axes.edgecolor": muted,
            "axes.labelcolor": ink,
            "xtick.color": muted,
            "ytick.color": muted,
        }
    )
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(10, 4.2), gridspec_kw={"width_ratios": [1.1, 1]})

    pts = [b for b in curve["bins"] if b["people"] >= CURVE_MIN_PEOPLE]
    x = [b["median_px"] for b in pts]
    y = [b["recall"] for b in pts]
    err = [[b["recall"] - b["ci95"][0] for b in pts], [b["ci95"][1] - b["recall"] for b in pts]]
    a1.errorbar(
        x,
        y,
        yerr=err,
        fmt="o",
        ms=5,
        color=blue,
        ecolor=blue,
        elinewidth=1,
        capsize=0,
        label="val, original + downscaled (95 % CI)",
    )
    low = [p for p in curve["points"] if p.get("low_n")]
    if low:
        lb = [b for b in curve["bins"] if b["median_px"] in {p["px"] for p in low}]
        a1.errorbar(
            [b["median_px"] for b in lb],
            [b["recall"] for b in lb],
            yerr=[
                [b["recall"] - b["ci95"][0] for b in lb],
                [b["ci95"][1] - b["recall"] for b in lb],
            ],
            fmt="o",
            ms=5,
            mfc="white",
            color=blue,
            ecolor=blue,
            elinewidth=1,
            capsize=0,
            label=f"low n (n = {', '.join(str(b['people']) for b in lb)})",
        )
    cx = [curve["floor_px"], *(p["px"] for p in curve["points"])]
    cy = [0.0, *(p["recall"] for p in curve["points"])]
    a1.plot(cx, cy, color=blue, lw=2, label="POD curve used by the map (monotone fit)")
    a1.plot(
        cx[:2],
        cy[:2],
        color="white",
        lw=1,
        ls=(0, (2, 2)),
        label=f"(dashed: extrapolated to 0 at {DETECTION_FLOOR_PX:g} px)",
    )
    if test:
        tb = [b for b in test["size_bins"] if b["people"]]
        a1.plot(
            [b["median_px"] for b in tb],
            [b["recall"] for b in tb],
            "s",
            ms=6,
            mfc="none",
            mec=orange,
            mew=1.5,
            label="test, existing predictions (read-only)",
        )
    for px, name in (
        (DETECTION_FLOOR_PX, "Johnson: detect 4 px"),
        (15, "recognise 15 px"),
        (25, "identify 25 px"),
    ):
        a1.axvline(px, color=muted, lw=0.8, ls=":")
        a1.text(px + 0.8, 0.04, name, color=muted, fontsize=7.5, rotation=90, va="bottom")
    a1.set_xlabel("person size in the photo (shorter side of box, px)")
    a1.set_ylabel("recall at threshold 0.29")
    a1.set_ylim(0, 1.02)
    a1.set_xlim(0, max(cx + x) * 1.08)
    a1.grid(axis="y", color=grid, lw=0.8)
    a1.set_axisbelow(True)
    a1.legend(frameon=False, fontsize=7.5, loc="lower right")
    a1.set_title("Recall by person size", loc="left", color=ink, fontsize=10)

    names = [r["label"] for r in results][::-1]
    yy = np.arange(len(names))
    rec = [r["recall"] for r in results][::-1]
    pre = [r["precision"] for r in results][::-1]
    for i in yy:
        a2.plot([min(rec[i], pre[i]), max(rec[i], pre[i])], [i, i], color=grid, lw=2, zorder=1)
    a2.scatter(rec, yy, s=30, color=blue, zorder=2, label="recall")
    a2.scatter(pre, yy, s=30, color=orange, zorder=2, label="precision")
    a2.set_yticks(yy, names, fontsize=8)
    a2.set_xlim(0, 1.0)
    a2.axvline(results[0]["recall"], color=blue, lw=0.8, ls=":")
    a2.grid(axis="x", color=grid, lw=0.8)
    a2.set_axisbelow(True)
    a2.set_xlabel(f"VOC score at threshold 0.29 (val, {n_photos} photos)")
    a2.legend(frameon=False, fontsize=8, loc="lower left")
    a2.set_title("Each condition alone", loc="left", color=ink, fontsize=10)
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    for dpi in (130, 110, 90, 75):
        fig.savefig(path, dpi=dpi, facecolor="white")
        if path.stat().st_size <= FIGURE_MAX_BYTES:
            break
    plt.close(fig)


def markdown(doc: dict) -> str:
    lines = [
        f"# POD stress test, {doc['ts']}",
        "",
        (
            f"Val split, {doc['val_photos']} photos, {doc['val_people']} people; cv2.dnn "
            f"({doc['backend']}), {doc['onnx']}; frozen threshold {THRESHOLD}. Wall time "
            f"{doc['wall_s']:.0f} s ({doc['wall_s'] / 60:.1f} min), {doc['cached_conditions']} of "
            f"{len(doc['conditions'])} conditions from the cache."
        ),
        "",
        "## Conditions",
        "",
        "| Condition | Recall | Precision | AP50 | Found / people | Boxes kept |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for r in doc["conditions"]:
        lines.append(
            f"| {r['label']} | {r['recall']:.3f} | {r['precision']:.3f} | {r['ap50']:.3f} | "
            f"{r['found']} / {r['people']} | {r['boxes_kept']} |"
        )
    lines += [
        "",
        "## Recall by person size (original val boxes, baseline)",
        "",
        "| Shorter side | People | Found | Recall | 95 % CI |",
        "|---|---:|---:|---:|---|",
    ]
    for b in doc["size_bins"]:
        rec = "n/a" if b["recall"] is None else f"{b['recall']:.3f}"
        ci = "" if b["ci95"] is None else f"{b['ci95'][0]:.2f}-{b['ci95'][1]:.2f}"
        lines.append(f"| {b['bin']} px | {b['people']} | {b['found']} | {rec} | {ci} |")
    lines += [
        "",
        "## POD curve (baseline + downscales, size x downscale factor)",
        "",
        "| Shorter side | People | Found | Recall | 95 % CI | Median px |",
        "|---|---:|---:|---:|---|---:|",
    ]
    for b in doc["curve"]["bins"]:
        rec = "n/a" if b["recall"] is None else f"{b['recall']:.3f}"
        ci = "" if b["ci95"] is None else f"{b['ci95'][0]:.2f}-{b['ci95'][1]:.2f}"
        med = "" if b["median_px"] is None else f"{b['median_px']:.1f}"
        lines.append(f"| {b['bin']} px | {b['people']} | {b['found']} | {rec} | {ci} | {med} |")
    lines += [
        "",
        "Monotone curve points (px, recall; * low-n): "
        + ", ".join(
            f"({p['px']}, {p['recall']:.3f}{', n=' + str(p['people']) + '*' if p.get('low_n') else ''})"
            for p in doc["curve"]["points"]
        ),
        f"Below the smallest point the map falls linearly to 0 at {DETECTION_FLOOR_PX:g} px.",
    ]
    if doc.get("box_size_m"):
        b = doc["box_size_m"]
        lines += [
            "",
            "## Labelled box size in metres",
            "",
            (
                f"{b['boxes']} boxes on the {b['photos_with_pose']} of {b['photos']} photos with an "
                f"EXIF pose: shorter side median {b['median_m']:.3f} m (IQR {b['q1_m']:.3f}-"
                f"{b['q3_m']:.3f}), {b['median_px']:g} px at a median GSD of "
                f"{b['median_gsd_m'] * 100:.2f} cm/px."
            ),
        ]
    if doc.get("sensitivity"):
        gsds = sorted({r["gsd_m"] for r in doc["sensitivity"]})
        widths = sorted({r["width_m"] for r in doc["sensitivity"]})
        at = {(r["gsd_m"], r["width_m"]): r for r in doc["sensitivity"]}
        lines += [
            "",
            "## Map recall by assumed person width",
            "",
            "| Width | " + " | ".join(f"{g * 100:g} cm/px" for g in gsds) + " |",
            "|---|" + "---:|" * len(gsds),
        ]
        for w in widths:
            used = " (used)" if at[(gsds[0], w)]["used"] else ""
            cells = " | ".join(
                f"{at[(g, w)]['recall']:.3f} ({at[(g, w)]['px']:g} px)" for g in gsds
            )
            lines.append(f"| {w:g} m{used} | {cells} |")
    if doc.get("test_rebin"):
        t = doc["test_rebin"]
        lines += [
            "",
            f"## Test, read-only rebinning of {t['source']}",
            "",
            f"Recall {t['recall']:.3f} ({t['found']} / {t['people']}).",
            "",
            "| Shorter side | People | Found | Recall |",
            "|---|---:|---:|---:|",
        ]
        for b in t["size_bins"]:
            rec = "n/a" if b["recall"] is None else f"{b['recall']:.3f}"
            lines.append(f"| {b['bin']} px | {b['people']} | {b['found']} | {rec} |")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--onnx", type=Path, default=ROOT / "data/weights/release_v2/yolo11s_tiles_run1_best.onnx"
    )
    ap.add_argument("--data-root", type=Path, default=ROOT / "data/heridal/yolo_full")
    ap.add_argument("--test-preds", type=Path, default=ROOT / "data/work/analysis/preds.json")
    ap.add_argument("--backend", choices=("cpu", "cuda", "cuda-fp16"), default=None)
    ap.add_argument("--workers", type=int, default=None)
    ap.add_argument("--threads", type=int, default=None)
    ap.add_argument("--cache", type=Path, default=ROOT / "runs/pod/cache")
    ap.add_argument("--out", type=Path, default=ROOT / "runs/pod")
    ap.add_argument("--figure", type=Path, default=ROOT / "docs/report/figures/pod_curve.png")
    ap.add_argument("--evidence", type=Path, default=ROOT / "docs/evidence/pod")
    ap.add_argument("--only", nargs="*", default=None, help="condition names (default: all)")
    ap.add_argument(
        "--write-curve", action="store_true", help="update sightline/search/pod_curve.json"
    )
    args = ap.parse_args(argv)

    t0 = time.perf_counter()
    from sightline.ml.data import load_split
    from sightline.ml.detect_cv import resolve_cv_backend

    if not args.onnx.exists():
        print(f"missing {args.onnx} (gh release download model-onnx-v2)", file=sys.stderr)
        return 2
    images = load_split("val", args.data_root, annotated_only=True)  # as evaluate_model.py
    backend = resolve_cv_backend(args.backend)
    cpus = os.cpu_count() or 1
    workers = args.workers or (1 if backend != "cpu" else max(1, min(4, cpus // 2)))
    threads = args.threads or max(1, cpus // workers)
    conds = [c for c in CONDITIONS if args.only is None or c.name in args.only]
    print(
        f"val: {len(images)} photos, {sum(len(i.boxes) for i in images)} people; cv2 {cv2.__version__} "
        f"on {backend}, {workers} workers x {threads} threads; {len(conds)} conditions",
        flush=True,
    )

    results, cached = [], 0
    for c in conds:
        tc = time.perf_counter()
        cache = args.cache / args.onnx.stem / f"{c.name}.jsonl"
        before = cache.exists() and sum(1 for _ in cache.open()) >= len(images)
        cached += before
        rows = run_condition(c, images, cache, args.onnx, backend, workers, threads)
        r = score_condition(c, rows, images)
        results.append(r)
        print(
            f"  {c.label:24s} R {r['recall']:.3f}  P {r['precision']:.3f}  AP50 {r['ap50']:.3f}"
            f"  ({time.perf_counter() - tc:.0f} s)",
            flush=True,
        )

    base = results[0]
    doc = {
        "ts": datetime.now().strftime("%Y%m%d-%H%M%S"),
        "split": "val",
        "val_photos": len(images),
        "val_people": base["people"],
        "threshold": THRESHOLD,
        "onnx": args.onnx.name,
        "backend": backend,
        "opencv": cv2.__version__,
        "transforms": {"fog_grey": FOG_GREY, "dusk_brightness": DUSK_BRIGHTNESS},
        "conditions": [{k: v for k, v in r.items() if not k.startswith("_")} for r in results],
        "size_bins": bin_table(base["_sizes"], base["_found"], SIZE_BINS),
        "test_rebin": test_rebin(args.data_root, args.test_preds),
    }
    if base["name"] == "baseline" and all(
        BY_NAME[n] in conds
        for n in ("downscale_0.9", "downscale_0.75", "downscale_0.6", "downscale_0.5")
    ):
        doc["curve"] = make_curve(results)
    else:
        doc["curve"] = {"bins": [], "points": []}
    doc["box_size_m"] = box_size_m(images)
    doc["sensitivity"] = sensitivity(doc["curve"]["points"]) if doc["curve"]["points"] else []
    doc["wall_s"] = round(time.perf_counter() - t0, 1)
    doc["cached_conditions"] = cached

    out = args.out / doc["ts"]
    out.mkdir(parents=True, exist_ok=True)
    (out / "pod.json").write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    (out / "pod.md").write_text(markdown(doc), encoding="utf-8")
    if doc["curve"]["points"]:
        figure(results, doc["curve"], doc["test_rebin"], args.figure, len(images))
        ev = args.evidence / doc["ts"]
        ev.mkdir(parents=True, exist_ok=True)
        for f in ("pod.json", "pod.md"):
            shutil.copy2(out / f, ev / f)
        if args.write_curve:
            dest = ROOT / "sightline/search/pod_curve.json"
            curve = {
                "source": f"docs/evidence/pod/{doc['ts']}/pod.json",
                "split": "val",
                "threshold": THRESHOLD,
                "size_measure": doc["curve"]["size_measure"],
                "floor_px": DETECTION_FLOOR_PX,
                "low_n_px": [p["px"] for p in doc["curve"]["points"] if p.get("low_n")],
                "points": [[p["px"], p["recall"]] for p in doc["curve"]["points"]],
            }
            dest.write_text(json.dumps(curve, indent=2) + "\n", encoding="utf-8")
            print(f"wrote {dest.relative_to(ROOT)}")
        print(f"evidence {ev}")
    print(markdown(doc))
    print(f"wrote {out}; wall time {doc['wall_s']:.1f} s ({doc['wall_s'] / 60:.1f} min)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
