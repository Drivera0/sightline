"""Measure "photos like this crop" on val (docs/report/SIMILAR.md). Val only; never test.

    uv run --env-file .env --extra ml python scripts/eval_similar.py \
        --data-root data/heridal/yolo_full --pt data/weights/release_v2/yolo11s_tiles_run1_best.pt

1. The frozen detector (weights-v2, tiled) runs on the annotated val photos; every detection at
   0.15 or more (the near-miss band and the review queue) is a crop, cut as the live pipeline cuts
   review crops (128 px of the original around the box, 256 px out). A crop is a person when it is
   a VOC true positive (IoU >= 0.5, the verifier eval's ``label_preds``).
2. Every crop is embedded once with the hosted NVIDIA model (``sightline/ml/similar.py``) and cached
   in ``<out>/val-<model>.npz``; reruns make no calls for cached crops.
3. Each person crop is a query (what a reviewer confirms); the others are the gallery, either the
   whole of val or the same flight (HERIDAL site, the photo name's middle part). precision@5 = people
   among the top 5; recall@5 = people in the top 5 / people in the gallery. Rows: image only, text
   only, image + text (mean of the two unit vectors), and two baselines that need no model: random
   (the share of people in the gallery) and the detector's confidence (the 5 most confident others).
4. The threshold for the agent's proposals: precision and coverage of matches at or above each
   similarity, so the rule is picked here, on val.

Writes ``<out>/val-<timestamp>.json`` and, with ``--figure``, a strip of the worst lookalikes.
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

NEAR_MISS = 0.15
K = 5
TEXTS = {
    "person": "a person seen from above in a drone photo",
    "lying": "a person lying on the ground, seen from above",
    "red": "a person in a red jacket",
}
THRESHOLDS = (0.0, 0.8, 0.85, 0.88, 0.9, 0.92, 0.94, 0.95, 0.96, 0.97, 0.98)
QUEUE = 0.29  # the review threshold: below it, a near-miss
LOOSE_IOU = 0.1


def site(photo: str) -> str:
    """HERIDAL's flight/site code: ``train_ZRI_2061`` → ``ZRI``."""
    parts = photo.split("_")
    return parts[1] if len(parts) > 2 else photo


def _calls(stats, items: int, wall_s: float | None, emb) -> dict:
    """One pass's calls: requests, timeouts, tokens, ms per successful request, wall time."""
    ms = list(stats.ms)
    return {
        **stats.as_dict(),
        "items": items,
        "wall_s": None if wall_s is None else round(wall_s, 1),
        "median_ms_per_request": int(np.median(ms)) if ms else None,
        "p90_ms_per_request": int(np.percentile(ms, 90)) if ms else None,
        "batch": emb.batch,
        "min_interval_s": emb.min_interval,
        "timeout_s": emb.timeout,
    }


