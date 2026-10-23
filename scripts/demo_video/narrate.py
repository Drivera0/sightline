"""Narrate the silent cuts with NVIDIA Magpie TTS, the radio desk's voice (README.md, "Narration"):

    ~/radio-env/bin/python scripts/demo_video/narrate.py runs/video/<timestamp> [--cuts opencv,nebius]
        [--out <dir>] [--takes N] [--no-credit] [--no-check] [--dry-run]

Runs in the NeMo environment (``docs/feedback/radio.md``, "How to reproduce"): Magpie through the radio
desk's own wrapper (``sightline.radio.tts.MagpieTts``, its speaker) and Parakeet through
``sightline.radio.asr.ParakeetAsr``. From the run folder's ``cut_<name>.mp4`` + ``cut_<name>.json`` (each
segment's place in the cut), ``shots.json`` (each shot's place in the program after captions.py's camera
moves and speed-ups: ``program_start_s`` / ``program_end_s``; a line gets the time its shot has after the
speed-up, and a cut made before the program's timings is refused) and ``narration.yaml`` next to this
script, into ``<run>/narrated/``:

- ``clips/<cut>_<shot>.wav``: each line, sentence by sentence, the best of ``takes`` Magpie samples by
  Parakeet's word errors (the shortest when tied). A line that runs past its shot by more than
  ``max_overrun_s`` loses its second sentence and is listed in a warning for a human to rewrite (a
  ``verbatim`` line is never cut: it is reported instead);
- ``narration_<cut>.wav``: the lines placed at their shots' starts plus ``lead_s`` (never on top of the
  line before), the on-camera open and close silent, normalised to ``lufs`` with ffmpeg ``loudnorm``;
- ``cut_<cut>_narrated.mp4``: the cut with that track as AAC and the narration credit burned in over its
  first narrated shot, above the step label, in ``captions.py``'s caption style. Burning it re-encodes
  the video once (``captions.py``'s export profile); ``--no-credit`` copies the video stream instead;
  the audio is AAC 192 kbit/s, 48 kHz;
- ``narration_<cut>.srt``: the spoken lines, timed to the audio;
- ``narration_report.md`` + ``narration.json``: per line the text, seconds available, seconds used, takes,
  and the listen-check: Parakeet transcribes each line back out of the finished mp4's audio and the word
  error rate against the script (after the radio desk's ``protocol.normalize``) is reported per line and
  per cut.

``--dry-run`` needs no NeMo: silent clips sized at ``wpm``, no listen-check; it checks the timing, the
placement and the mux.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import wave
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
for p in (str(ROOT), str(ROOT / "scripts"), str(HERE)):
    if p not in sys.path:
        sys.path.insert(0, p)

from captions import AAC, export_x264, probe, span, ts

ON_CAMERA = ("on camera (open)", "on camera (close)")
_SENTENCE = re.compile(r"(?<=[.!?])\s+")

# --- the listen-check's words: the script says numbers as words, Parakeet writes digits ("sixty
# percent" vs "60%", "three hundred thirty-seven" vs "337"), so both sides are spelled out in words
_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]  # fmt: skip
_TENS = ["_", "_", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
_SPELLING = {"kilometres": "kilometers", "metres": "meters"}
_ROMAN = {"i": "one", "ii": "two", "iii": "three", "iv": "four"}
_COMPOUND = {("open", "cv"): "opencv", ("openc", "v"): "opencv", ("per", "cent"): "percent"}


def int_words(n: int) -> str:
    if n < 20:
        return _ONES[n]
    if n < 100:
        return _TENS[n // 10] + ("" if n % 10 == 0 else " " + _ONES[n % 10])
    if n < 1000:
        return _ONES[n // 100] + " hundred" + ("" if n % 100 == 0 else " " + int_words(n % 100))
    return int_words(n // 1000) + " thousand" + ("" if n % 1000 == 0 else " " + int_words(n % 1000))


def words(text: str) -> list[str]:
    """Lower case, digits spelled out ("0.18" -> "zero point one eight"), "%" -> "percent", "and"
    dropped ("one hundred and one"), apostrophes and hyphens folded, and a run of single letters joined
    ("V L" -> "vl", "P O D" -> "pod")."""
    t = text.lower().replace("%", " percent").replace("-", " ").replace("'", "").replace("’", "")
    t = re.sub(r"(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])", " ", t)  # "opencv5" -> "opencv 5"
    t = re.sub(r"(?<=\d),(?=\d{3}\b)", "", t)

    def num(m: re.Match) -> str:
        whole, _, frac = m.group(0).partition(".")
        return int_words(int(whole)) + (
            "" if not frac else " point " + " ".join(_ONES[int(d)] for d in frac)
        )

    t = re.sub(r"\d+(?:\.\d+)?", num, t)
    out: list[str] = []
    letters = False  # the last token is a run of single letters
    for w in re.findall(r"[a-z]+", t):
        w = _SPELLING.get(w, w)
        if w == "and":
            continue
        single = len(w) == 1 and w != "a"
        if single and letters:
            out[-1] += w
        else:
            out.append(w)
        letters = single
    # written forms of the same sound: "Open CV" / "OpenC V", "per cent", and Parakeet's Roman
    # numerals after a callsign ("Drone I relays Team II")
    folded: list[str] = []
    for w in out:
        if folded and (folded[-1], w) in _COMPOUND:
            folded[-1] = _COMPOUND[folded[-1], w]
        elif folded and folded[-1] in ("drone", "team") and w in _ROMAN:
            folded.append(_ROMAN[w])
        else:
            folded.append(w)
    return folded


def edits(ref: str, hyp: str) -> tuple[int, int]:
    """(word errors, reference words): Levenshtein over ``words``."""
    r, h = words(ref), words(hyp)
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev, d[j] = d[j], cur
    return d[len(h)], len(r)


@dataclass
class Line:
    cut: str
    key: str  # shot id or "slot: <name>"
    text: str  # what the .srt shows and the listen-check compares with
    say: str  # what Magpie is given
    verbatim: bool
    at: float  # the segment's start in the cut
    seg_s: float  # the segment's length
    clip: np.ndarray | None = None
    start: float = 0.0  # where the clip starts in the cut
    takes: int = 0
    errors: int = 0  # in the kept take, by Parakeet on the clip alone
    shortened: str = ""  # the dropped sentence(s), if any
    check: dict = field(default_factory=dict)

    @property
    def available(self) -> float:
        return self.seg_s - LEAD

    @property
    def used(self) -> float:
        return 0.0 if self.clip is None else len(self.clip) / SR


LEAD = 0.25
SR = 22050  # Magpie's rate; set from the model


def sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE.split(text.strip()) if s.strip()]


def respell(text: str, table: dict[str, str]) -> str:
    for display in sorted(table, key=len, reverse=True):
        text = re.sub(rf"(?<!\w){re.escape(display)}(?!\w)", table[display], text)
    return text


def plan(cfg: dict, run: Path, cut: str) -> list[Line]:
    """The cut's narrated lines in order, checked: known segments, never the on-camera open or close,
    at most two sentences (``verbatim`` aside), never "clear", and a warning when the words won't fit at
    ``wpm``."""
    segs = json.loads((run / f"cut_{cut}.json").read_text())["segments"]
    by_key = {s["name"]: s for s in segs}
    shots = {s["id"]: s for s in json.loads((run / "shots.json").read_text())["shots"]}
    lines = []
    for key, item in cfg["cuts"][cut].items():
        if key in ON_CAMERA:
            raise SystemExit(f"{cut}/{key}: the on-camera open and close stay silent")
        if key not in by_key:
            print(f"  {cut}/{key}: not in cut_{cut}.json (shot skipped?), left out")
            continue
        text = " ".join(item["text"].split())
        if "clear" in text.lower():
            raise SystemExit(f"{cut}/{key} says 'clear': a searched area is 'searched at POD x'")
        if len(sentences(text)) > 2 and not item.get("verbatim"):
            raise SystemExit(f"{cut}/{key}: more than two sentences")
        s = by_key[key]
        seg_s = float(s["s"])
        if key in shots:  # a shot: its time after the program's speed-up, from shots.json
            a, b = span(shots[key])
            if not (a - 0.05 <= s["in"] and s["out"] <= b + 0.05):
                raise SystemExit(
                    f"cut_{cut}.json has {key} at {s['in']:.2f}-{s['out']:.2f} s but shots.json has it at "
                    f"{a:.2f}-{b:.2f} s in the program: rerun captions.py --only cuts"
                )
            seg_s = min(seg_s, (b - s["in"]) / float(s.get("speed", 1.0)))
        line = Line(cut, key, text, item.get("say") or respell(text, cfg.get("respell", {})),
                    bool(item.get("verbatim")), float(s["at"]), seg_s)  # fmt: skip
        est = len(line.say.split()) / cfg["wpm"] * 60
        if est > line.available:
            print(f"  warning: {cut}/{key}: {len(line.say.split())} words is about {est:.1f} s at "
                  f"{cfg['wpm']} wpm, {line.available:.1f} s available")  # fmt: skip
        lines.append(line)
    return sorted(lines, key=lambda x: x.at)


# --- speech -------------------------------------------------------------------------------------------


class Voice:
    """Magpie for the lines, Parakeet to score each take (both as the radio desk loads them)."""

    def __init__(self, cfg: dict, tmp: Path, dry: bool) -> None:
        global SR
        self.cfg, self.tmp, self.dry = cfg, tmp, dry
        if dry:
            self.tts = self.asr = None
            return
        import torch

        from sightline.radio.asr import ParakeetAsr
        from sightline.radio.tts import MagpieTts

        self.torch = torch
        self.tts = MagpieTts()
        SR = self.tts.sample_rate
        self.asr = ParakeetAsr()

    def say(self, text: str, seed: int) -> np.ndarray:
        """One take of a line: each sentence on its own, ``gap_s`` between them."""
        gap = np.zeros(int(self.cfg["gap_s"] * SR), np.float32)
        parts: list[np.ndarray] = []
        for i, sent in enumerate(sentences(text)):
            if self.dry:
                n = int(len(sent.split()) / self.cfg["wpm"] * 60 * SR)  # a quiet tone, for loudnorm
                audio = (0.05 * np.sin(np.arange(n) * 2 * np.pi * 220 / SR)).astype(np.float32)
            else:
                self.torch.manual_seed(seed * 100 + i)
                wav = self.tts.speak(sent, self.cfg["voice"]).wav
                audio = read_wav(wav)
            parts += [gap, audio] if parts else [audio]
        return np.concatenate(parts)

    def hear(self, audio: np.ndarray, name: str) -> str:
        if self.dry:
            return ""
        src = self.tmp / f"{name}.wav"
        src.write_bytes(wav_bytes(audio, SR))
        return self.transcribe(src)

    def transcribe(self, src: Path) -> str:
        dst = src.with_suffix(".16k.wav")
        sh(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-ac", "1", "-ar", "16000", str(dst)])
        return self.asr.transcribe(dst).text

    def best(self, line: Line, text: str, say: str) -> tuple[np.ndarray, int, int]:
        """(clip, errors, takes): takes until one is word-perfect and fits, else the best of them (fits
        first, then fewest errors, then shortest)."""
        best = None
        n = 1 if self.dry else self.cfg["takes"]
        for seed in range(n):
            clip = self.say(say, seed)
            err = (
                edits(text, self.hear(clip, f"{line.cut}_{line.key}_{seed}"))[0]
                if not self.dry
                else 0
            )
            fits = len(clip) / SR <= line.available + self.cfg["max_overrun_s"]
            score = (not fits, err, len(clip))
            if best is None or score < best[0]:
                best = (score, clip, err, seed + 1)
            if fits and err == 0:
                break
        assert best is not None
        return best[1], best[2], best[3]


def read_wav(data: bytes) -> np.ndarray:
    import io

    with wave.open(io.BytesIO(data)) as w:
        pcm = np.frombuffer(w.readframes(w.getnframes()), "<i2")
    return (pcm.astype(np.float32) / 32768.0).copy()


def wav_bytes(samples: np.ndarray, rate: int) -> bytes:
    from sightline.radio.tts import wav_bytes as wb

    return wb(samples, rate)


def sh(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, **kw)


def synthesise(lines: list[Line], voice: Voice, cfg: dict, clips: Path) -> list[str]:
    """Each line's clip; the warnings for lines that had to be shortened (or couldn't be)."""
    warnings = []
    for line in lines:
        clip, err, n = voice.best(line, line.text, line.say)
        over = len(clip) / SR - line.available
        if over > cfg["max_overrun_s"]:
            if line.verbatim:
                warnings.append(
                    f"{line.cut}/{line.key}: verbatim, {over:.1f} s over its shot (not cut)"
                )
            else:
                kept_t, kept_s = sentences(line.text)[0], sentences(line.say)[0]
                line.shortened = " ".join(sentences(line.text)[1:])
                warnings.append(f"{line.cut}/{line.key}: {over:.1f} s over, second sentence dropped: "
                                f"\"{line.shortened}\"")  # fmt: skip
                line.text, line.say = kept_t, kept_s
                clip, err, n2 = voice.best(line, line.text, line.say)
                n += n2
        line.clip, line.errors, line.takes = clip, err, n
        (clips / f"{line.cut}_{line.key.replace(': ', '_').replace(' ', '-')}.wav").write_bytes(
            wav_bytes(clip, SR)
        )
        print(f"  {line.cut}/{line.key:28} {line.used:5.1f} s of {line.available:5.1f}  "
              f"takes {n}  errors {err}")  # fmt: skip
    return warnings


# --- the track, the mux -------------------------------------------------------------------------------


def place(lines: list[Line], cfg: dict) -> None:
    """Each line at its shot's start plus ``lead_s``, but never on top of the one before."""
    cursor = 0.0
    for line in lines:
        line.start = max(line.at + LEAD, cursor)
        cursor = line.start + line.used + cfg["gap_s"]


