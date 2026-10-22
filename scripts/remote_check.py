"""Is the deployed API working right now? Run before a demo and before submitting.

    uv run python scripts/remote_check.py --api https://44-227-39-234.sslip.io [--mission <id>]

Checks, against the real deployment: HTTPS and /health (contract 1.2, cv2 backend); CORS for the
Vercel site; a new mission; one real HERIDAL **val** photo through upload → SQS → worker →
``photo.processed`` with candidates, timed; the event stream (SSE) replays that mission's events;
an unknown mission is a 404; with ``--mission``, an earlier mission is still there (data survived a
restart). Exit code 1 on any failure. Uses the agent's real model (a few cents of tokens).

``--read-only`` (the scheduled GitHub check, ``.github/workflows/judging-check.yml``): no writes, no
photo, no tokens spent and no test missions left on the public box: health, CORS, the earlier
mission, its event stream, the 404. Needs no credentials and no HERIDAL data.

The first line printed is the summary (``remote check PASSED 7/7 ...`` or ``remote check FAILED ...``),
then one line per check (also on stderr while it runs).
If the instance runs with a write token, set ``SIGHTLINE_API_TOKEN`` here too: writes send it.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PHOTO = ROOT / "data/heridal/yolo_full/val/images/train_BRK_2048.jpg"  # val only, has DJI metadata
VERCEL = "https://sightline-iota-sandy.vercel.app"


def req(
    url: str,
    method: str = "GET",
    body: bytes | None = None,
    headers: dict | None = None,
    timeout: float = 30,
):
    headers = dict(headers or {})
    token = os.environ.get("SIGHTLINE_API_TOKEN", "").strip()
    if token and method != "GET":
        headers["Authorization"] = f"Bearer {token}"
    r = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--api", required=True)
    ap.add_argument("--mission", help="an earlier mission id that must still exist")
    ap.add_argument("--photo", type=Path, default=PHOTO)
    ap.add_argument(
        "--read-only", action="store_true", help="no writes: health, CORS, --mission, SSE, 404"
    )
    args = ap.parse_args(argv)
    api = args.api.rstrip("/")
    failures: list[str] = []
    state: dict = {"sse": args.mission}
    lines: list[str] = []  # printed after the summary

    def check(name: str, fn) -> None:
        t0 = time.perf_counter()
        try:
            note = fn()
            lines.append(
                f"  ok   {name} ({time.perf_counter() - t0:.1f} s){f': {note}' if note else ''}"
            )
        except Exception as e:  # noqa: BLE001 - every failure is reported, then the next check runs
            failures.append(name)
            lines.append(f"  FAIL {name}: {e or type(e).__name__}")
        print(lines[-1], file=sys.stderr, flush=True)  # progress while it runs

    def health():
        status, _, body = req(f"{api}/health", timeout=15)
        h = json.loads(body)
        assert status == 200 and h["contract_version"] == "1.2" and h["backend"] == "cv2", h
        return json.dumps(h)

    def cors():
        _, headers, _ = req(f"{api}/health", headers={"Origin": VERCEL})
        allowed = {k.lower(): v for k, v in headers.items()}.get("access-control-allow-origin")
        assert allowed == VERCEL, f"the Vercel site can't call the API (allow-origin {allowed!r})"

    def earlier():
        status, _, body = req(f"{api}/missions/{args.mission}/state")
        assert status == 200, f"{args.mission}: HTTP {status}"
        s = json.loads(body)
        done = sum(e["type"] == "photo.processed" for e in s["events"])
        return f"{s['mission']['name']!r} still there, {done} photos processed"

    def create():
        body = json.dumps(
            {"name": "Remote check", "area_name": "HERIDAL val", "lkp": {"lat": 43.5, "lon": 16.4}}
        ).encode()
        status, _, out = req(f"{api}/missions", "POST", body, {"Content-Type": "application/json"})
        assert status == 201, (status, out[:200])
        state["mid"] = state["sse"] = json.loads(out)["mission_id"]
        return state["mid"]

    def photo():
        if not args.photo.is_file():
            raise AssertionError(f"{args.photo} not found (HERIDAL val photos; or use --read-only)")
        b = uuid.uuid4().hex
        data = (
            (
                f'--{b}\r\nContent-Disposition: form-data; name="files"; filename="{args.photo.name}"\r\n'
                "Content-Type: image/jpeg\r\n\r\n"
            ).encode()
            + args.photo.read_bytes()
            + f"\r\n--{b}--\r\n".encode()
        )
        t0 = time.monotonic()
        status, _, out = req(
            f"{api}/missions/{state['mid']}/photos",
            "POST",
            data,
            {"Content-Type": f"multipart/form-data; boundary={b}"},
            120,
        )
        assert status == 202 and json.loads(out)["accepted"] == ["f0001"], (status, out[:300])
        while time.monotonic() - t0 < 120:
            _, _, s = req(f"{api}/missions/{state['mid']}/state")
            done = [e for e in json.loads(s)["events"] if e["type"] == "photo.processed"]
            if done:
                d = done[0]["data"]
                assert d["detector"] == "ok" and d["candidates"] >= 1, d
                return f"{d['candidates']} candidates, {d['total_ms'] / 1000:.1f} s in the worker (cv2.dnn {d['ms']['detect'] / 1000:.1f} s), {time.monotonic() - t0:.1f} s upload to processed"
            time.sleep(1)
        raise AssertionError(
            "not processed within 120 s (is the worker running? see CloudWatch /sightline worker)"
        )

    def sse():
        r = urllib.request.Request(f"{api}/missions/{state['sse']}/events")
        types = []
        with urllib.request.urlopen(r, timeout=20) as resp:
            for line in resp:
                if line.startswith(b"event: "):
                    types.append(line[7:].strip().decode())
                if "photo.processed" in types:
                    break
        return f"{len(types)} events replayed, photo.processed included"

    def unknown():
        status, _, _ = req(f"{api}/missions/deadbeef/state")
        assert status == 404, status

    checks = [("HTTPS + health", health), ("CORS for the Vercel site", cors)]
    if args.mission:
        checks.append(("earlier mission kept", earlier))
    if not args.read_only:
        checks += [("create a mission", create), ("val photo → processed", photo)]
    if not args.read_only or args.mission:
        checks.append(("event stream (SSE)", sse))
    checks.append(("unknown mission → 404", unknown))
    ran = 0
    for name, fn in checks:
        check(name, fn)
        ran += 1
        if failures and name == "HTTPS + health":
            break
    print(summary(api, len(checks), ran, failures, args.read_only))
    print("\n".join(lines))
    return 1 if failures else 0


def summary(api: str, total: int, ran: int, failures: list[str], read_only: bool = False) -> str:
    """The one-line verdict printed first (and the first line of the GitHub issue)."""
    mode = " (read-only)" if read_only else ""
    if not failures:
        return f"remote check PASSED {total}/{total}{mode} against {api}"
    skipped = f", {total - ran} not run" if ran < total else ""
    return (
        f"remote check FAILED {len(failures)}/{total}{mode} against {api}: "
        f"{', '.join(failures)}{skipped}"
    )


if __name__ == "__main__":
    sys.exit(main())
