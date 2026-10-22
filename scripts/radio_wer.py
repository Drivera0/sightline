"""Parakeet's word error rate on the 20 radio phrases (E-18, issue #49), for the Nebius feedback.

    ~/radio-env/bin/python scripts/radio_wer.py                 # data/radio_wer/<voice>/01.m4a … 20.m4a
    ~/radio-env/bin/python scripts/radio_wer.py --one-file      # data/radio_wer/<voice>/<any>.m4a, all 20 with pauses
    uv run python scripts/radio_wer.py --dry-run                # no NeMo: mock transcripts, checks the pipeline
    ~/radio-env/bin/python scripts/radio_wer.py --boost         # phrase boosting off vs on, runs/radio_wer/<ts>-boost/
    uv run --no-project --with nvidia-riva-client --env-file .env python scripts/radio_wer.py --riva --boost
                                                                # the same on hosted Parakeet (build.nvidia.com)

Recordings: one folder per voice under ``--recordings`` (default ``data/radio_wer``). Either one file
per phrase, ``<nn>.<ext>`` with ``nn`` the 1-based line of ``tests/radio/phrases.txt`` (01 … 20), or,
with ``--one-file``, one file per voice reading all 20 in order with a pause (about a second) between
phrases; it is split on silence with ffmpeg's ``silencedetect`` (``--silence-db``, ``--min-silence``;
the 19 longest pauses become the boundaries). ``<nn>.radio.<ext>`` (or ``<any>.radio.<ext>``) is the
same voice through the radio-sound filter, reported as its own condition. Any format ffmpeg reads
(m4a, mp3, wav, webm, ogg, flac); each clip goes through the radio desk's own ``to_mono16k`` (16 kHz
mono WAV, in a temp dir) and ``ParakeetAsr``, the path ``serve --radio real`` uses. Needs ffmpeg and
the NeMo env (``docs/feedback/radio.md``, "How to reproduce"). ``--synthetic`` speaks the phrases with
Magpie's speakers instead: a **synthetic baseline**, labelled so. ``--dry-run`` needs neither NeMo nor
recordings (mock transcripts, labelled MOCK): it checks the pipeline and the report, nothing else.

WER is word level, after ``protocol.normalize`` on both sides, the normalisation the radio desk applies
before it matches callsigns and replies (number words and digits count as the same, "Team Two" = "Team
2", "Sight line" = "Sightline"). Per voice and overall it is pooled: word errors / reference words.
Also the **coordinate exact-match rate**: of the phrases with a coordinate, the share where the
transcript yields exactly the right numbers. "Raw" WER and coordinates are the same without
``normalize``'s repair of Parakeet's "niner" ("49er", "nine or"). ``--boost`` transcribes every clip
with phrase boosting off and on (``sightline.radio.asr.RADIO_BOOST``) and reports both side by side,
with the time per clip, in ``runs/radio_wer/<timestamp>-boost/``. Writes ``runs/radio_wer/<timestamp>/wer.md`` (tables, the
five worst phrases with their transcripts) and ``wer.json`` next to it.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import wave
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sightline.radio.protocol import normalize

PHRASES = ROOT / "tests/radio/phrases.txt"
RECORDINGS = ROOT / "data/radio_wer"
OUT = ROOT / "runs/radio_wer"
AUDIO = {".m4a", ".mp3", ".wav", ".webm", ".ogg", ".opus", ".flac", ".aac", ".mp4", ".mov"}
PAD_S = 0.15  # kept either side of a phrase cut from a one-file recording
_NUM = re.compile(r"-?\d+\.\d+")
_FFMPEG_TIME = re.compile(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)")


def phrases() -> list[str]:
    return [p for p in PHRASES.read_text().splitlines() if p.strip() and not p.startswith("#")]


def edits(ref: str, hyp: str, niner_fix: bool = True) -> tuple[int, int]:
    """(word errors, reference words) after ``normalize`` on both sides: Levenshtein over words.
    ``niner_fix=False`` leaves Parakeet's "49er" and "nine or" as heard (the "raw" WER)."""
    r, h = normalize(ref).split(), normalize(hyp, niner_fix=niner_fix).split()
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev, d[j] = d[j], cur
    return d[len(h)], len(r)