def track(lines: list[Line], total: float, path: Path, cfg: dict) -> None:
    """The narration as one WAV the cut's length, then loudnorm (two passes, linear) at 48 kHz."""
    buf = np.zeros(round(total * SR) + SR, np.float32)
    for line in lines:
        i = round(line.start * SR)
        buf[i : i + len(line.clip)] += line.clip
    raw = path.with_suffix(".raw.wav")
    raw.write_bytes(wav_bytes(buf[: round(total * SR)], SR))
    target = f"I={cfg['lufs']}:TP={cfg['true_peak_db']}:LRA=11"
    probe = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(raw), "-af",
                            f"loudnorm={target}:print_format=json", "-f", "null", "-"],
                           capture_output=True, text=True, check=True).stderr  # fmt: skip
    m = json.loads(probe[probe.rindex("{") : probe.rindex("}") + 1])
    second = (f"loudnorm={target}:linear=true:measured_I={m['input_i']}:measured_TP={m['input_tp']}"
              f":measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}"
              f":offset={m['target_offset']}")  # fmt: skip
    sh(["ffmpeg", "-v", "error", "-y", "-i", str(raw), "-af", second, "-ar", "48000", str(path)])
    raw.unlink()


def credit_srt(lines: list[Line], cfg: dict, path: Path) -> None:
    first = lines[0]
    a, b = first.at + 0.3, first.at + first.seg_s - 0.3  # captions.yaml's lead_in / lead_out
    path.write_text(f"1\n{ts(a)} --> {ts(b)}\n{cfg['credit']['text']}\n")


