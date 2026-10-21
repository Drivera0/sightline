"""Parakeet's word error rate on radio phrases (E-18, LANE_E §8.6), for the Nebius feedback.

    ~/radio-env/bin/python scripts/radio_wer.py [--recordings data/radio/wer] [--synthetic]

Recordings: ``<dir>/<voice>/<nn>.wav`` (and ``<nn>.radio.wav`` with the radio-sound filter), ``nn`` the
1-based line of ``tests/radio/phrases.txt``; any sample rate (resampled to 16 kHz). Record with the radio
desk's push-to-talk or any recorder, 3 voices or more. ``--synthetic`` speaks the phrases with Magpie's
speakers instead: a **synthetic baseline**, labelled so, until the human recordings exist.

Per condition (voice, plain or radio sound): WER after ``normalize`` (number words and digits count as the
same; "Team Two" = "Team 2"), and the **coordinate exact-match rate**: of the phrases that contain a
coordinate, the share where ``normalize`` of the transcript yields exactly the right numbers. Writes
``runs/radio/wer-<timestamp>.json`` and prints a Markdown table.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sightline.radio.protocol import normalize

PHRASES = ROOT / "tests/radio/phrases.txt"
_NUM = re.compile(r"-?\d+\.\d+")


def phrases() -> list[str]:
    return [p for p in PHRASES.read_text().splitlines() if p.strip() and not p.startswith("#")]


def wer(ref: str, hyp: str) -> float:
    """Word error rate after ``normalize`` on both sides."""
    r, h = normalize(ref).split(), normalize(hyp).split()
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev, d[j] = d[j], cur
    return d[len(h)] / max(1, len(r))


def coordinates(text: str) -> list[float]:
    return [float(x) for x in _NUM.findall(normalize(text))]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--recordings", type=Path, default=ROOT / "data/radio/wer")
    ap.add_argument("--synthetic", action="store_true", help="Magpie voices instead of recordings")
    ap.add_argument(
        "--voices", type=int, nargs="+", default=[0, 1, 2], help="Magpie speakers for --synthetic"
    )
    ap.add_argument("--out", type=Path, default=ROOT / "runs/radio")
    args = ap.parse_args(argv)

    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly

    from sightline.radio.asr import ParakeetAsr

    lines = phrases()
    asr = ParakeetAsr()
    tmp = Path(tempfile.mkdtemp())
    clips: list[tuple[str, int, np.ndarray, int]] = []  # condition, phrase index, samples, rate
    if args.synthetic:
        import torch
        from nemo.collections.tts.models import MagpieTTSModel

        tts = (
            MagpieTTSModel.from_pretrained("nvidia/magpie_tts_multilingual_357m")
            .to(asr.device)
            .eval()
        )
        rate = int(getattr(tts, "sample_rate", None) or tts.cfg.sample_rate)
        for v in args.voices:
            for i, p in enumerate(lines):
                with torch.inference_mode():
                    a, n = tts.do_tts(p, speaker_index=v)
                clips.append(
                    (
                        f"magpie speaker {v} (synthetic)",
                        i,
                        a[0, : int(n[0])].float().cpu().numpy(),
                        rate,
                    )
                )
    else:
        for f in sorted(args.recordings.glob("*/*.wav")):
            m = re.fullmatch(r"(\d+)(\.radio)?", f.stem)
            if not m:
                continue
            x, rate = sf.read(f, dtype="float32", always_2d=True)
            cond = f"{f.parent.name}{' + radio sound' if m.group(2) else ''}"
            clips.append((cond, int(m.group(1)) - 1, x.mean(axis=1), rate))
        if not clips:
            ap.error(f"no recordings in {args.recordings}/<voice>/<nn>.wav (or use --synthetic)")

    rows = []
    for cond, i, x, rate in clips:
        path = tmp / "clip.wav"
        sf.write(path, resample_poly(x, 16_000, rate) if rate != 16_000 else x, 16_000)
        heard = asr.transcribe(path).text
        ref_coords = coordinates(lines[i])
        rows.append(
            {
                "condition": cond,
                "phrase": i + 1,
                "ref": lines[i],
                "heard": heard,
                "wer": round(wer(lines[i], heard), 3),
                "has_coordinate": bool(ref_coords),
                "coordinate_exact": coordinates(heard) == ref_coords if ref_coords else None,
            }
        )

    summary = {}
    for cond in dict.fromkeys(r["condition"] for r in rows):
        rs = [r for r in rows if r["condition"] == cond]
        coord = [r["coordinate_exact"] for r in rs if r["has_coordinate"]]
        summary[cond] = {
            "phrases": len(rs),
            "wer": round(sum(r["wer"] for r in rs) / len(rs), 3),
            "coordinate_exact": f"{sum(coord)}/{len(coord)}" if coord else "–",
        }
    args.out.mkdir(parents=True, exist_ok=True)
    out = args.out / f"wer-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps({"summary": summary, "rows": rows}, indent=2))
    print(
        "| Condition | Phrases | WER (normalised) | Coordinates exactly right |\n|---|---|---|---|"
    )
    for cond, s in summary.items():
        print(f"| {cond} | {s['phrases']} | {s['wer']:.3f} | {s['coordinate_exact']} |")
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
