"""Radio desk latency over many turns (E-18, LANE_E §8.6), for the Nebius feedback.

    uv run python scripts/radio_latency.py [--api http://127.0.0.1:8010] [--turns 30]

Drives a running radio server (``uvicorn sightline.radio.dev:app``, real voices or not) the way the desk
does: text turns (so ASR is not in these numbers; Parakeet's 45–153 ms is measured in
``docs/feedback/radio.md``), standby handled by polling. Turns cycle through the demo's questions and a
clue report + "affirmative", five turns per fresh mission so history stays realistic. Per turn: time to
first sound (the reply, or "standby" when the model is slow), time to the answer, model time, whether
standby played, and whether the expected tool ran. Prints p50 / p90 and writes
``runs/radio/latency-<timestamp>.json``. Needs the stdlib only.
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

SCRIPT = [  # (what the team says, the tools an answer may come from, or None)
    ("Sightline, Team Two, say again the sector boundary, over.", {"get_sector_boundary"}),
    ("Sightline, Team Two, what are the conditions, over.", {"get_conditions"}),
    # get_assignment also returns the entry, bearing and distance
    (
        "Sightline, Team Two, where is our entry point, over.",
        {"get_sector_boundary", "get_assignment"},
    ),
    (
        "Sightline, Team Two. Found a blue backpack by the creek, our position, over.",
        {"draft_clue"},
    ),
    ("Affirmative, over.", None),
]


def _post_text(api: str, mission: str, text: str) -> dict:
    b = uuid.uuid4().hex
    body = (
        f'--{b}\r\nContent-Disposition: form-data; name="text"\r\n\r\n{text}\r\n'
        f'--{b}\r\nContent-Disposition: form-data; name="callsign_hint"\r\n\r\nT2\r\n--{b}--\r\n'
    ).encode()
    req = urllib.request.Request(
        f"{api}/missions/{mission}/radio/turn",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={b}"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def turn(api: str, mission: str, text: str) -> dict:
    t0 = time.perf_counter()
    r = _post_text(api, mission, text)
    first = time.perf_counter() - t0
    standby = bool(r.get("standby"))
    while r.get("standby"):
        with urllib.request.urlopen(api + r["poll"], timeout=60) as resp:
            if resp.status == 200:
                r = json.loads(resp.read())
                break
        time.sleep(0.3)
    return {
        "first_sound_s": round(first, 2),
        "answer_s": round(time.perf_counter() - t0, 2),
        "standby": standby,
        "llm_ms": r.get("llm_ms"),
        "state": r.get("state"),
        "actions": [a for a in r.get("actions", []) if not a.startswith("postcheck")],
        "reply": r.get("reply"),
    }


def pct(xs: list[float], q: float) -> float:
    xs = sorted(xs)
    return xs[min(len(xs) - 1, round(q * (len(xs) - 1)))]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--api", default="http://127.0.0.1:8010")
    ap.add_argument("--turns", type=int, default=30)
    ap.add_argument("--out", type=Path, default=ROOT / "runs/radio")
    args = ap.parse_args(argv)

    rows = []
    run = uuid.uuid4().hex[:6]
    for k in range(args.turns):
        text, tool = SCRIPT[k % len(SCRIPT)]
        r = turn(args.api, f"lat{run}{k // len(SCRIPT):02d}", text)
        r["expected_tool"] = sorted(tool) if tool else None
        r["tool_ok"] = bool(tool & set(r["actions"])) if tool else None
        rows.append({"text": text, **r})
        print(f"{k + 1:2d} first {r['first_sound_s']:4.1f} s  answer {r['answer_s']:4.1f} s  "
              f"{'standby ' if r['standby'] else '        '}{r['state']:16s} {r['actions']}", flush=True)  # fmt: skip

    model_turns = [r for r in rows if r["llm_ms"] is not None]
    tools = [r["tool_ok"] for r in rows if r["tool_ok"] is not None]
    summary = {
        "turns": len(rows),
        "first_sound_s": {"p50": pct([r["first_sound_s"] for r in rows], 0.5), "p90": pct([r["first_sound_s"] for r in rows], 0.9)},
        "answer_s": {"p50": pct([r["answer_s"] for r in rows], 0.5), "p90": pct([r["answer_s"] for r in rows], 0.9)},
        "model_s": {
            "p50": pct([r["llm_ms"] / 1000 for r in model_turns], 0.5),
            "p90": pct([r["llm_ms"] / 1000 for r in model_turns], 0.9),
            "mean": round(statistics.mean(r["llm_ms"] / 1000 for r in model_turns), 2),
        },
        "standby_share": round(sum(r["standby"] for r in rows) / len(rows), 2),
        "expected_tool_used": f"{sum(tools)}/{len(tools)}",
    }  # fmt: skip
    args.out.mkdir(parents=True, exist_ok=True)
    out = args.out / f"latency-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps({"summary": summary, "rows": rows}, indent=2))
    s = summary
    print(
        f"\n| Turns | First sound p50 / p90 | Answer p50 / p90 | Model p50 / p90 | Standby | Right tool |\n"
        f"|---|---|---|---|---|---|\n"
        f"| {s['turns']} | {s['first_sound_s']['p50']} / {s['first_sound_s']['p90']} s "
        f"| {s['answer_s']['p50']} / {s['answer_s']['p90']} s | {s['model_s']['p50']} / {s['model_s']['p90']} s "
        f"| {s['standby_share']:.0%} of turns | {s['expected_tool_used']} |\n\nwrote {out}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
