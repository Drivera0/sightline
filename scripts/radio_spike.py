"""Radio desk spike (E-R0, LANE_E §8.2, §10): do the NVIDIA speech models run here, and how fast?

Run by lane A for lane E (issue #24). Needs a separate environment with NeMo (it pins its own
torch and Lightning; keep it out of the project's .venv):

    uv venv -p 3.11 ~/radio-env && VIRTUAL_ENV=~/radio-env uv pip install "nemo_toolkit[asr,tts]" openai python-dotenv
    ~/radio-env/bin/python scripts/radio_spike.py [--out runs/radio_spike] [--device cuda]

For three phrases from the radio demo script (LANE_E §8.7): Magpie TTS speaks the phrase,
Parakeet TDT transcribes it back (word error rate against the text), then one inbound turn goes
through Nemotron Nano on Token Factory with a tool call (``get_sector_boundary``) and the reply
is spoken. Prints load times, per-step milliseconds and WER as JSON; writes the WAVs to ``--out``.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

PARAKEET = "nvidia/parakeet-tdt-0.6b-v2"
MAGPIE = "nvidia/magpie_tts_multilingual_357m"
ASR_RATE = 16_000

PHRASES = [
    "Team Two, Sightline. New assignment, sector Bravo Three. Enter from the east ridge. Over.",
    "Sightline, Team Two, say again the sector boundary, over.",
    "Sightline, Team Two. Found a blue backpack by the creek, our position, over.",
]

RADIO_SYSTEM = (  # LANE_E §8.3, shortened
    "You are Sightline, a search-and-rescue assistant on a secondary voice radio channel, under a "
    "human comms operator. Answer field teams briefly in radio style: at most two short "
    'sentences, then "over". Start with the team\'s callsign, then "Sightline". Use only facts '
    "returned by your tools. Never say an area is clear or cleared."
)
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_sector_boundary",
            "description": "Corners of a team's assigned sector, with bearing and distance from the team.",
            "parameters": {
                "type": "object",
                "properties": {"team_id": {"type": "string"}},
                "required": ["team_id"],
            },
        },
    }
]
FAKE_BOUNDARY = {  # what lane E's RadioTools would return; fixed for the spike
    "sector": "B3",
    "corners": [
        "north-west ridge cairn",
        "north-east creek fork",
        "south-east trailhead",
        "south-west boulder field",
    ],
    "bearing_deg_from_team": 270,
    "distance_m_from_team": 600,
}


def words(text: str) -> list[str]:
    return re.sub(r"[^a-z0-9 ]", " ", text.lower()).split()


def wer(ref: str, hyp: str) -> float:
    """Word error rate: word-level edit distance / reference length."""
    r, h = words(ref), words(hyp)
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev, d[j] = d[j], cur
    return d[len(h)] / max(1, len(r))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--out", type=Path, default=ROOT / "runs/radio_spike")
    ap.add_argument("--device", default="cuda")
    args = ap.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)

    import soundfile as sf
    import torch
    from nemo.collections.asr.models import ASRModel
    from nemo.collections.tts.models import MagpieTTSModel
    from scipy.signal import resample_poly

    report: dict = {
        "device": args.device,
        "gpu": torch.cuda.get_device_name(0) if args.device == "cuda" else None,
    }

    t0 = time.perf_counter()
    asr = ASRModel.from_pretrained(PARAKEET).to(args.device).eval()
    report["parakeet_load_s"] = round(time.perf_counter() - t0, 1)
    t0 = time.perf_counter()
    tts = MagpieTTSModel.from_pretrained(MAGPIE).to(args.device).eval()
    report["magpie_load_s"] = round(time.perf_counter() - t0, 1)
    rate = int(getattr(tts, "sample_rate", None) or tts.cfg.sample_rate)
    report["magpie_sample_rate"] = rate

    def speak(text: str, name: str) -> tuple[Path, int, float]:
        t = time.perf_counter()
        with torch.inference_mode():
            audio, audio_len = tts.do_tts(text)
        ms = round((time.perf_counter() - t) * 1000)
        wav = audio[0, : int(audio_len[0])].float().cpu()
        path = args.out / f"{name}.wav"
        sf.write(path, wav.numpy(), rate)
        path16 = args.out / f"{name}.16k.wav"
        sf.write(path16, resample_poly(wav.numpy(), ASR_RATE, rate), ASR_RATE)
        return path16, ms, len(wav) / rate

    def hear(path16: Path) -> tuple[str, int]:
        t = time.perf_counter()
        out = asr.transcribe([str(path16)], verbose=False)
        ms = round((time.perf_counter() - t) * 1000)
        first = out[0]
        return (first.text if hasattr(first, "text") else str(first)), ms

    speak("Radio check.", "warmup")  # first calls compile kernels; not timed
    hear(args.out / "warmup.16k.wav")

    rows = []
    for i, phrase in enumerate(PHRASES, 1):
        wav16, tts_ms, seconds = speak(phrase, f"phrase{i}")
        text, asr_ms = hear(wav16)
        rows.append(
            {
                "phrase": phrase,
                "audio_s": round(seconds, 2),
                "tts_ms": tts_ms,
                "asr_ms": asr_ms,
                "transcript": text,
                "wer": round(wer(phrase, text), 3),
            }
        )
    report["tts_then_asr"] = rows

    # One inbound turn: the team's question (as Parakeet heard it) -> Nemotron with a tool -> speech.
    from dotenv import load_dotenv

    from sightline.agent.llm import (
        MODEL_FAST,
        NO_THINKING,
        assistant_message,
        token_factory_client,
        tool_message,
    )

    load_dotenv(ROOT / ".env")
    client = token_factory_client(extra_body=NO_THINKING)
    question = rows[1]["transcript"]
    messages = [{"role": "system", "content": RADIO_SYSTEM}, {"role": "user", "content": question}]
    t = time.perf_counter()
    first = client.chat(messages, model=MODEL_FAST, tools=TOOLS, temperature=0.2)
    calls = first.tool_calls
    messages += [assistant_message(first)] + [tool_message(c["id"], FAKE_BOUNDARY) for c in calls]
    second = (
        client.chat(messages, model=MODEL_FAST, tools=TOOLS, temperature=0.2) if calls else first
    )
    llm_ms = round((time.perf_counter() - t) * 1000)
    _, reply_tts_ms, reply_s = speak(second.text, "reply")
    report["inbound_turn"] = {
        "question_heard": question,
        "tool_calls": calls,
        "reply": second.text,
        "llm_ms_two_calls": llm_ms,
        "reply_tts_ms": reply_tts_ms,
        "reply_audio_s": round(reply_s, 2),
        "round_trip_ms": rows[1]["asr_ms"] + llm_ms + reply_tts_ms,
    }
    report["gpu_mem_peak_gb"] = (
        round(torch.cuda.max_memory_allocated() / 1e9, 2) if args.device == "cuda" else None
    )
    (args.out / "spike.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