def wer(ref: str, hyp: str) -> float:
    """Word error rate after ``normalize`` on both sides."""
    errors, words = edits(ref, hyp)
    return errors / max(1, words)


def coordinates(text: str, niner_fix: bool = True) -> list[float]:
    return [float(x) for x in _NUM.findall(normalize(text, niner_fix=niner_fix))]


# --- recordings ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class Clip:
    condition: str  # the voice, plus " + radio sound" for the filtered take
    phrase: int  # 0-based line of phrases.txt
    wav: Path  # 16 kHz mono (in dry-run without recordings: a name only)

    @property
    def key(self) -> str:
        return clip_key(self.condition, self.phrase)


def clip_key(condition: str, phrase: int) -> str:
    """A file-name-safe id for one clip; its WAV is ``<key>.wav`` (``FakeAsr`` keys on the stem)."""
    return f"{re.sub(r'[^A-Za-z0-9]+', '_', condition)}__{phrase + 1:02d}"


def _condition(voice: str, name: str) -> tuple[str, str]:
    """(condition, stem without ``.radio``) for ``name`` in voice folder ``voice``."""
    stem = name.rsplit(".", 1)[0]
    if stem.endswith(".radio"):
        return f"{voice} + radio sound", stem[: -len(".radio")]
    return voice, stem


def recordings(root: Path, one_file: bool, n: int) -> dict[str, list[tuple[int | None, Path]]]:
    """condition → [(0-based phrase or None for a one-file take, path)], in name order."""
    found: dict[str, list[tuple[int | None, Path]]] = {}
    for voice in sorted(p for p in root.iterdir() if p.is_dir()) if root.is_dir() else []:
        for f in sorted(voice.iterdir()):
            if f.suffix.lower() not in AUDIO or not f.is_file():
                continue
            cond, stem = _condition(voice.name, f.name)
            if one_file:
                found.setdefault(cond, []).append((None, f))
            elif re.fullmatch(r"\d{1,2}", stem) and 1 <= int(stem) <= n:
                found.setdefault(cond, []).append((int(stem) - 1, f))
    if one_file:
        for cond, files in found.items():
            if len(files) > 1:
                names = ", ".join(f.name for _, f in files)
                raise ValueError(f"{cond}: --one-file wants one recording per voice, found {names}")
    return found


def ffmpeg() -> str:
    path = shutil.which("ffmpeg")
    if path is None:
        raise SystemExit("ffmpeg is not installed (sudo apt install ffmpeg)")
    return path


def parse_silencedetect(stderr: str) -> tuple[list[tuple[float, float]], float]:
    """(silences as (start, end) seconds, duration) from ffmpeg's ``silencedetect`` log. A silence
    still open at the end of the file ends at the duration."""
    m = _FFMPEG_TIME.search(stderr)
    duration = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else 0.0
    out: list[tuple[float, float]] = []
    start: float | None = None
    for kind, value in re.findall(r"silence_(start|end): (-?\d+(?:\.\d+)?)", stderr):
        if kind == "start":
            start = max(0.0, float(value))
        elif start is not None:
            out.append((start, float(value)))
            start = None
    if start is not None:
        out.append((start, max(duration, start)))
    return out, max([duration, *(e for _, e in out)])


def speech_segments(
    silences: list[tuple[float, float]], duration: float, n: int
) -> list[tuple[float, float]]:
    """``n`` phrases between the ``n - 1`` longest pauses, leading and trailing silence trimmed."""
    eps = 0.05
    head = next((e for s, e in silences if s <= eps), 0.0)
    tail = next((s for s, e in silences if e >= duration - eps and s > head), duration)
    gaps = [(s, e) for s, e in silences if s > head + eps and e < tail - eps]
    if len(gaps) < n - 1:
        raise ValueError(
            f"found {len(gaps) + 1} phrases, expected {n}: pauses too short or too loud "
            "(try a lower --min-silence or a higher --silence-db, e.g. -30)"
        )
    cuts = sorted(sorted(gaps, key=lambda g: g[1] - g[0], reverse=True)[: n - 1])
    starts = [head, *(e for _, e in cuts)]
    ends = [*(s for s, _ in cuts), tail]
    return [
        (max(0.0, a - PAD_S), min(duration, b + PAD_S)) for a, b in zip(starts, ends, strict=True)
    ]