def mux(run: Path, cut: str, out: Path, cfg: dict, credit: bool) -> Path:
    """The cut's video with the narration as AAC: the credit burned in (one re-encode, as captions.py
    encodes), or the video stream copied."""
    video = (run / f"cut_{cut}.mp4").resolve()
    dst = out / f"cut_{cut}_narrated.mp4"
    if credit:
        cap = yaml.safe_load((HERE / "captions.yaml").read_text())["style"]["force_style"]
        style = re.sub(r"MarginV=\d+", f"MarginV={cfg['credit']['margin_v']}", cap)
        info = probe(video)
        venc = ["-vf", f"subtitles=credit_{cut}.srt:force_style='{style}'", *export_x264(info["fps"], info["h"])]  # fmt: skip
    else:
        venc = ["-c:v", "copy", "-movflags", "+faststart"]
    sh(["ffmpeg", "-v", "error", "-y", "-i", str(video), "-i", f"narration_{cut}.wav",
        "-map", "0:v:0", "-map", "1:a:0", *venc, *AAC, "-shortest", dst.name], cwd=out)  # fmt: skip
    return dst


def narration_srt(lines: list[Line], path: Path) -> None:
    rows = []
    for i, line in enumerate(lines, 1):
        rows += [str(i), f"{ts(line.start)} --> {ts(line.start + line.used)}", line.text, ""]
    path.write_text("\n".join(rows))


