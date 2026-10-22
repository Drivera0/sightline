"""Evaluate the verifier on val and choose its decision rule (A-V2, LANE_A §5.5). Val only.

    uv run --extra ml python scripts/eval_verifier.py [--split val] [--max-conf 0.5] [--workers 4]

1. The frozen detector (weights-v2, tiled, threshold 0.29) runs on the annotated photos of the
   split. Each detection is labelled true or false positive by VOC matching (IoU >= 0.5, greedy,
   highest confidence first: the same rule as ``score_voc``).
2. Each photo becomes an in-memory mission the way D's pipeline builds one: a 1000×750 display
   frame plus the original at ``frames/orig/``; boxes are scaled to the frame. ``verify()`` runs
   on every near-miss (0.15 <= conf < 0.29) and every queue item below ``--max-conf``, the only
   ones the rules below can change, with Nemotron VL on Token Factory (thinking off).
3. Rules, compared by F2 at the photo-set level: (a) threshold only; (b) (a) + promote near-misses
   the verifier calls ``yes``; (c) (b) + demote ``no`` below t for t in ``DEMOTE_AT``. The rule is
   chosen on val; it is scored once on test separately (``--split test``, after the choice).

Writes ``runs/verifier/<split>-<timestamp>.csv`` (one row per verified detection) and ``.json``
(rules, accuracy, small-crop accuracy, tokens and latency). Needs NEBIUS_API_KEY in the env/.env.

A second verifier (experiment, docs/report/COSMOS_VERIFIER.md): ``--model`` and ``--base-url``
score the same detections with the same prompt on another OpenAI-compatible endpoint, e.g.

    NVIDIA_API_KEY=... uv run --extra ml python scripts/eval_verifier.py --split val \
        --model nvidia/cosmos-reason2-8b --base-url https://integrate.api.nvidia.com/v1 \
        --workers 1 --min-interval 1.6 --out runs/cosmos_verifier

The key for ``--base-url`` comes only from the env var named by ``--api-key-env`` (default
NVIDIA_API_KEY); Token Factory's ``NO_THINKING`` is not sent there. This path is an experiment and
is never used at run time.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

THRESHOLD = 0.29
NEAR_MISS = 0.15
DEMOTE_AT = (0.4, 0.5)
NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"
COSMOS_MODEL = "nvidia/cosmos-reason2-8b"  # GET {NVIDIA_BASE_URL}/models, checked 2026-10-22
FRAME_WH = (1000, 750)
SMALL_PX = 60  # the feedback report's "60 px crops"


def label_preds(preds: dict, truth: dict) -> dict[str, list[bool]]:
    """Per photo, whether each prediction (in its order) is a VOC true positive."""
    from sightline.ml.detect_cv import iou

    out = {}
    for img, dets in preds.items():
        boxes = [(b.x1, b.y1, b.x2, b.y2) for b in truth[img]]
        used: set[int] = set()
        hit = [False] * len(dets)
        for i in sorted(range(len(dets)), key=lambda k: dets[k].conf, reverse=True):
            d = dets[i].box
            best, best_j = 0.5, None
            for j, t in enumerate(boxes):
                v = iou((d.x1, d.y1, d.x2, d.y2), t)
                if j not in used and v >= best:
                    best, best_j = v, j
            if best_j is not None:
                used.add(best_j)
                hit[i] = True
        out[img] = hit
    return out


def scores(rows: list[dict], n_truth: int, keep) -> dict[str, float]:
    tp = sum(1 for r in rows if keep(r) and r["tp"])
    kept = sum(1 for r in rows if keep(r))
    p = tp / kept if kept else 0.0
    r_ = tp / n_truth if n_truth else 0.0
    f2 = 5 * p * r_ / (4 * p + r_) if p + r_ else 0.0
    return {"precision": p, "recall": r_, "f2": f2, "kept": kept, "tp": tp}


def accuracy(done: list[dict]) -> float | None:
    """Share of verified detections where a decided verdict matches the VOC label (``yes`` on a
    true positive, ``no`` on a false one); ``unclear`` counts as wrong."""
    if not done:
        return None
    right = sum((r["person"] == "yes") if r["tp"] else (r["person"] == "no") for r in done)
    return right / len(done)


class Paced:
    """A ``ChatClient`` wrapper that starts calls at least ``min_interval`` seconds apart, across
    threads (hosted trial endpoints limit requests per minute)."""

    def __init__(self, client, min_interval: float, clock=time.monotonic, sleep=time.sleep):
        self._client, self.min_interval = client, min_interval
        self._clock, self._sleep = clock, sleep
        self._lock = threading.Lock()
        self._next = 0.0

    def chat(self, messages, **kwargs):
        with self._lock:
            wait = self._next - self._clock()
            if wait > 0:
                self._sleep(wait)
            self._next = max(self._next, self._clock()) + self.min_interval
        return self._client.chat(messages, **kwargs)


def make_client(base_url: str | None, api_key_env: str, min_interval: float = 0.0):
    """Token Factory with thinking off (the published rows) when ``base_url`` is None; otherwise an
    OpenAI-compatible client on ``base_url`` with the key from env var ``api_key_env``."""
    import os

    from sightline.agent.llm import NO_THINKING, LLMError, TokenFactoryClient, token_factory_client

    if base_url is None:
        client = token_factory_client(extra_body=NO_THINKING)
    else:
        key = os.environ.get(api_key_env)
        if not key:
            raise LLMError(f"{api_key_env} is not set (needed for --base-url {base_url})")
        client = TokenFactoryClient(key, base_url)
    return Paced(client, min_interval) if min_interval > 0 else client


def photo_mission(path: Path, box, conf: float, name: str = "eval"):
    """An in-memory mission holding one photo the way D's pipeline stores it: a 1000×750
    display frame, the original at ``frames/orig/``, and one detection ``f0001-d01`` with
    ``box`` (original pixels) scaled to the frame. Returns ``(store, mission_id)``."""
    import cv2

    from sightline.contract import Detection, Frame, LatLon, Pose, Source
    from tests.agent.fake_store import FakeMissionStore

    orig = cv2.imread(str(path))
    h, w = orig.shape[:2]
    sx, sy = FRAME_WH[0] / w, FRAME_WH[1] / h
    frame_img = cv2.resize(orig, FRAME_WH, interpolation=cv2.INTER_AREA)
    fbox = (
        int(box.x1 * sx),
        int(box.y1 * sy),
        max(int(box.x1 * sx) + 1, round(box.x2 * sx)),
        max(int(box.y1 * sy) + 1, round(box.y2 * sy)),
    )
    store = FakeMissionStore()
    mid = store.create(name, "HERIDAL", LatLon(lat=0, lon=0), "demo").mission_id
    corners = ((0.0, 0.0), (0.001, 0.0), (0.001, -0.001), (0.0, -0.001))
    frame = Frame(
        id="f0001",
        file="frames/f0001.jpg",
        width_px=FRAME_WH[0],
        height_px=FRAME_WH[1],
        flight_index=0,
        source=Source(image=path.name, x0=0, y0=0),
        pose=Pose(lat=0, lon=0, alt_agl_m=None, heading_deg=0, gsd_m=0.02),
        footprint=corners,
        score=0.5,
        rank=1,
        n_candidates=1,
    )
    store.append_frame(mid, frame, cv2.imencode(".jpg", frame_img)[1].tobytes())
    store.put_file(mid, "frames/orig/f0001.jpg", path.read_bytes())
    det = Detection(id="f0001-d01", box_px=fbox, conf=conf, crop=None, lat=0, lon=0, radius_m=10)
    store.append_detections(mid, "f0001", [det], {})
    return store, mid


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--split", default="val", choices=["val", "test"])
    ap.add_argument(
        "--pt", type=Path, default=ROOT / "data/weights/release_v2/yolo11s_tiles_run1_best.pt"
    )
    ap.add_argument("--prompt", default=None, help="prompt version (default: verify.py's)")
    ap.add_argument("--max-conf", type=float, default=max(DEMOTE_AT))
    ap.add_argument("--workers", type=int, default=4, help="concurrent model calls (LANE_A: 4)")
    ap.add_argument("--limit", type=int, default=None, help="debug: first N photos")
    ap.add_argument("--out", type=Path, default=ROOT / "runs/verifier")
    ap.add_argument("--data-root", type=Path, default=ROOT / "data/heridal/yolo_full")
    ap.add_argument("--model", default=None, help="VL model id (default: verify.py's, Nemotron VL)")
    ap.add_argument(
        "--base-url",
        default=None,
        help="another OpenAI-compatible endpoint (default: Token Factory)",
    )
    ap.add_argument(
        "--api-key-env", default="NVIDIA_API_KEY", help="env var with the --base-url key"
    )
    ap.add_argument(
        "--min-interval", type=float, default=0.0, help="seconds between call starts (rate limits)"
    )
    ap.add_argument(
        "--price-in", type=float, default=None, help="price per million input tokens, for cost"
    )
    ap.add_argument("--price-out", type=float, default=None, help="price per million output tokens")
    args = ap.parse_args(argv)

    from dotenv import load_dotenv

    from sightline.agent import prompts
    from sightline.agent.llm import MODEL_VISION
    from sightline.agent.verify import verify
    from sightline.ml.backend import make_detector
    from sightline.ml.data import load_split
    from sightline.ml.detect import Detector
    from sightline.ml.evaluate import predict_split

    load_dotenv(ROOT / ".env")
    prompt = args.prompt or prompts.VERIFY_VERSION
    model = args.model or MODEL_VISION
    client = make_client(args.base_url, args.api_key_env, args.min_interval)
    # Annotated val photos (as the threshold was chosen); the full test split (as it is scored).
    images = load_split(args.split, args.data_root, annotated_only=args.split == "val")
    images = images[: args.limit]
    preds, truth, _ = predict_split(Detector(args.pt), images, "tiled")
    labels = label_preds(preds, truth)
    n_truth = sum(len(v) for v in truth.values())
    print(f"[{args.split}] {len(images)} photos, {n_truth} people", flush=True)

    rows: list[dict] = []
    for im in images:
        for i, d in enumerate(preds[im.path.stem]):
            if d.conf >= NEAR_MISS:
                rows.append(
                    {
                        "photo": im.path.stem,
                        "path": im.path,
                        "index": i,
                        "conf": d.conf,
                        "box": d.box,
                        "tp": labels[im.path.stem][i],
                        "long_px": max(d.box.width_px, d.box.height_px),
                        "verify": d.conf < args.max_conf,
                    }
                )
    todo = [r for r in rows if r["verify"]]
    print(f"{len(rows)} detections >= {NEAR_MISS}; verifying {len(todo)}", flush=True)

    local = threading.local()

    def detector():
        if not hasattr(local, "det"):  # cv2.dnn nets are not shared across threads
            local.det = make_detector(weights=args.pt, backend="cv2")
        return local.det

    def run(r: dict) -> None:
        store, mid = photo_mission(r["path"], r["box"], r["conf"])
        v = verify(store, mid, "f0001-d01", client, detector(), model=model, prompt=prompt)
        calls = [e for e in store.trace_entries(mid) if e.kind == "model_call"]
        r.update(
            person=v.person,
            posture=v.posture,
            group_size=v.group_size,
            tools="+".join(v.tools),
            reason=v.reason,
            ms=v.ms,
            model_ms=sum(e.ms or 0 for e in calls),
            tokens_in=sum(e.tokens_in or 0 for e in calls),
            tokens_out=sum(e.tokens_out or 0 for e in calls),
            calls=len(calls),
            failed=v.reason.startswith("No second look"),
        )

    t0 = time.time()
    with ThreadPoolExecutor(args.workers) as pool:
        for n, _ in enumerate(pool.map(run, todo), 1):
            if n % 20 == 0:
                print(f"  {n}/{len(todo)} ({time.time() - t0:.0f} s)", flush=True)

    def promoted(r):
        return r["conf"] >= THRESHOLD or r.get("person") == "yes"

    rules = {"a: threshold only": scores(rows, n_truth, lambda r: r["conf"] >= THRESHOLD)}
    rules["b: + promote near-miss yes"] = scores(rows, n_truth, promoted)
    for t in DEMOTE_AT:
        rules[f"c: b + demote no below {t}"] = scores(
            rows,
            n_truth,
            lambda r, t=t: promoted(r) and not (r.get("person") == "no" and r["conf"] < t),
        )

    def acc(sub: list[dict]) -> dict:
        n = len(sub)
        pos = [r for r in sub if r["tp"]]
        neg = [r for r in sub if not r["tp"]]
        return {
            "n": n,
            "people_called_yes": sum(r["person"] == "yes" for r in pos) / len(pos) if pos else None,
            "false_called_no": sum(r["person"] == "no" for r in neg) / len(neg) if neg else None,
            "unclear": sum(r["person"] == "unclear" for r in sub) / n if n else None,
            "n_people": len(pos),
            "n_false": len(neg),
        }

    done = [r for r in todo if "person" in r]
    tin = sum(r["tokens_in"] for r in done)
    tout = sum(r["tokens_out"] for r in done)
    cost = None
    if args.price_in is not None and args.price_out is not None:
        cost = (tin * args.price_in + tout * args.price_out) / 1e6
    summary = {
        "split": args.split,
        "prompt": prompt,
        "model": model,
        "base_url": args.base_url or "token-factory",
        "accuracy": accuracy(done),
        "yes_rate": sum(r["person"] == "yes" for r in done) / len(done) if done else None,
        "no_second_look": sum(r["failed"] for r in done),
        "p90_model_ms": sorted(r["model_ms"] for r in done)[int(len(done) * 0.9)] if done else None,
        "cost_total": cost,
        "photos": len(images),
        "people": n_truth,
        "verified": len(done),
        "rules": rules,
        "near_miss": acc([r for r in done if r["conf"] < THRESHOLD]),
        "queue_below_max_conf": acc([r for r in done if r["conf"] >= THRESHOLD]),
        "small_under_60px": acc([r for r in done if r["long_px"] < SMALL_PX]),
        "median_ms": sorted(r["ms"] for r in done)[len(done) // 2] if done else None,
        "median_model_ms": sorted(r["model_ms"] for r in done)[len(done) // 2] if done else None,
        "tokens_in_mean": sum(r["tokens_in"] for r in done) / len(done) if done else None,
        "tokens_out_mean": sum(r["tokens_out"] for r in done) / len(done) if done else None,
        "retries": sum(r["calls"] - 1 for r in done if r["calls"] > 1),
    }
    args.out.mkdir(parents=True, exist_ok=True)
    tag = "" if args.model is None else "-" + model.rsplit("/", 1)[-1]
    stem = args.out / f"{args.split}-{prompt}{tag}-{time.strftime('%Y%m%d-%H%M%S')}"
    fields = ["photo", "index", "conf", "tp", "long_px", "person", "posture", "group_size"]
    fields += ["tools", "ms", "model_ms", "tokens_in", "tokens_out", "calls", "reason"]
    with open(f"{stem}.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(done)
    Path(f"{stem}.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    print(f"wrote {stem}.csv / .json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
