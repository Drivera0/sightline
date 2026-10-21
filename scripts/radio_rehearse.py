"""Rehearse the radio demo script (LANE_E §8.7) against a running radio server, and keep the audio.

    uv run python scripts/radio_rehearse.py [--api http://127.0.0.1:8010] [--runs 5] [--audio [--radio-sound]]

Each run uses a fresh mission id (fresh radio session) and plays the script's three exchanges:

  1. Outbound: transmit the approved "Assign sector B3 to Team Two" briefing.
  2. Question: "Sightline, Team Two, say again the sector boundary, over."
  3. Clue by voice: the blue backpack report → readback → "Affirmative, over." → "Clue logged. Out."

Every step is checked (state, tool, the words the script needs) and timed to first sound, which
must be ≤ 5 s (LANE_E §1). Team lines go in as text, so ASR is not in these numbers. With
``--audio``, each run's Sightline replies are saved as WAVs plus one ``demo.wav`` with short gaps,
under ``runs/radio/rehearsal-<timestamp>/``: the voice track for the Nebius video. ``--radio-sound``
also writes ``run<k>-demo-radio.wav`` with the desk's "radio sound" (300–3400 Hz band-pass and faint
static, as ``web/src/radio/player.ts`` plays it; needs ffmpeg). Stdlib only otherwise.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import time
import urllib.error
import urllib.request
import uuid
import wave
from pathlib import Path

from radio_latency import ROOT, turn

FIRST_SOUND_LIMIT_S = 5.0
BOUNDARY_Q = "Sightline, Team Two, say again the sector boundary, over."
REPORT = "Sightline, Team Two. Found a blue backpack by the creek, our position, over."
AFFIRMATIVE = "Affirmative, over."


def _json(api: str, path: str, method: str = "GET") -> dict | list:
    req = urllib.request.Request(api + path, method=method, data=b"" if method == "POST" else None)
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def transmit(api: str, mission: str) -> dict:
    t0 = time.perf_counter()
    queue = _json(api, f"/missions/{mission}/radio/outbound")
    item = next(o for o in queue if o["target"].get("team") == "T2")
    r = _json(api, f"/missions/{mission}/radio/outbound/{item['id']}/transmit", "POST")
    first = round(time.perf_counter() - t0, 2)
    return {"first_sound_s": first, "answer_s": first, "standby": False, **r}


def check(step: str, r: dict) -> list[str]:
    """What's wrong with this step's reply, if anything (empty list: as scripted)."""
    reply = (r.get("reply") or "").lower()
    want = {
        "transmit": ("transmitted", None, ["bravo three", "two seven zero", "six hundred metres"]),
        "boundary": ("answered", "get_sector_boundary", ["bravo three"]),
        "report": ("awaiting_confirm", "draft_clue", ["blue backpack", "confirm"]),
        "affirmative": ("committed", "post_clue", ["clue logged", "out"]),
    }[step]
    state, tool, words = want
    problems = []
    if r.get("state") != state:
        problems.append(f"state {r.get('state')} (want {state})")
    if tool and tool not in r.get("actions", []):
        problems.append(f"no {tool} in {r.get('actions')}")
    problems += [f"missing '{w}'" for w in words if w not in reply]
    if not reply.startswith("team two, sightline."):
        problems.append("doesn't open with 'Team Two, Sightline.'")
    if step == "affirmative" and not r.get("clue"):
        problems.append("no clue posted")
    if r["first_sound_s"] > FIRST_SOUND_LIMIT_S:
        problems.append(f"first sound {r['first_sound_s']} s > {FIRST_SOUND_LIMIT_S} s")
    return problems


def fetch_wav(api: str, mission: str, audio: str, dest: Path) -> Path | None:
    """The whole reply (``radio/<name>.wav``): written once every sentence is spoken, so retry."""
    url = f"{api}/missions/{mission}/radio/audio/{Path(audio).name}"
    for _ in range(100):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                dest.write_bytes(r.read())
                return dest
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
            time.sleep(0.2)
    return None


def join_wavs(paths: list[Path], out: Path, gap_s: float = 0.8) -> None:
    with wave.open(str(paths[0])) as w:
        params = w.getparams()
    silence = b"\0" * int(params.framerate * gap_s) * params.sampwidth * params.nchannels
    with wave.open(str(out), "wb") as o:
        o.setparams(params)
        for k, p in enumerate(paths):
            with wave.open(str(p)) as w:
                o.writeframes(w.readframes(w.getnframes()))
            if k + 1 < len(paths):
                o.writeframes(silence)


def radio_sound(src: Path, dest: Path) -> None:
    """The desk's radio sound (player.ts radioChain) baked into a file, for the video."""
    band = "highpass=f=300,lowpass=f=3400"
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-i", str(src), "-filter_complex",
         f"[0]{band}[v];anoisesrc=c=white:a=0.015,{band}[n];[v][n]amix=inputs=2:duration=first:normalize=0",
         str(dest)],
        check=True,
    )  # fmt: skip


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--api", default="http://127.0.0.1:8010")
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--audio", action="store_true", help="save each run's replies and a demo.wav")
    ap.add_argument(
        "--radio-sound", action="store_true", help="with --audio: also a radio-sound copy"
    )
    ap.add_argument("--out", type=Path, default=ROOT / "runs/radio")
    args = ap.parse_args(argv)

    out = args.out / f"rehearsal-{time.strftime('%Y%m%d-%H%M%S')}"
    out.mkdir(parents=True, exist_ok=True)
    runs, clean = [], 0
    for k in range(args.runs):
        mission = f"reh{uuid.uuid4().hex[:6]}"
        steps = [
            ("transmit", transmit(args.api, mission)),
            ("boundary", turn(args.api, mission, BOUNDARY_Q)),
            ("report", turn(args.api, mission, REPORT)),
            ("affirmative", turn(args.api, mission, AFFIRMATIVE)),
        ]
        rows = []
        print(f"\nrun {k + 1}")
        for step, r in steps:
            problems = check(step, r)
            rows.append({"step": step, **r, "problems": problems})
            mark = "ok " if not problems else "BAD"
            print(f"  {mark} {step:11s} first {r['first_sound_s']:4.1f} s  {r.get('reply')}")
            for p in problems:
                print(f"      - {p}")
        if args.audio:
            wavs = [
                fetch_wav(args.api, mission, r["audio"], out / f"run{k + 1}-{i}-{r['step']}.wav")
                for i, r in enumerate(rows)
                if r.get("audio")
            ]
            if all(wavs):
                join_wavs(wavs, out / f"run{k + 1}-demo.wav")
                if args.radio_sound:
                    radio_sound(out / f"run{k + 1}-demo.wav", out / f"run{k + 1}-demo-radio.wav")
        clean += not any(r["problems"] for r in rows)
        runs.append({"mission": mission, "steps": rows})

    firsts = [r["first_sound_s"] for run in runs for r in run["steps"]]
    summary = {
        "runs": len(runs),
        "as_scripted": f"{clean}/{len(runs)}",
        "first_sound_max_s": max(firsts),
        "first_sound_mean_s": round(sum(firsts) / len(firsts), 2),
    }
    (out / "rehearsal.json").write_text(json.dumps({"summary": summary, "runs": runs}, indent=2))
    print(
        f"\n{summary['as_scripted']} runs as scripted · first sound mean "
        f"{summary['first_sound_mean_s']} s, max {summary['first_sound_max_s']} s\nwrote {out}"
    )
    return 0 if clean == len(runs) else 1


if __name__ == "__main__":
    raise SystemExit(main())
