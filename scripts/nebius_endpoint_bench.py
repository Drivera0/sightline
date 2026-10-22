"""Latency and throughput of the detector endpoint (deploy/nebius/ENDPOINT.md).

    python scripts/nebius_endpoint_bench.py URL PHOTO_DIR [--n 50] [--concurrency 4] [--out DIR]
        [--label NAME] [--price-per-hour 0.264] [--cold-since EPOCH_S]

The token comes from ``SIGHTLINE_DETECT_TOKEN`` (never a flag, so it stays out of shell history
and the saved run). Steps:

1. **first request**: one ``POST /detect`` timed on its own. With ``--cold-since`` (the epoch
   second you ran ``endpoint create`` or ``start``), it also polls ``/healthz`` until it answers and
   records create/start → first healthy answer → first detection.
2. **warm**: ``--n`` requests one after another over the first ``--n`` photos of ``PHOTO_DIR``
   (sorted, cycled if fewer): client wall time per request (upload + detection + download) and the
   server's own ``timing_ms.detect``; p50 / p90 / max.
3. **concurrent**: the same photos with ``--concurrency`` requests in flight; photos per second.
4. **cost per 1,000 photos** from ``--price-per-hour`` (the VM's list price; the endpoint bills
   while it runs, not per request): 1000 / throughput × price / 3600.

Writes ``OUT/<label>.json`` (every number plus each request's timings) and prints a summary.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

import httpx

SUFFIXES = {".jpg", ".jpeg", ".png"}


def pct(values: list[float], q: float) -> float:
    """Nearest-rank percentile (q in 0..100)."""
    s = sorted(values)
    return s[max(0, min(len(s) - 1, round(q / 100 * len(s) + 0.5) - 1))]


def summarize(ms: list[float]) -> dict:
    return {
        "n": len(ms),
        "p50_ms": round(pct(ms, 50), 1),
        "p90_ms": round(pct(ms, 90), 1),
        "max_ms": round(max(ms), 1),
        "mean_ms": round(statistics.fmean(ms), 1),
    }


def post(client: httpx.Client, url: str, photo: Path, headers: dict) -> dict:
    t0 = time.perf_counter()
    r = client.post(
        f"{url}/detect", files={"photo": (photo.name, photo.read_bytes())}, headers=headers
    )
    wall = (time.perf_counter() - t0) * 1000
    r.raise_for_status()
    body = r.json()
    return {
        "photo": photo.name,
        "wall_ms": round(wall, 1),
        "server_ms": body["timing_ms"],
        "boxes": len(body["boxes"]),
        "candidates": body["n_candidates"],
        "size": [body["width"], body["height"]],
    }


def wait_healthy(client: httpx.Client, url: str, headers: dict, limit_s: float = 1800) -> float:
    """Poll /healthz until it answers 200 with status ok; epoch seconds of that answer."""
    end = time.time() + limit_s
    while time.time() < end:
        try:
            r = client.get(f"{url}/healthz", headers=headers, timeout=10)
            if r.status_code == 200 and r.json().get("status") == "ok":
                return time.time()
        except (httpx.HTTPError, ValueError):
            pass
        time.sleep(2)
    raise TimeoutError(f"{url}/healthz not healthy within {limit_s} s")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("url")
    ap.add_argument("photo_dir", type=Path)
    ap.add_argument("--n", type=int, default=50)
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--concurrent-n", type=int, default=None, help="default: --n")
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--label", default="run")
    ap.add_argument("--price-per-hour", type=float, default=None, help="VM list price, USD/h")
    ap.add_argument("--cold-since", type=float, default=None, help="epoch s of create/start")
    ap.add_argument("--skip-warm", action="store_true", help="only the first request")
    args = ap.parse_args(argv)

    url = args.url.rstrip("/")
    token = os.environ.get("SIGHTLINE_DETECT_TOKEN")
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    photos = sorted(p for p in args.photo_dir.iterdir() if p.suffix.lower() in SUFFIXES)
    if not photos:
        raise SystemExit(f"no photos in {args.photo_dir}")
    batch = [photos[i % len(photos)] for i in range(args.n)]
    client = httpx.Client(timeout=600)
    doc: dict = {
        "url_host": httpx.URL(url).host,
        "label": args.label,
        "started_utc": datetime.now(UTC).isoformat(timespec="seconds"),
        "photo_dir": str(args.photo_dir),
        "photos_available": len(photos),
    }

    if args.cold_since is not None:
        healthy = wait_healthy(client, url, headers)
        doc["cold"] = {"create_or_start_to_healthy_s": round(healthy - args.cold_since, 1)}
    first = post(client, url, batch[0], headers)
    doc["first_request"] = first
    if args.cold_since is not None:
        doc["cold"]["create_or_start_to_first_detection_s"] = round(
            time.time() - args.cold_since, 1
        )
    doc["health"] = client.get(f"{url}/healthz", headers=headers).json()
    print(json.dumps({"first_request": first, "cold": doc.get("cold")}))

    if not args.skip_warm:
        warm = [post(client, url, p, headers) for p in batch]
        doc["warm"] = summarize([r["wall_ms"] for r in warm])
        doc["warm_server_detect"] = summarize([r["server_ms"]["detect"] for r in warm])
        doc["warm_requests"] = warm

        cbatch = batch[: args.concurrent_n] if args.concurrent_n else batch
        t0 = time.perf_counter()
        with ThreadPoolExecutor(args.concurrency) as pool:
            conc = list(pool.map(lambda p: post(client, url, p, headers), cbatch))
        wall = time.perf_counter() - t0
        doc["concurrent"] = {
            "concurrency": args.concurrency,
            **summarize([r["wall_ms"] for r in conc]),
            "wall_s": round(wall, 2),
            "photos_per_s": round(len(conc) / wall, 3),
        }
        if args.price_per_hour:
            pps = max(doc["concurrent"]["photos_per_s"], 1000 / doc["warm"]["mean_ms"])
            doc["cost"] = {
                "price_per_hour_usd": args.price_per_hour,
                "photos_per_s_used": round(pps, 3),
                "usd_per_1000_photos": round(1000 / pps * args.price_per_hour / 3600, 4),
                "note": "VM list price while it runs, at the best measured throughput; idle time not included",
            }
        print(
            json.dumps(
                {k: doc.get(k) for k in ("warm", "warm_server_detect", "concurrent", "cost")}
            )
        )

    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / f"{args.label}.json").write_text(json.dumps(doc, indent=1) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