def retrieval(
    order_for, rows: list[dict], pool_of, k: int = K, key: str = "tp"
) -> dict[str, float | int | None]:
    """Mean precision@k and recall@k over the person queries. ``order_for(q, pool)`` ranks the
    pool (row indices without q) for query row ``q``; ``pool_of(q)`` is the gallery for q."""
    p_at, r_at, p3, n = [], [], [], 0
    for q, r in enumerate(rows):
        if not r["tp"]:
            continue
        pool = [i for i in pool_of(q) if i != q]
        people = sum(rows[i][key] for i in pool)
        if not pool or people == 0:
            continue
        top = order_for(q, pool)[:k]
        hit = sum(rows[i][key] for i in top)
        p_at.append(hit / min(k, len(top)))  # a gallery smaller than k: of what it holds
        p3.append(sum(rows[i][key] for i in top[:3]) / min(3, len(top)))
        r_at.append(hit / people)
        n += 1
    return {
        "precision_at_5": round(float(np.mean(p_at)), 3) if p_at else None,
        "recall_at_5": round(float(np.mean(r_at)), 3) if r_at else None,
        "precision_at_3": round(float(np.mean(p3)), 3) if p3 else None,
        "queries": n,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--data-root", type=Path, default=ROOT / "data/heridal/yolo_full")
    ap.add_argument(
        "--pt", type=Path, default=ROOT / "data/weights/release_v2/yolo11s_tiles_run1_best.pt"
    )
    ap.add_argument("--out", type=Path, default=ROOT / "runs/similar")
    ap.add_argument("--model", default=None, help="embedding model (default: similar.py's)")
    ap.add_argument("--limit", type=int, default=None, help="debug: first N photos")
    ap.add_argument("--figure", type=Path, default=None, help="save the lookalike strip here")
    ap.add_argument(
        "--measure", type=int, default=0, help="re-embed the first N crops to time the endpoint"
    )
    args = ap.parse_args(argv)

    from PIL import Image

    from scripts.eval_verifier import label_preds
    from sightline.ml import similar
    from sightline.ml.crops import crop_window
    from sightline.ml.data import load_split

    args.out.mkdir(parents=True, exist_ok=True)
    images = load_split("val", args.data_root, annotated_only=True)[: args.limit]

    # 1. frozen detector outputs, cached (the detector is deterministic; one pass is enough)
    preds_file = args.out / f"val-preds-{len(images)}.json"
    if preds_file.exists():
        rows = json.loads(preds_file.read_text())
    else:
        from sightline.ml.detect import Detector
        from sightline.ml.evaluate import predict_split

        preds, truth, _ = predict_split(Detector(args.pt), images, "tiled")
        labels = label_preds(preds, truth)
        rows = [
            {
                "id": f"{im.path.stem}#{i}",
                "photo": im.path.stem,
                "path": str(im.path),
                "conf": round(float(d.conf), 4),
                "box": [d.box.x1, d.box.y1, d.box.x2, d.box.y2],
                "tp": bool(labels[im.path.stem][i]),
            }
            for im in images
            for i, d in enumerate(preds[im.path.stem])
            if d.conf >= NEAR_MISS
        ]
        preds_file.write_text(json.dumps(rows))
        n_truth = sum(len(v) for v in truth.values())
        print(f"{len(images)} photos, {n_truth} people, {len(rows)} crops >= {NEAR_MISS}")
    # loose: the crop's box overlaps a labelled person at IoU >= 0.1 (as docs/report/LADD.md). The
    # VOC rule counts a second box on a person, or a box on a group, as false; loose does not.
    from sightline.ml.detect_cv import iou

    truth = {im.path.stem: [(b.x1, b.y1, b.x2, b.y2) for b in im.boxes] for im in images}
    for r in rows:
        r["loose"] = r["tp"] or any(iou(tuple(r["box"]), t) >= LOOSE_IOU for t in truth[r["photo"]])
    n_tp = sum(r["tp"] for r in rows)
    print(f"{len(rows)} crops: {n_tp} people, {len(rows) - n_tp} not", flush=True)

    # 2. embeddings, cached per model
    emb = similar.default_embedder()
    if emb is None:
        print("NVIDIA_API_KEY is not set", file=sys.stderr)
        return 2
    if args.model:
        emb.model = args.model
    cache = args.out / f"val-{emb.model.replace('/', '__')}.npz"
    index = similar.Index.from_bytes(cache.read_bytes()) if cache.exists() else None
    index = index or similar.Index.empty(emb.model)
    todo = [r for r in rows if r["id"] not in set(index.ids)]
    crops: dict[str, Image.Image] = {}

    def crop(r: dict) -> Image.Image:
        if r["id"] not in crops:
            with Image.open(r["path"]) as im:
                crops[r["id"]] = crop_window(im.convert("RGB"), r["box"])
        return crops[r["id"]]

    def jpeg(r: dict) -> bytes:
        buf = io.BytesIO()
        crop(r).save(buf, "JPEG", quality=90)
        return buf.getvalue()

    stamp = time.strftime("%Y%m%d-%H%M%S")
    t0 = time.time()
    for i in range(0, len(todo), 64):  # saved every 64 crops, so a failure loses little
        part = todo[i : i + 64]
        index.add([r["id"] for r in part], emb.embed_images([jpeg(r) for r in part]))
        cache.write_bytes(index.to_bytes())
        print(f"  embedded {i + len(part)}/{len(todo)} ({time.time() - t0:.0f} s)", flush=True)
    calls: dict = {}
    if todo:  # kept on its own, so the cost of the embedding pass survives a later failure
        calls["embedding_pass"] = _calls(emb.stats, len(todo), time.time() - t0, emb)
        (args.out / f"val-calls-{stamp}.json").write_text(json.dumps(calls, indent=2))
    if args.measure:  # latency: re-embed the first N crops (the cache is not touched)
        emb.stats = similar.CallStats()
        t1 = time.time()
        emb.embed_images([jpeg(r) for r in rows[: args.measure]])
        calls["measure"] = _calls(emb.stats, args.measure, time.time() - t1, emb)
        (args.out / f"val-calls-{stamp}.json").write_text(json.dumps(calls, indent=2))
        print(f"  measure: {calls['measure']}", flush=True)
    emb.stats = similar.CallStats()
    text_cache = args.out / f"val-texts-{emb.model.replace('/', '__')}.npz"
    known: dict[str, np.ndarray] = {}
    if text_cache.exists():
        with np.load(text_cache, allow_pickle=False) as z:
            known = {str(t): z["vectors"][i] for i, t in enumerate(z["texts"])}
    texts = {}
    for name, t in TEXTS.items():
        texts[name] = known[t] if t in known else emb.embed_text(t)
        known[t] = texts[name]
    np.savez(text_cache, texts=np.array(list(known)), vectors=np.stack(list(known.values())))
    calls["text_queries"] = _calls(emb.stats, len(TEXTS), None, emb)

    pos = {i: n for n, i in enumerate(index.ids)}
    V = np.stack([index.vectors[pos[r["id"]]] for r in rows])
    S = V @ V.T
    everyone = list(range(len(rows)))
    by_site: dict[str, list[int]] = {}
    for i, r in enumerate(rows):
        by_site.setdefault(site(r["photo"]), []).append(i)

    def flight(q, near_miss=False, other_photos=False):
        return [
            i
            for i in by_site[site(rows[q]["photo"])]
            if (not near_miss or rows[i]["conf"] < QUEUE)
            and (not other_photos or rows[i]["photo"] != rows[q]["photo"])
        ]

    pools = {
        "whole val": lambda q: everyone,
        "same flight": flight,
        "same flight, other photos": lambda q: flight(q, other_photos=True),
        "near-misses, same flight": lambda q: flight(q, near_miss=True),
        "near-misses, same flight, other photos": lambda q: flight(q, True, True),
    }
    rng = np.random.default_rng(7)

    def by_scores(scores):
        def order(q, pool):
            s = scores(q)  # once per query, not once per gallery item
            return sorted(pool, key=lambda i: -s[i])

        return order

    methods = {
        "image": by_scores(lambda q: S[q]),
        **{f"text only ({name})": by_scores(lambda q, t=t: V @ t) for name, t in texts.items()},
        **{
            f"image + text ({name})": by_scores(lambda q, t=t: V @ similar.fuse(V[q], t))
            for name, t in texts.items()
        },
        "baseline: detector confidence": lambda q, pool: sorted(
            pool, key=lambda i: -rows[i]["conf"]
        ),
        "baseline: random": lambda q, pool: list(rng.permutation(pool)),
    }
    table = {
        pool: {m: retrieval(f, rows, pools[pool]) for m, f in methods.items()} for pool in pools
    }
    for pool in ("near-misses, same flight", "near-misses, same flight, other photos"):
        table[f"{pool} (loose label)"] = {
            m: retrieval(f, rows, pools[pool], key="loose") for m, f in methods.items()
        }
    for pool, res in table.items():
        print(f"\n[{pool}]")
        for m, v in res.items():
            print(
                f"  {m:40s} P@5 {v['precision_at_5']}  R@5 {v['recall_at_5']}  "
                f"P@3 {v['precision_at_3']}  n={v['queries']}"
            )

    # 4. thresholds for the agent: what it would propose (top 3 near-misses of the flight at or
    # above t) for each person query, with and without crops from the query's own photo
    sweep = []
    for other_photos in (False, True):
        for t in THRESHOLDS:
            hits = loose = total = with_any = 0
            for q, r in enumerate(rows):
                if not r["tp"]:
                    continue
                pool = [i for i in flight(q, True, other_photos) if i != q]
                top = [i for i in sorted(pool, key=lambda i: -S[q, i])[:3] if S[q, i] >= t]
                hits += sum(rows[i]["tp"] for i in top)
                loose += sum(rows[i]["loose"] for i in top)
                total += len(top)
                with_any += bool(top)
            sweep.append(
                {
                    "other_photos_only": other_photos,
                    "threshold": t,
                    "proposed": total,
                    "precision": round(hits / total, 3) if total else None,
                    "precision_loose": round(loose / total, 3) if total else None,
                    "queries_with_a_proposal": with_any,
                }
            )
    near = [r for r in rows if r["conf"] < QUEUE]
    base = sum(r["tp"] for r in near) / len(near) if near else 0.0
    base_loose = sum(r["loose"] for r in near) / len(near) if near else 0.0
    print(f"\nthreshold sweep (top 3 near-misses at or above t; {len(near)} near-misses, "
          f"{base:.3f} of them people, {base_loose:.3f} with the loose label):")  # fmt: skip
    for s in sweep:
        print(f"  {s}")

    # failure cases: what the agent's rule would propose wrongly (a near-miss from another photo
    # of the flight, at or above the threshold, that is not a person), and, apart, the closest
    # not-person crop anywhere (mostly in the query's own photo, which the rule leaves out)
    def lookalikes(rule: bool) -> list[dict]:
        fails = []
        for q, r in enumerate(rows):
            if not r["tp"]:
                continue
            pool = [i for i in flight(q, True, True) if i != q] if rule else everyone
            for i in sorted(pool, key=lambda i: -S[q, i]):
                if i == q or rows[i]["tp"]:
                    continue
                if not rule or S[q, i] >= similar.DEFAULT_THRESHOLD:
                    fails.append((float(S[q, i]), q, int(i)))
                break
        fails.sort(reverse=True)
        seen: set[int] = set()
        distinct = [f for f in fails if not (f[2] in seen or seen.add(f[2]))]  # each crop once
        return [
            {"query": rows[q]["id"], "lookalike": rows[i]["id"], "score": round(s, 4),
             "lookalike_conf": rows[i]["conf"], "same_photo": rows[q]["photo"] == rows[i]["photo"],
             "loose": rows[i]["loose"]}
            for s, q, i in distinct[:8]
        ]  # fmt: skip

    worst = lookalikes(rule=True)
    worst_anywhere = lookalikes(rule=False)
    if args.figure:
        strip = Image.new("RGB", (2 * 128 + 8, len(worst[:6]) * 136), "white")
        for n, w in enumerate(worst[:6]):
            qr = next(r for r in rows if r["id"] == w["query"])
            lr = next(r for r in rows if r["id"] == w["lookalike"])
            strip.paste(crop(qr).resize((128, 128)), (0, n * 136))
            strip.paste(crop(lr).resize((128, 128)), (136, n * 136))
        args.figure.parent.mkdir(parents=True, exist_ok=True)
        strip.save(args.figure, "JPEG", quality=85)

    sims_pp = [
        S[a, b] for a in range(len(rows)) for b in range(a) if rows[a]["tp"] and rows[b]["tp"]
    ]
    sims_pn = [S[a, b] for a in range(len(rows)) for b in range(len(rows))
               if rows[a]["tp"] and not rows[b]["tp"]]  # fmt: skip
    summary = {
        "split": "val",
        "model": emb.model,
        "photos": len(images),
        "crops": len(rows),
        "people": n_tp,
        "sites": {s: len(v) for s, v in by_site.items()},
        "texts": TEXTS,
        "retrieval": table,
        "threshold_sweep": sweep,
        "near_misses": {
            "crops": len(near),
            "people_share": round(base, 3),
            "people_share_loose": round(base_loose, 3),
        },
        "similarity": {
            "person_person_median": round(float(np.median(sims_pp)), 4) if sims_pp else None,
            "person_other_median": round(float(np.median(sims_pn)), 4) if sims_pn else None,
        },
        "lookalikes_the_rule_would_propose": worst,
        "lookalikes_anywhere": worst_anywhere,
        "calls": calls,
    }
    out = args.out / f"val-{stamp}.json"
    out.write_text(json.dumps(summary, indent=2))
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
