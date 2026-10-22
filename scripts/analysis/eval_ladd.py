"""Score the frozen detector once on LADD (Lacmus Drone Dataset), a set it has never seen.

    CUDA_VISIBLE_DEVICES= uv run python scripts/analysis/eval_ladd.py \
        --data-root data/ladd/extracted [--backend cuda] [--workers 4 --threads 8] \
        [--resume runs/ladd/<ts>] [--no-evidence]

Nothing is tuned. Each photo goes through exactly the judge path of ``scripts/reproduce_cv2.py``
(``CvDetector.detect_tiled``: 1024 px slices, 0.2 overlap, merge NMS at IoU 0.5) with the
weights-v2 ONNX, and the boxes are scored with the same code as ``scripts/evaluate_model.py``
(``score_voc``: VOC precision / recall at the threshold, AP50 over all confidences; and
``score_sar``, the SAR-APD-style count) at the threshold **0.29 frozen on HERIDAL val** in
sprint 1. No sweep, no other threshold, no retraining: one run, reported as it comes out.

Two layouts are read, chosen by what is under ``--data-root``:

- the original LADD release (VOC): ``Annotations/*.xml`` + ``JPEGImages/*.jpg``; if
  ``ImageSets/Main/test.txt`` exists only those photos are scored, else all of them;
- the Dataset Ninja / Supervisely copy: ``<ds>/ann/<name>.jpg.json`` + ``<ds>/img/<name>.jpg``.
  It has no split, so every photo is scored.

LADD's one class is "Pedestrian" (VOC) / "pedestrian" (Supervisely); every such box is a person.
Boxes are clipped to the JPEG's own size, as ``sightline.ml.voc.read_voc`` does for HERIDAL.

Resumable: boxes per photo are appended to ``<run>/preds.jsonl`` as they finish (at the save
threshold 0.05, as the detector returns them); ``--resume <run>`` skips the photos already there.
Writes ``<run>/ladd.json`` and ``<run>/ladd.md`` and, unless ``--no-evidence``, copies both to
``docs/evidence/ladd/<ts>/``. Licence: LADD is GPL-3.0; this script reads it and redistributes
nothing (docs/report/LADD.md).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from multiprocessing import get_context
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
for p in (ROOT, ROOT / "scripts"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

import reproduce_cv2 as rc

from sightline.ml.types import Box

LADD_CLASSES = {"pedestrian"}  # compared lower-case
# HERIDAL reference rows (docs/report/OPENCV_REPORT.md:296, docs/DETECTOR_LIMITS.md:117)
HERIDAL_TEST = {"precision": 0.802, "recall": 0.864, "ap50": 0.868}
HERIDAL_UNSEEN_SITES_RECALL = 0.825


@dataclass(frozen=True)
class Photo:
    name: str  # unique key, e.g. "ds0/562" or "562"
    path: Path
    width: int
    height: int
    boxes: tuple[Box, ...]


def _clip(x1: float, y1: float, x2: float, y2: float, w: int, h: int) -> Box | None:
    a, b = max(0, int(x1)), max(0, int(y1))
    c, d = min(w, int(x2)), min(h, int(y2))
    return Box(a, b, c, d) if c > a and d > b else None


def _voc_boxes(xml_path: Path, w: int, h: int) -> list[Box]:
    import xml.etree.ElementTree as ET

    out = []
    for obj in ET.parse(xml_path).getroot().iter("object"):
        if (obj.findtext("name") or "").strip().lower() not in LADD_CLASSES:
            continue
        bb = obj.find("bndbox")
        if bb is None:
            continue
        v = [float(bb.findtext(k) or "nan") for k in ("xmin", "ymin", "xmax", "ymax")]
        if (box := _clip(*v, w, h)) is not None:
            out.append(box)
    return out


def _sly_boxes(json_path: Path, w: int, h: int) -> list[Box]:
    out = []
    for obj in json.loads(json_path.read_text(encoding="utf-8")).get("objects", []):
        if obj.get("classTitle", "").lower() not in LADD_CLASSES:
            continue
        if obj.get("geometryType") != "rectangle":
            continue
        (x1, y1), (x2, y2) = obj["points"]["exterior"]
        lo_x, hi_x = sorted((x1, x2))
        lo_y, hi_y = sorted((y1, y2))
        if (box := _clip(lo_x, lo_y, hi_x, hi_y, w, h)) is not None:
            out.append(box)
    return out


def load_ladd(root: Path) -> tuple[list[Photo], str]:
    """All photos to score and a sentence saying which part of LADD they are."""
    from sightline.ml.voc import image_size

    photos: list[Photo] = []
    if (root / "Annotations").is_dir():
        split_file = root / "ImageSets" / "Main" / "test.txt"
        if split_file.exists():
            stems = [s.strip() for s in split_file.read_text().splitlines() if s.strip()]
            which = f"the official test split ({split_file.relative_to(root)})"
        else:
            stems = sorted(p.stem for p in (root / "Annotations").glob("*.xml"))
            which = "every annotated photo (no ImageSets/Main/test.txt in this copy)"
        for stem in stems:
            jpg = root / "JPEGImages" / f"{stem}.jpg"
            w, h = image_size(jpg)
            boxes = _voc_boxes(root / "Annotations" / f"{stem}.xml", w, h)
            photos.append(Photo(stem, jpg, w, h, tuple(boxes)))
        return photos, which
    anns = sorted(root.glob("*/ann/*.json"))
    if not anns:
        raise FileNotFoundError(
            f"{root}: neither Annotations/ (VOC) nor */ann/*.json (Supervisely)"
        )
    for ann in anns:
        ds = ann.parent.parent
        jpg = ds / "img" / ann.name.removesuffix(".json")
        w, h = image_size(jpg)
        boxes = _sly_boxes(ann, w, h)
        photos.append(Photo(f"{ds.name}/{jpg.stem}", jpg, w, h, tuple(boxes)))
    dss = sorted({a.parent.parent.name for a in anns})
    which = f"every photo of the Supervisely copy (datasets {', '.join(dss)}; it carries no split)"
    return photos, which


def _read_done(preds_file: Path) -> dict[str, list[list[float]]]:
    done: dict[str, list[list[float]]] = {}
    if preds_file.exists():
        for line in preds_file.read_text(encoding="utf-8").splitlines():
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue  # a line cut by an interrupted run: that photo runs again
            done[rec["photo"]] = rec["boxes"]
    return done


def detect_all(
    todo: list[Photo], preds_file: Path, onnx: Path, workers: int, threads: int, backend: str
) -> None:
    """Runs the judge path on ``todo`` and appends one JSON line per photo as each finishes."""
    paths = [str(p.path) for p in todo]
    with preds_file.open("a", encoding="utf-8") as f:

        def write(photo: Photo, rows: list[tuple]) -> None:
            f.write(json.dumps({"photo": photo.name, "boxes": [list(r) for r in rows]}) + "\n")
            f.flush()

        t0, n = time.perf_counter(), len(todo)

        def progress(i: int) -> None:
            if i % 25 == 0 or i == n:
                el = time.perf_counter() - t0
                print(f"  {i}/{n} photos, {el:.0f} s, {el / i:.2f} s per photo", flush=True)

        if workers <= 1:
            rc._init_worker(str(onnx), threads, backend)
            for i, (photo, path) in enumerate(zip(todo, paths, strict=True), 1):
                write(photo, rc._detect(path))
                progress(i)
            return
        with ProcessPoolExecutor(
            max_workers=workers,
            mp_context=get_context("spawn"),
            initializer=rc._init_worker,
            initargs=(str(onnx), threads, backend),
        ) as pool:
            for i, (photo, rows) in enumerate(
                zip(todo, pool.map(rc._detect, paths), strict=True), 1
            ):
                write(photo, rows)
                progress(i)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def git_commit() -> str | None:
    try:
        return subprocess.run(
            ["git", "-C", str(ROOT), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def render_md(r: dict) -> str:
    v, s, c = r["voc"], r["sar"], r["counts"]
    h = HERIDAL_TEST
    label = "" if not r["synthetic"] else "\n**SYNTHETIC STAND-IN: not a result.**\n"
    return f"""# LADD, frozen detector, one run ({r["timestamp"]})
{label}
Data: {r["dataset"]["photos"]} photos, {r["dataset"]["people"]} people \
({r["dataset"]["photos_without_people"]} photos without people); {r["dataset"]["which"]}.
Model `{r["model"]["onnx"]}` (sha256 `{r["model"]["sha256"][:12]}`), cv2.dnn on {r["run"]["where"]},
threshold {r["threshold"]} (frozen on HERIDAL val), merge NMS {r["merge_nms_iou"]}.