# --- the listen-check ---------------------------------------------------------------------------------


def listen(lines: list[Line], video: Path, voice: Voice, tmp: Path) -> tuple[int, int]:
    """Parakeet on each line's window cut from the finished mp4's audio; (errors, words) for the cut."""
    errs = words = 0
    for line in lines:
        src = tmp / f"check_{line.cut}_{lines.index(line)}.wav"
        sh(["ffmpeg", "-v", "error", "-y", "-ss", f"{max(0.0, line.start - 0.1):.3f}",
            "-t", f"{line.used + 0.4:.3f}", "-i", str(video), "-vn", "-ac", "1", str(src)])  # fmt: skip
        heard = voice.transcribe(src)
        e, n = edits(line.text, heard)
        line.check = {"heard": heard, "errors": e, "words": n, "wer": round(e / max(1, n), 3)}
        errs, words = errs + e, words + n
        print(f"  check {line.cut}/{line.key:28} WER {e}/{n}  heard: {heard}")
    return errs, words


def report(cuts: dict, warnings: list[str], out: Path, cfg: dict) -> None:
    md = ["# Narration", "",
          (f"NVIDIA Magpie TTS (`{voice_name()}`, speaker {cfg['voice']}), each line placed {LEAD} s after "
          f"its shot starts, the track at {cfg['lufs']} LUFS; listen-check by Parakeet TDT 0.6B v2 on the "
          "finished mp4's audio, word error rate with numbers spelled out on both sides."), ""]  # fmt: skip
    data = {}
    for cut, (lines, errs, words, total) in cuts.items():
        wer = f"{errs / words:.3f} ({errs} / {words})" if words else "not run"
        md += [f"## {cut}: `cut_{cut}_narrated.mp4` ({total:.1f} s), WER {wer}", "",
               "| Shot | At | Available s | Used s | Takes | WER | Text |", "|---|---|---|---|---|---|---|"]  # fmt: skip
        for x in lines:
            w = f"{x.check['errors']}/{x.check['words']}" if x.check else "-"
            md.append(f"| {x.key} | {x.start:.2f} | {x.available:.2f} | {x.used:.2f} | {x.takes} | {w} | "
                      f"{x.text}{' *(shortened)*' if x.shortened else ''} |")  # fmt: skip
        md += [""]
        bad = [x for x in lines if x.check and x.check["errors"]]
        if bad:
            md += (
                ["Heard differently:", ""]
                + [f'- {x.key}: "{x.check["heard"]}"' for x in bad]
                + [""]
            )
        data[cut] = {"total_s": total, "errors": errs, "words": words,
                     "lines": [{"key": x.key, "text": x.text, "say": x.say, "start_s": round(x.start, 3),
                                "available_s": round(x.available, 3), "used_s": round(x.used, 3),
                                "takes": x.takes, "shortened": x.shortened, "check": x.check}
                               for x in lines]}  # fmt: skip
    md += ["## Lines cut to fit", ""] + ([f"- {w}" for w in warnings] or ["None."]) + [""]
    (out / "narration_report.md").write_text("\n".join(md))
    (out / "narration.json").write_text(
        json.dumps({"cuts": data, "warnings": warnings}, indent=2) + "\n"
    )