def silences(
    wav: Path, noise_db: float, min_silence: float
) -> tuple[list[tuple[float, float]], float]:
    r = subprocess.run(
        [
            ffmpeg(),
            "-nostdin",
            "-hide_banner",
            "-i",
            str(wav),
            "-af",
            f"silencedetect=n={noise_db}dB:d={min_silence}",
            "-f",
            "null",
            "-",
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if r.returncode != 0:
        raise ValueError(f"silencedetect failed on {wav.name}: {r.stderr.strip()[-200:]}")
    return parse_silencedetect(r.stderr)


def cut(src: Path, start: float, end: float, dst: Path) -> Path:
    with wave.open(str(src)) as w:
        params, rate = w.getparams(), w.getframerate()
        w.setpos(round(start * rate))
        frames = w.readframes(round((end - start) * rate))
    with wave.open(str(dst), "wb") as out:
        out.setparams(params)
        out.writeframes(frames)
    return dst


def to_wav(src: Path, work: Path, name: str) -> Path:
    """``src`` (any ffmpeg format) as a 16 kHz mono WAV, through the radio desk's own converter."""
    from sightline.radio.audio import to_mono16k

    ffmpeg()
    wav = to_mono16k(src.read_bytes(), "", work)
    return wav.rename(work / f"{name}.wav")


def clips_from_recordings(
    found: dict[str, list[tuple[int | None, Path]]],
    work: Path,
    n: int,
    noise_db: float,
    min_silence: float,
) -> list[Clip]:
    out: list[Clip] = []
    for cond, files in found.items():
        for phrase, path in files:
            if phrase is not None:
                out.append(Clip(cond, phrase, to_wav(path, work, clip_key(cond, phrase))))
                continue
            whole = to_wav(path, work, f"{clip_key(cond, 0)}_whole")
            spans = speech_segments(*silences(whole, noise_db, min_silence), n)
            print(f"{cond}: {path.name} split into {n} phrases", file=sys.stderr)
            for i, (a, b) in enumerate(spans):
                out.append(Clip(cond, i, cut(whole, a, b, work / f"{clip_key(cond, i)}.wav")))
    return out


def synthetic_clips(lines: list[str], voices: list[int], device: str, work: Path) -> list[Clip]:
    """Magpie's speakers reading the phrases: a labelled baseline until human recordings exist."""
    import soundfile as sf
    import torch
    from nemo.collections.tts.models import MagpieTTSModel
    from scipy.signal import resample_poly

    tts = MagpieTTSModel.from_pretrained("nvidia/magpie_tts_multilingual_357m").to(device).eval()
    rate = int(getattr(tts, "sample_rate", None) or tts.cfg.sample_rate)
    out = []
    for v in voices:
        for i, p in enumerate(lines):
            with torch.inference_mode():
                a, n = tts.do_tts(p, speaker_index=v)
            x = a[0, : int(n[0])].float().cpu().numpy()
            cond = f"magpie speaker {v} (synthetic)"
            path = work / f"{clip_key(cond, i)}.wav"
            sf.write(path, resample_poly(x, 16_000, rate) if rate != 16_000 else x, 16_000)
            out.append(Clip(cond, i, path))
    return out


# --- dry run ------------------------------------------------------------------------------------

MOCK_VOICES = ("mock voice A", "mock voice B", "mock voice C")


def mock_transcript(ref: str, voice: int, phrase: int, boosted: bool = False) -> str:
    """Parakeet-like output with a few deterministic errors: digits for number words (which
    ``normalize`` forgives), "niner" as "nine or" unless ``boosted``, a dropped word now and then,
    "Sight line" split, a misheard word."""
    digits = {"one": "1", "two": "2", "three": "3", "four": "4", "zero": "0"}
    digits["niner"] = "niner" if boosted else "nine or"
    words = [digits.get(w.lower().strip(",."), w) for w in ref.split()]
    k = voice + phrase
    if k % 5 == 0 and len(words) > 3:
        del words[len(words) // 2]
    if k % 7 == 3:
        words[0] = "Sight line,"
    if k % 6 == 1 and len(words) > 2:
        words[1] = "Teem"
    return " ".join(words)


# --- report -------------------------------------------------------------------------------------


def score(
    clips: list[Clip], heard: dict[str, str], lines: list[str], ms: dict[str, int] | None = None
) -> list[dict]:
    """One row per clip: WER after ``normalize`` and "raw" (without its "niner" repair), coordinate
    exact match both ways, and the transcription time when ``ms`` has it."""
    rows = []
    for c in clips:
        ref, hyp = lines[c.phrase], heard[c.key]
        errors, words = edits(ref, hyp)
        errors_raw, _ = edits(ref, hyp, niner_fix=False)
        ref_coords = coordinates(ref)
        rows.append(
            {
                "condition": c.condition,
                "phrase": c.phrase + 1,
                "ref": ref,
                "heard": hyp,
                "errors": errors,
                "errors_raw": errors_raw,
                "words": words,
                "wer": round(errors / max(1, words), 3),
                "wer_raw": round(errors_raw / max(1, words), 3),
                "has_coordinate": bool(ref_coords),
                "coordinate_exact": coordinates(hyp) == ref_coords if ref_coords else None,
                "coordinate_exact_raw": (
                    coordinates(hyp, niner_fix=False) == ref_coords if ref_coords else None
                ),
                "ms": (ms or {}).get(c.key),
            }
        )
    return rows


def _pooled(rows: list[dict], key: str = "errors") -> float:
    return sum(r[key] for r in rows) / max(1, sum(r["words"] for r in rows))


def _ms(rows: list[dict]) -> dict[str, int] | None:
    times = sorted(r["ms"] for r in rows if r.get("ms") is not None)
    if not times:
        return None
    return {"p50": times[len(times) // 2], "max": times[-1]}


def summarise(rows: list[dict], n: int) -> dict:
    conditions = list(dict.fromkeys(r["condition"] for r in rows))
    per_condition = {}
    for cond in conditions:
        rs = [r for r in rows if r["condition"] == cond]
        coord = [r["coordinate_exact"] for r in rs if r["has_coordinate"]]
        coord_raw = [r["coordinate_exact_raw"] for r in rs if r["has_coordinate"]]
        per_condition[cond] = {
            "phrases": len(rs),
            "words": sum(r["words"] for r in rs),
            "wer": round(_pooled(rs), 3),
            "wer_raw": round(_pooled(rs, "errors_raw"), 3),
            "errors": sum(r["errors"] for r in rs),
            "errors_raw": sum(r["errors_raw"] for r in rs),
            "no_error": sum(r["errors"] == 0 for r in rs),
            "coordinate_exact": f"{sum(coord)}/{len(coord)}" if coord else "–",
            "coordinate_exact_raw": f"{sum(coord_raw)}/{len(coord_raw)}" if coord_raw else "–",
            "ms": _ms(rs),
            "missing": sorted(set(range(1, n + 1)) - {r["phrase"] for r in rs}),
        }
    per_phrase = {}
    for p in sorted({r["phrase"] for r in rows}):
        rs = [r for r in rows if r["phrase"] == p]
        per_phrase[p] = {
            "wer": round(_pooled(rs), 3),
            "by_condition": {r["condition"]: r["wer"] for r in rs},
        }
    return {
        "overall": {
            "clips": len(rows),
            "words": sum(r["words"] for r in rows),
            "wer": round(_pooled(rows), 3),
            "wer_raw": round(_pooled(rows, "errors_raw"), 3),
        },
        "conditions": per_condition,
        "phrases": per_phrase,
    }


def _cell(text: str) -> str:
    return text.replace("|", "\\|") or "(nothing heard)"


def report(rows: list[dict], summary: dict, lines: list[str], mode: str, worst: int = 5) -> str:
    conds = list(summary["conditions"])
    o = summary["overall"]
    md = [
        "# Radio WER: Parakeet TDT 0.6B v2 on the 20 radio phrases",
        "",
        f"{time.strftime('%Y-%m-%d %H:%M')} · {mode} · `scripts/radio_wer.py`",
        "",
    ]
    if mode.startswith("DRY RUN"):
        md += ["**MOCK transcripts, not a measurement**: this run checks the pipeline only.", ""]
    md += [
        (
            'Word level, after `protocol.normalize` on both sides (number words = digits, "Team Two" = '
            '"Team 2", "Sight line" = "Sightline"): the radio desk\'s own normalisation. Pooled: word '
            "errors / reference words."
        ),
        "",
        f"**Overall WER {o['wer']:.3f}** ({o['clips']} clips, {o['words']} reference words).",
        "",
        "## Per voice",
        "",
        "| Voice | Phrases | Words | WER | Coordinates exactly right |",
        "|---|---|---|---|---|",
    ]
    for cond, s in summary["conditions"].items():
        md.append(
            f"| {_cell(cond)} | {s['phrases']} | {s['words']} | {s['wer']:.3f} | {s['coordinate_exact']} |"
        )
    missing = {c: s["missing"] for c, s in summary["conditions"].items() if s["missing"]}
    if missing:
        md += [
            "",
            "Missing recordings: " + "; ".join(f"{c}: {m}" for c, m in missing.items()) + ".",
        ]
    md += [
        "",
        "## Per phrase",
        "",
        "| # | Phrase | " + " | ".join(_cell(c) for c in conds) + " | All |",
        "|---|---|" + "---|" * (len(conds) + 1),
    ]
    for p, s in summary["phrases"].items():
        cells = [f"{s['by_condition'][c]:.2f}" if c in s["by_condition"] else "–" for c in conds]
        md.append(f"| {p} | {_cell(lines[p - 1])} | " + " | ".join(cells) + f" | {s['wer']:.2f} |")
    ranked = sorted(summary["phrases"].items(), key=lambda kv: (-kv[1]["wer"], kv[0]))[:worst]
    md += ["", f"## The {len(ranked)} worst phrases", ""]
    for p, s in ranked:
        md += [f"**{p}. {lines[p - 1]}** (WER {s['wer']:.2f})", ""]
        for r in (r for r in rows if r["phrase"] == p):
            md.append(
                f'- {r["condition"]} ({r["wer"]:.2f}): "{r["heard"]}" → `{normalize(r["heard"])}`'
            )
        md += [f"- reference, normalised: `{normalize(lines[p - 1])}`", ""]
    return "\n".join(md).rstrip() + "\n"


def transcribe_all(asr, clips: list[Clip]) -> tuple[dict[str, str], dict[str, int]]:
    """(text, ms) per clip key, one clip at a time as the radio desk transcribes."""
    heard, ms = {}, {}
    for c in clips:
        r = asr.transcribe(c.wav)
        heard[c.key], ms[c.key] = r.text, r.ms
    return heard, ms


def boost_report(
    runs: dict[str, list[dict]], lines: list[str], mode: str, boost: dict, n: int
) -> str:
    """Markdown for ``--boost``: each run (boost off, boost on, ...) side by side."""
    sums = {label: summarise(rows, n) for label, rows in runs.items()}
    md = [
        "# Radio WER: phrase boosting off vs on",
        "",
        f"{time.strftime('%Y-%m-%d %H:%M')} · {mode} · `scripts/radio_wer.py --boost`",
        "",
    ]
    if mode.startswith("DRY RUN"):
        md += ["**MOCK transcripts, not a measurement**: this run checks the pipeline only.", ""]
    md += [
        f"Boost: {boost['how']}. Phrases ({len(boost['phrases'])}): "
        + ", ".join(f'"{p}"' for p in boost["phrases"])
        + ".",
        "",
        (
            '"Raw" is word level after `protocol.normalize` without its repair of Parakeet\'s '
            '"niner" ("49er", "nine or"); "normalised" is with it, the radio desk\'s own path. '
            "Pooled: word errors / reference words. Time is the transcription call per clip "
            "(local: GPU; hosted: network round trip included)."
        ),
        "",
        "## Summary",
        "",
        (
            "| Run | Voice | WER raw | WER normalised | Phrases with no error "
            "| Coordinates exact, raw | Coordinates exact, normalised | ms p50 / max |"
        ),
        "|---|---|---|---|---|---|---|---|",
    ]
    for label, s in sums.items():
        for cond, c in s["conditions"].items():
            t = f"{c['ms']['p50']} / {c['ms']['max']}" if c["ms"] else "–"
            md.append(
                f"| {_cell(label)} | {_cell(cond)} | {c['wer_raw']:.3f} ({c['errors_raw']}/{c['words']}) "
                f"| {c['wer']:.3f} ({c['errors']}/{c['words']}) | {c['no_error']}/{c['phrases']} "
                f"| {c['coordinate_exact_raw']} | {c['coordinate_exact']} "
                f"| {t} |"
            )
    labels = list(runs)
    md += [
        "",
        "## Per phrase (WER raw / normalised, ms)",
        "",
        "| Voice | # | Phrase | " + " | ".join(_cell(lb) for lb in labels) + " |",
        "|---|---|---|" + "---|" * len(labels),
    ]
    by = {lb: {(r["condition"], r["phrase"]): r for r in rows} for lb, rows in runs.items()}
    keys = sorted({k for rows in by.values() for k in rows}, key=lambda k: (k[0], k[1]))
    for key in keys:
        cells = []
        for lb in labels:
            r = by[lb].get(key)
            cells.append(
                f"{r['wer_raw']:.2f} / {r['wer']:.2f}, {r['ms'] if r['ms'] is not None else '–'}"
                if r
                else "–"
            )
        md.append(
            f"| {_cell(key[0])} | {key[1]} | {_cell(lines[key[1] - 1])} | "
            + " | ".join(cells)
            + " |"
        )
    md += ["", "## Transcripts that differ between runs", ""]
    differ = 0
    for key in keys:
        texts = {lb: by[lb][key]["heard"] for lb in labels if key in by[lb]}
        if len(set(texts.values())) < 2:
            continue
        differ += 1
        md += [f"**{key[1]}. {lines[key[1] - 1]}** ({key[0]})", ""]
        md += [f'- {lb} ({by[lb][key]["wer"]:.2f}): "{t}"' for lb, t in texts.items()]
        md.append("")
    if not differ:
        md += ["None: every run heard the same text.", ""]
    return "\n".join(md).rstrip() + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--recordings", type=Path, default=RECORDINGS)
    ap.add_argument(
        "--one-file",
        action="store_true",
        help="one recording per voice with pauses between phrases (split on silence)",
    )
    ap.add_argument("--silence-db", type=float, default=-35.0, help="silence threshold, dBFS")
    ap.add_argument("--min-silence", type=float, default=0.6, help="shortest pause, seconds")
    ap.add_argument("--synthetic", action="store_true", help="Magpie voices instead of recordings")
    ap.add_argument(
        "--voices", type=int, nargs="+", default=[0, 1, 2], help="Magpie speakers for --synthetic"
    )
    ap.add_argument("--dry-run", action="store_true", help="mock transcripts, no NeMo")
    ap.add_argument(
        "--boost",
        action="store_true",
        help="transcribe every clip twice, phrase boosting off and on (RADIO_BOOST); writes <ts>-boost/",
    )
    ap.add_argument("--boost-alpha", type=float, default=None, help="NeMo boosting_tree_alpha")
    ap.add_argument("--boost-score", type=float, default=None, help="NeMo context_score")
    ap.add_argument(
        "--riva",
        action="store_true",
        help="hosted Parakeet on build.nvidia.com (Riva gRPC; nvidia-riva-client, NVIDIA_API_KEY)",
    )
    ap.add_argument(
        "--riva-score", type=float, default=None, help="Riva word-boosting score with --boost"
    )
    ap.add_argument(
        "--riva-itn",
        action="store_true",
        help="with --riva: keep the hosted inverse text normalisation (default: verbatim words)",
    )
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args(argv)
    if args.synthetic and args.riva:
        ap.error("--synthetic needs the local model; leave out --riva")

    from sightline.radio.asr import (
        BOOST_ALPHA,
        BOOST_SCORE,
        RADIO_BOOST,
        RIVA_BOOST_SCORE,
    )

    alpha = BOOST_ALPHA if args.boost_alpha is None else args.boost_alpha
    ctx = BOOST_SCORE if args.boost_score is None else args.boost_score
    riva_score = RIVA_BOOST_SCORE if args.riva_score is None else args.riva_score
    lines = phrases()
    n = len(lines)
    asr = None
    with tempfile.TemporaryDirectory(prefix="radio_wer-") as tmp:
        work = Path(tmp)
        if args.synthetic and not args.dry_run:
            from sightline.radio.asr import ParakeetAsr

            asr = ParakeetAsr()
            clips = synthetic_clips(lines, args.voices, asr.device, work)
            mode = "synthetic voices (Magpie), a baseline, not human speech"
        else:
            try:
                found = recordings(args.recordings, args.one_file, n)
            except ValueError as e:
                ap.error(str(e))
            if found:
                try:
                    clips = clips_from_recordings(found, work, n, args.silence_db, args.min_silence)
                except ValueError as e:
                    ap.error(str(e))
                mode = f"{len(found)} recorded voice conditions from {args.recordings}"
            elif args.dry_run:
                clips = [
                    Clip(v, i, work / f"{clip_key(v, i)}.wav")
                    for v in MOCK_VOICES
                    for i in range(n)
                ]
                mode = "mock voices"
            else:
                layout = "<voice>/<any>.m4a" if args.one_file else "<voice>/01.m4a … 20.m4a"
                ap.error(f"no recordings in {args.recordings}/{layout} (or use --dry-run)")
            if args.dry_run:
                mode = f"DRY RUN, mock transcripts ({mode})"
            elif args.riva:
                text = "hosted text normalisation on" if args.riva_itn else "verbatim transcripts"
                mode = f"hosted Parakeet (build.nvidia.com, Riva gRPC, {text}), {mode}"

        def make_asr(boosted: bool):
            """The ASR for one run: mock, hosted (a client per run) or local (one model, re-decoded)."""
            nonlocal asr
            if args.dry_run:
                from sightline.radio.asr import FakeAsr

                voices = list(dict.fromkeys(c.condition for c in clips))
                return FakeAsr(
                    {
                        c.key: mock_transcript(
                            lines[c.phrase], voices.index(c.condition), c.phrase, boosted
                        )
                        for c in clips
                    }
                )
            if args.riva:
                from sightline.radio.asr import RivaAsr

                return RivaAsr(
                    boost=RADIO_BOOST if boosted else None,
                    boost_score=riva_score,
                    verbatim=not args.riva_itn,
                )
            if asr is None:
                from sightline.radio.asr import ParakeetAsr

                asr = ParakeetAsr()
            if args.boost:
                asr.set_boost(RADIO_BOOST if boosted else None, alpha, ctx)
            return asr

        engine = "hosted" if args.riva else "local"
        runs = {}
        for boosted in (False, True) if args.boost else (False,):
            heard, ms = transcribe_all(make_asr(boosted), clips)
            label = f"{engine}, boost {'on' if boosted else 'off'}"
            runs[label] = score(clips, heard, lines, ms)

    stamp = time.strftime("%Y%m%d-%H%M%S")
    if args.boost:
        how = (
            f"Riva word boosting (`speech_contexts`), score {riva_score:g}"
            if args.riva
            else f"NeMo GPU phrase boosting tree, greedy_batch, alpha {alpha:g}, context score {ctx:g}"
        )
        boost = {"how": how, "phrases": list(RADIO_BOOST)}
        suffix = ("-riva-itn" if args.riva_itn else "-riva") if args.riva else ""
        out = args.out / f"{stamp}-boost{suffix}"
        out.mkdir(parents=True, exist_ok=True)
        (out / "wer.md").write_text(boost_report(runs, lines, mode, boost, n))
        summaries = {label: summarise(rows, n) for label, rows in runs.items()}
        (out / "wer.json").write_text(
            json.dumps(
                {
                    "mode": mode,
                    "boost": boost,
                    "runs": {
                        label: {"summary": summaries[label], "rows": rows}
                        for label, rows in runs.items()
                    },
                },
                indent=2,
            )
        )
        for label, s in summaries.items():
            o = s["overall"]
            print(f"{label}: WER raw {o['wer_raw']:.3f}, normalised {o['wer']:.3f} ({mode})")
        print(f"wrote {out / 'wer.md'}")
        return 0

    rows = next(iter(runs.values()))
    summary = summarise(rows, n)
    out = args.out / stamp
    out.mkdir(parents=True, exist_ok=True)
    (out / "wer.md").write_text(report(rows, summary, lines, mode))
    (out / "wer.json").write_text(
        json.dumps({"mode": mode, "summary": summary, "rows": rows}, indent=2)
    )
    print(f"overall WER {summary['overall']['wer']:.3f} over {len(rows)} clips ({mode})")
    for cond, s in summary["conditions"].items():
        print(f"  {cond}: {s['wer']:.3f} ({s['phrases']} phrases)")
    print(f"wrote {out / 'wer.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