| Set | VOC precision | VOC recall | AP50 | SAR-APD P / R |
|---|---|---|---|---|
| LADD ({r["dataset"]["photos"]} photos, never seen) | {v["precision"]:.3f} | {v["recall"]:.3f} | \
{v["ap50"]:.3f} | {s["precision"]:.3f} / {s["recall"]:.3f} |
| HERIDAL test (101 photos) | {h["precision"]:.3f} | {h["recall"]:.3f} | {h["ap50"]:.3f} | 0.898 / 0.896 |
| HERIDAL test, 4 unseen sites | | {HERIDAL_UNSEEN_SITES_RECALL:.3f} | | |

At 0.29: {c["found"]} people found, {c["missed"]} missed, {c["false_alarms"]} false alarms \
({c["false_alarms_per_photo"]:.2f} per photo).
Wall time {r["run"]["wall_s"]:.0f} s for {r["run"]["photos_detected"]} photos detected in this \
invocation ({r["run"]["s_per_photo"]:.2f} s per photo of wall time); \
{r["run"]["workers"]} workers x {r["run"]["threads"]} threads.
"""


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--data-root", type=Path, default=ROOT / "data/ladd/extracted")
    ap.add_argument(
        "--onnx", type=Path, default=ROOT / "data/weights/release_v2/sightline-detector-v2.onnx"
    )
    ap.add_argument(
        "--expected",
        type=Path,
        default=ROOT / "data/weights/release_v2/detector_metrics.json",
        help="only read to check that the frozen threshold is still 0.29",
    )
    ap.add_argument("--archive-sha256", default=None, help="recorded in ladd.json")
    ap.add_argument("--backend", choices=("cpu", "cuda", "cuda-fp16"), default=None)
    ap.add_argument("--workers", type=int, default=None)
    ap.add_argument("--threads", type=int, default=None)
    ap.add_argument("--out", type=Path, default=ROOT / "runs/ladd")
    ap.add_argument("--resume", type=Path, default=None, help="an earlier run folder to continue")
    ap.add_argument("--no-evidence", action="store_true", help="do not copy to docs/evidence/")
    ap.add_argument(
        "--synthetic", action="store_true", help="label the outputs as a synthetic stand-in"
    )
    args = ap.parse_args(argv)

    t0 = time.perf_counter()
    from sightline.ml.detect_cv import MERGE_NMS_IOU, resolve_cv_backend
    from sightline.ml.evaluate import score_sar, score_voc
    from sightline.ml.tuning import scores_at
    from sightline.ml.types import RawDetection

    if not args.onnx.exists():
        print(f"missing {args.onnx} (gh release download model-onnx-v2)", file=sys.stderr)
        return 2
    if args.expected.exists():
        thr = json.loads(args.expected.read_text(encoding="utf-8"))["detector"]["threshold"]
        if abs(thr - rc.THRESHOLD) > 1e-9:
            print(f"{args.expected} says threshold {thr}, not the frozen {rc.THRESHOLD}")
            return 1
    try:
        photos, which = load_ladd(args.data_root)
    except FileNotFoundError as e:
        print(e, file=sys.stderr)
        return 2

    run_dir = args.resume or args.out / datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    run_dir.mkdir(parents=True, exist_ok=True)
    preds_file = run_dir / "preds.jsonl"
    done = _read_done(preds_file)
    if done:  # rewrite without a line an interrupted run may have cut, so appends start clean
        preds_file.write_text(
            "".join(json.dumps({"photo": k, "boxes": v}) + "\n" for k, v in done.items()),
            encoding="utf-8",
        )
    todo = [p for p in photos if p.name not in done]

    backend = resolve_cv_backend(args.backend)
    cpus = os.cpu_count() or 1
    workers = args.workers or (1 if backend != "cpu" else rc.default_workers(cpus))
    threads = args.threads or max(1, cpus // workers)
    spec = rc.machine_spec()
    where = "the CPU" if backend == "cpu" else f"CUDA ({backend}, ENGINE_CLASSIC)"
    n_people = sum(len(p.boxes) for p in photos)
    print(f"LADD: {len(photos)} photos, {n_people} people; {which}")
    print(
        f"cv2.dnn on {where}: {args.onnx.name}, {workers} workers x {threads} threads, "
        f"threshold {rc.THRESHOLD}, merge NMS {MERGE_NMS_IOU}; run folder {run_dir}"
    )
    print(f"{len(done)} photos already in {preds_file.name}, {len(todo)} to detect", flush=True)

    t_detect = time.perf_counter()
    if todo:
        detect_all(todo, preds_file, args.onnx, workers, threads, backend)
    detect_s = time.perf_counter() - t_detect
    done = _read_done(preds_file)
    missing = [p.name for p in photos if p.name not in done]
    if missing:
        print(f"{len(missing)} photos have no boxes recorded, e.g. {missing[:3]}", file=sys.stderr)
        return 1

    preds = {
        p.name: [RawDetection(Box(*map(int, r[:4])), float(r[4])) for r in done[p.name]]
        for p in photos
    }
    truth = {p.name: list(p.boxes) for p in photos}
    voc, sar = score_voc(preds, truth, rc.THRESHOLD), score_sar(preds, truth, rc.THRESHOLD)
    at = scores_at(preds, truth, rc.THRESHOLD)
    wall = time.perf_counter() - t0

    sides = sorted(min(b.width_px, b.height_px) for p in photos for b in p.boxes)
    ts = run_dir.name
    result = {
        "timestamp": ts,
        "synthetic": args.synthetic,
        "dataset": {
            "name": "LADD (Lacmus Drone Dataset)",
            "root": str(args.data_root),
            "archive_sha256": args.archive_sha256,
            "which": which,
            "photos": len(photos),
            "people": n_people,
            "photos_without_people": sum(1 for p in photos if not p.boxes),
            "median_box_short_side_px": sides[len(sides) // 2] if sides else None,
            "photo_sizes": sorted({f"{p.width}x{p.height}" for p in photos}),
        },
        "model": {"onnx": args.onnx.name, "sha256": sha256(args.onnx)},
        "threshold": rc.THRESHOLD,
        "threshold_source": "frozen on HERIDAL val in sprint 1; not re-chosen",
        "merge_nms_iou": MERGE_NMS_IOU,
        "voc": {k: round(v, 4) for k, v in voc.model_dump().items()},
        "sar": {k: round(v, 4) for k, v in sar.model_dump().items()},
        "counts": {
            "found": at.tp,
            "missed": at.n_truth - at.tp,
            "false_alarms": at.n_pred - at.tp,
            "false_alarms_per_photo": round((at.n_pred - at.tp) / max(1, len(photos)), 3),
        },
        "heridal_reference": {
            "test": HERIDAL_TEST,
            "test_unseen_sites_recall": HERIDAL_UNSEEN_SITES_RECALL,
        },
        "run": {
            "where": where,
            "backend": backend,
            "workers": workers,
            "threads": threads,
            "photos_detected": len(todo),
            "wall_s": round(wall, 1),
            "detect_s": round(detect_s, 1),
            "s_per_photo": round(detect_s / max(1, len(todo)), 3),
            "resumed_from_previous": len(photos) - len(todo),
        },
        "machine": spec,
        "git_commit": git_commit(),
    }
    (run_dir / "ladd.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    (run_dir / "ladd.md").write_text(render_md(result), encoding="utf-8")
    print()
    print(render_md(result))
    print(f"wrote {run_dir / 'ladd.json'} and ladd.md")
    if not args.no_evidence:
        ev = ROOT / "docs/evidence/ladd" / ts
        ev.mkdir(parents=True, exist_ok=True)
        for name in ("ladd.json", "ladd.md"):
            shutil.copy2(run_dir / name, ev / name)
        print(f"copied to {ev}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