def voice_name() -> str:
    try:
        from sightline.radio.tts import MAGPIE

        return MAGPIE
    except ImportError:  # pragma: no cover
        return "nvidia/magpie_tts_multilingual_357m"


def main(argv: list[str] | None = None) -> int:
    global LEAD
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("run", type=Path, help="the run folder with cut_<name>.mp4 and cut_<name>.json")
    ap.add_argument("--config", type=Path, default=HERE / "narration.yaml")
    ap.add_argument("--cuts", default="opencv,nebius")
    ap.add_argument("--out", type=Path, help="default <run>/narrated")
    ap.add_argument("--takes", type=int, help="override the config's takes per line")
    ap.add_argument(
        "--no-credit", action="store_true", help="copy the video stream, no credit caption"
    )
    ap.add_argument("--no-check", action="store_true", help="skip the listen-check")
    ap.add_argument("--dry-run", action="store_true", help="no NeMo: silent clips sized at wpm")
    args = ap.parse_args(argv)
    cfg = yaml.safe_load(args.config.read_text())
    if args.takes:
        cfg["takes"] = args.takes
    LEAD = float(cfg["lead_s"])
    if "clear" in cfg["credit"]["text"].lower():
        raise SystemExit("the credit says 'clear'")
    out = (args.out or args.run / "narrated").resolve()
    clips, tmp = out / "clips", out / "tmp"
    for d in (clips, tmp):
        d.mkdir(parents=True, exist_ok=True)

    names = args.cuts.split(",")
    plans = {c: plan(cfg, args.run, c) for c in names}
    voice = Voice(cfg, tmp, args.dry_run)
    warnings: list[str] = []
    done = {}
    for cut in names:
        print(f"== {cut}")
        lines = plans[cut]
        warnings += synthesise(lines, voice, cfg, clips)
        place(lines, cfg)
        total = json.loads((args.run / f"cut_{cut}.json").read_text())["total_s"]
        for x in lines:  # a late start (after a long line) must not run into the on-camera close
            if x.start + x.used > x.at + x.seg_s + cfg["max_overrun_s"]:
                warnings.append(
                    f"{cut}/{x.key}: ends {x.start + x.used - x.at - x.seg_s:.1f} s past its shot"
                )
        track(lines, total, out / f"narration_{cut}.wav", cfg)
        if not args.no_credit:
            credit_srt(lines, cfg, out / f"credit_{cut}.srt")
        video = mux(args.run, cut, out, cfg, not args.no_credit)
        narration_srt(lines, out / f"narration_{cut}.srt")
        errs = words = 0
        if not (args.no_check or args.dry_run):
            errs, words = listen(lines, video, voice, tmp)
        done[cut] = (lines, errs, words, total)
        print(f"  wrote {video}" + (f"  WER {errs}/{words} = {errs / words:.3f}" if words else ""))
    report(done, warnings, out, cfg)
    shutil.rmtree(tmp, ignore_errors=True)
    if warnings:
        print("\nwarning: lines cut or over their shots (rewrite them in narration.yaml):")
        for w in warnings:
            print(f"  - {w}")
    print(f"\n{out / 'narration_report.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
