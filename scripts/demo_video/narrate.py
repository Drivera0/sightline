"""Narrate the silent cuts (README.md, "Narration"), with any of three voices:

    ~/radio-env/bin/python scripts/demo_video/narrate.py runs/video/<timestamp>                      # Magpie
    ~/radio-env/bin/python scripts/demo_video/narrate.py runs/video/<timestamp> --engine elevenlabs --voice eric
    ~/radio-env/bin/python scripts/demo_video/narrate.py runs/video/<timestamp> --engine kokoro
    python3 scripts/demo_video/narrate.py runs/video/<timestamp> --dry-run      # no voices: tones at 150 wpm
        [--cuts opencv,nebius] [--out <dir>] [--takes N] [--no-credit] [--no-check]

The narrator's voice is not chosen yet, so everything here is voice-agnostic (``narration.yaml``,
``engines``):

- ``magpie`` (default): NVIDIA Magpie TTS through the radio desk's own wrapper
  (``sightline.radio.tts.MagpieTts``), in the NeMo environment (``docs/feedback/radio.md``);
- ``elevenlabs``: the ElevenLabs text-to-speech API, the key from ``ELEVENLABS_API_KEY`` (never printed or
  written anywhere), ``--voice`` eric, daniel, matilda or river (or a voice id), ``eleven_multilingual_v2``,
  stability 0.55, similarity 0.8, style 0.15, 44.1 kHz mp3 decoded to wav;
- ``kokoro``: Kokoro-82M through its own venv's python (``engines.kokoro.python``), voice ``am_michael``.

Each engine gets its own respelling table (``respell.magpie`` or ``respell.plain``) and credit. The radio
exchange is in-world: Team One's call and the desk's reply are always Magpie (the radio desk's model and
speaker), whichever engine narrates. The listen-check is Parakeet (``sightline.radio.asr.ParakeetAsr``)
when NeMo is importable, else it is skipped and the report says so.

From the run folder's ``cut_<name>.mp4`` + ``cut_<name>.json`` (each segment's place in the cut),
``shots.json`` (each shot's place in the program after captions.py's camera moves and speed-ups; a cut made
before the program's timings is refused) and ``narration.yaml``, into ``<run>/narrated/``:

- ``clips/<cut>_<shot>.wav``: each line, sentence by sentence, the best of ``takes`` by Parakeet's word
  errors (the shortest when tied). A line that runs past its shot by more than ``max_overrun_s`` loses its
  second sentence and is listed for a human to rewrite (a ``verbatim`` line is never cut: it is reported);
- ``narration_<cut>.wav``: the lines placed at their shots' starts plus ``lead_s`` (never on top of the line
  before; an in-world exchange at its ``at_s``), 48 kHz, normalised to ``lufs`` with ffmpeg ``loudnorm``;
- ``cut_<cut>_narrated.mp4``: the cut with that track as AAC and the voice credit burned in over its first
  narrated shot, above the caption, in the site's type (``captions.py``'s ASS styles; one re-encode in its
  export profile; ``--no-credit`` copies the video stream);
- ``narration_<cut>.srt``: the spoken lines, timed to the audio;
- ``narration_report.md`` + ``narration.json``: per line the text, seconds available and used, takes, and
  the listen-check (Parakeet on each line cut back out of the finished mp4's audio, word error rate after
  numbers are spelled out on both sides).

``--dry-run`` needs no voice and no NeMo: tones sized at ``wpm``, no listen-check; it checks the fit, the
placement and the mux.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
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

from captions import AAC, NO_CLEAR, STORY_BANNED, ass, export_x264, fonts, probe, span, ts

ON_CAMERA = ("on camera (open)", "on camera (close)")
_SENTENCE = re.compile(r"(?<=[.!?])\s+")
SR = 48000  # every voice is decoded to 48 kHz mono float, the track's rate
LEAD = 0.25
TURN_GAP_S = 0.45  # between the team's call and the desk's reply

# --- the listen-check's words: the script says numbers as words, Parakeet writes digits ("sixty
# percent" vs "60%", "three hundred thirty-seven" vs "337"), so both sides are spelled out in words
_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]  # fmt: skip
_TENS = ["_", "_", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
_SPELLING = {"kilometres": "kilometers", "metres": "meters", "grey": "gray"}
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
    say: str  # what the voice is given
    verbatim: bool
    at: float  # the segment's start in the cut
    seg_s: float  # the segment's length
    turns: list[dict] = field(default_factory=list)  # in-world: [{who, text}], always Magpie
    at_s: float = 0.0  # in-world: where the exchange starts in its shot
    clip: np.ndarray | None = None
    start: float = 0.0  # where the clip starts in the cut
    takes: int = 0
    errors: int = 0  # in the kept take, by Parakeet on the clip alone
    shortened: str = ""  # the dropped sentence(s), if any
    check: dict = field(default_factory=dict)

    @property
    def in_world(self) -> bool:
        return bool(self.turns)

    @property
    def available(self) -> float:
        return self.seg_s - (self.at_s if self.in_world else LEAD)

    @property
    def used(self) -> float:
        return 0.0 if self.clip is None else len(self.clip) / SR


def sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE.split(text.strip()) if s.strip()]


def respell(text: str, table: dict[str, str]) -> str:
    for display in sorted(table, key=len, reverse=True):
        text = re.sub(rf"(?<!\w){re.escape(display)}(?!\w)", table[display], text)
    return text


def check_line(where: str, text: str, verbatim: bool) -> None:
    """Never "clear" or "rule out"; inside the story never demo/recorded/scripted/simulated (the disclosure
    card says it once). A verbatim line (the report's own words) is the one exception to the second."""
    if NO_CLEAR.search(text):
        raise SystemExit(f"{where} says {NO_CLEAR.search(text).group(0)!r}: a searched area is 'searched at POD x'")
    if STORY_BANNED.search(text):
        if not verbatim:
            raise SystemExit(f"{where} says {STORY_BANNED.search(text).group(0)!r}: only the disclosure card says that")
        print(f"  note: {where} is verbatim and keeps {STORY_BANNED.search(text).group(0)!r} (the report's own sentence)")


def plan(cfg: dict, run: Path, cut: str, engine: str) -> list[Line]:
    """The cut's narrated lines in order, checked: known segments, never an on-camera slot, at most two
    sentences (``verbatim`` aside), the words rule, and a warning when the words won't fit at ``wpm``."""
    segs = json.loads((run / f"cut_{cut}.json").read_text())["segments"]
    by_key = {s["name"]: s for s in segs}
    shots = {s["id"]: s for s in json.loads((run / "shots.json").read_text())["shots"]}
    ecfg = cfg["engines"][engine]
    table = cfg["respell"].get(ecfg.get("respell", "plain"), {})
    lines = []
    for key, item in cfg["cuts"][cut].items():
        if key not in by_key:
            print(f"  {cut}/{key}: not in cut_{cut}.json (shot skipped?), left out")
            continue
        s = by_key[key]
        if key in ON_CAMERA or s.get("on_camera"):
            raise SystemExit(f"{cut}/{key}: an on-camera slot stays silent")
        seg_s = float(s["s"])
        if key in shots:  # a shot: its time after the program's speed-up, from shots.json
            a, b = span(shots[key])
            if not (a - 0.05 <= s["in"] and s["out"] <= b + 0.05):
                raise SystemExit(
                    f"cut_{cut}.json has {key} at {s['in']:.2f}-{s['out']:.2f} s but shots.json has it at "
                    f"{a:.2f}-{b:.2f} s in the program: rerun captions.py --only cuts"
                )
            seg_s = min(seg_s, (b - s["in"]) / float(s.get("speed", 1.0)))
        if item.get("in_world"):
            turns = [dict(t) for t in item["turns"]]
            for t in turns:
                check_line(f"{cut}/{key} ({t['who']})", t["text"], False)
            text = " ".join(t["text"] for t in turns)
            line = Line(cut, key, text, text, False, float(s["at"]), seg_s, turns=turns,
                        at_s=float(item.get("at_s", 0.0)))  # fmt: skip
        else:
            text = " ".join(item["text"].split())
            verbatim = bool(item.get("verbatim"))
            check_line(f"{cut}/{key}", text, verbatim)
            if len(sentences(text)) > 2 and not verbatim:
                raise SystemExit(f"{cut}/{key}: more than two sentences")
            own = item.get("say") if engine == "magpie" else item.get("say_plain")
            line = Line(cut, key, text, own or respell(text, table), verbatim, float(s["at"]), seg_s)
        est = len(line.say.split()) / cfg["wpm"] * 60
        line_fit = est - line.available
        if line_fit > 0:
            print(f"  warning: {cut}/{key}: {len(line.say.split())} words is about {est:.1f} s at "
                  f"{cfg['wpm']} wpm, {line.available:.1f} s available")  # fmt: skip
        lines.append(line)
    return sorted(lines, key=lambda x: x.at)


# --- decoding: any voice's output to 48 kHz mono float ---------------------------------------------------


def decode(data: bytes) -> np.ndarray:
    """WAV or mp3 bytes -> float32 mono at SR, through ffmpeg."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", "pipe:0", "-ac", "1", "-ar", str(SR), "-f", "f32le", "pipe:1"],
                       input=data, capture_output=True, check=True)  # fmt: skip
    return np.frombuffer(r.stdout, np.float32).copy()


def wav_bytes(samples: np.ndarray, rate: int = SR) -> bytes:
    """Float samples in [-1, 1] as a 16-bit mono WAV file."""
    import io

    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def tone(text: str, wpm: float) -> np.ndarray:
    """--dry-run: a quiet tone the length the words take at `wpm` (loudnorm needs something to measure)."""
    n = int(len(text.split()) / wpm * 60 * SR)
    return (0.05 * np.sin(np.arange(n) * 2 * np.pi * 220 / SR)).astype(np.float32)


# --- the engines -------------------------------------------------------------------------------------------


class Magpie:
    """NVIDIA Magpie TTS as the radio desk loads it; a baked speaker by index."""

    name = "magpie"

    def __init__(self, voice: str) -> None:
        try:
            import torch

            from sightline.radio.tts import VOICES, MagpieTts
        except ImportError as e:
            raise SystemExit(
                f"Magpie needs the NeMo environment (~/radio-env/bin/python): {e}"
            ) from None
        self.torch, self.tts = torch, MagpieTts()
        self.default = VOICES.get(voice, 0)

    def speak(self, text: str, seed: int, speaker: int | None = None) -> np.ndarray:
        from sightline.radio.tts import wav_bytes as wb

        self.torch.manual_seed(seed)
        with self.torch.inference_mode():
            audio, n = self.tts.model.do_tts(text, speaker_index=self.default if speaker is None else speaker)
        samples = audio[0, : int(n[0])].float().cpu().numpy()
        return decode(wb(samples, self.tts.sample_rate))


class ElevenLabs:
    """The ElevenLabs text-to-speech API (urllib, no SDK). The key comes from ELEVENLABS_API_KEY and is
    only ever put in the request header."""

    name = "elevenlabs"
    URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice}?output_format={fmt}"

    def __init__(self, ecfg: dict, voice: str) -> None:
        self.key = os.environ.get("ELEVENLABS_API_KEY", "")
        if not self.key:
            raise SystemExit("--engine elevenlabs needs ELEVENLABS_API_KEY in the environment")
        self.voice = ecfg.get("voices", {}).get(voice, voice)  # a name from the table, or an id
        self.cfg = ecfg

    def speak(self, text: str, seed: int, speaker: int | None = None) -> np.ndarray:
        body = {"text": text, "model_id": self.cfg["model"], "voice_settings": self.cfg["settings"], "seed": seed}
        req = urllib.request.Request(
            self.URL.format(voice=self.voice, fmt=self.cfg.get("output_format", "mp3_44100_128")),
            data=json.dumps(body).encode(),
            headers={"xi-api-key": self.key, "Content-Type": "application/json", "Accept": "audio/mpeg"},
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return decode(r.read())
        except urllib.error.HTTPError as e:  # the body is the API's message, never the key
            raise SystemExit(f"ElevenLabs said {e.code}: {e.read()[:300].decode(errors='replace')}") from None


KOKORO_CHILD = r"""
import json, sys
import numpy as np, soundfile as sf
from kokoro import KPipeline
pipe = KPipeline(lang_code=sys.argv[1])
for raw in sys.stdin:
    job = json.loads(raw)
    parts = []
    for r in pipe(job["text"], voice=job["voice"]):
        a = r.audio if hasattr(r, "audio") else r[2]
        a = a.detach().cpu().numpy() if hasattr(a, "detach") else np.asarray(a)
        parts.append(a.astype(np.float32))
    sf.write(job["path"], np.concatenate(parts) if parts else np.zeros(2400, np.float32), 24000)
    print("done:" + job["path"], flush=True)
"""


class Kokoro:
    """Kokoro-82M in its own venv: one child process for the run, a line of JSON in, a WAV out."""

    name = "kokoro"

    def __init__(self, ecfg: dict, voice: str, tmp: Path) -> None:
        py = ecfg.get("python", "")
        if not Path(py).exists():
            raise SystemExit(f"--engine kokoro: no python at {py} (narration.yaml engines.kokoro.python)")
        self.voice, self.tmp, self.n = voice, tmp, 0
        self.child = subprocess.Popen([py, "-c", KOKORO_CHILD, ecfg.get("lang", "a")], stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)  # fmt: skip

    def speak(self, text: str, seed: int, speaker: int | None = None) -> np.ndarray:
        self.n += 1
        path = self.tmp / f"kokoro_{self.n}.wav"
        assert self.child.stdin and self.child.stdout
        self.child.stdin.write(json.dumps({"text": text, "voice": self.voice, "path": str(path)}) + "\n")
        self.child.stdin.flush()
        while True:
            out = self.child.stdout.readline()
            if not out:
                raise SystemExit("the Kokoro process stopped (run its python by hand to see why)")
            if out.startswith("done:"):
                return decode(path.read_bytes())

    def close(self) -> None:
        if self.child.stdin:
            self.child.stdin.close()
        self.child.wait(30)


class Voices:
    """The narrator's engine, Magpie for the in-world radio, and Parakeet to score takes and to listen."""

    def __init__(self, cfg: dict, engine: str, voice: str, tmp: Path, dry: bool, check: bool) -> None:
        self.cfg, self.engine, self.tmp, self.dry = cfg, engine, tmp, dry
        self.narrator = self.radio = self.asr = None
        self.asr_note = "not run (--dry-run)" if dry else "not run (--no-check)"
        if dry:
            return
        ecfg = cfg["engines"][engine]
        if engine == "magpie":
            self.narrator = Magpie(voice)
        elif engine == "elevenlabs":
            self.narrator = ElevenLabs(ecfg, voice)
        elif engine == "kokoro":
            self.narrator = Kokoro(ecfg, voice, tmp)
        else:
            raise SystemExit(f"unknown engine {engine}")
        if check:
            try:
                from sightline.radio.asr import ParakeetAsr

                self.asr = ParakeetAsr()
                self.asr_note = "Parakeet TDT 0.6B v2 on the finished mp4's audio"
            except ImportError as e:
                self.asr_note = f"not run (no NeMo here: {e})"

    def magpie(self) -> Magpie:
        if self.radio is None:
            self.radio = self.narrator if isinstance(self.narrator, Magpie) else Magpie("en_female")
        return self.radio

    def say(self, line: Line, seed: int) -> np.ndarray:
        """One take of a line: each sentence on its own, ``gap_s`` between them; an in-world exchange is
        the team's call in its Magpie speaker, a pause, the desk's reply in Sightline's."""
        gap = np.zeros(int(self.cfg["gap_s"] * SR), np.float32)
        parts: list[np.ndarray] = []
        if line.in_world:
            who = self.cfg.get("radio_voices", {})
            for t in line.turns:
                audio = tone(t["text"], self.cfg["wpm"]) if self.dry else self.magpie().speak(t["text"], seed, who.get(t["who"], 0))
                parts += [np.zeros(int(TURN_GAP_S * SR), np.float32), audio] if parts else [audio]
            return np.concatenate(parts)
        for i, sent in enumerate(sentences(line.say)):
            audio = tone(sent, self.cfg["wpm"]) if self.dry else self.narrator.speak(sent, seed * 100 + i)
            parts += [gap, audio] if parts else [audio]
        return np.concatenate(parts)

    def transcribe(self, src: Path) -> str:
        dst = src.with_suffix(".16k.wav")
        sh(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-ac", "1", "-ar", "16000", str(dst)])
        return self.asr.transcribe(dst).text

    def hear(self, audio: np.ndarray, name: str) -> str | None:
        if self.asr is None:
            return None
        src = self.tmp / f"{name}.wav"
        src.write_bytes(wav_bytes(audio))
        return self.transcribe(src)

    def best(self, line: Line, takes: int) -> tuple[np.ndarray, int, int]:
        """(clip, errors, takes): takes until one is word-perfect and fits, else the best of them (fits
        first, then fewest errors, then shortest)."""
        best = None
        n = 1 if self.dry else takes
        for seed in range(n):
            clip = self.say(line, seed)
            heard = self.hear(clip, f"{line.cut}_{line.key}_{seed}".replace(" ", "-").replace(":", ""))
            err = edits(line.text, heard)[0] if heard is not None else 0
            fits = len(clip) / SR <= line.available + self.cfg["max_overrun_s"]
            score = (not fits, err, len(clip))
            if best is None or score < best[0]:
                best = (score, clip, err, seed + 1)
            if fits and (err == 0 or heard is None):
                break
        assert best is not None
        return best[1], best[2], best[3]

    def close(self) -> None:
        if isinstance(self.narrator, Kokoro):
            self.narrator.close()


def sh(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, **kw)


def synthesise(lines: list[Line], voices: Voices, cfg: dict, clips: Path, takes: int) -> list[str]:
    """Each line's clip; the warnings for lines that had to be shortened (or couldn't be)."""
    warnings = []
    for line in lines:
        clip, err, n = voices.best(line, takes)
        over = len(clip) / SR - line.available
        if over > cfg["max_overrun_s"]:
            if line.verbatim or line.in_world or len(sentences(line.text)) < 2:
                warnings.append(f"{line.cut}/{line.key}: {over:.1f} s over its shot (not cut: "
                                f"{'verbatim' if line.verbatim else 'in-world' if line.in_world else 'one sentence'})")  # fmt: skip
            else:
                kept_t, kept_s = sentences(line.text)[0], sentences(line.say)[0]
                line.shortened = " ".join(sentences(line.text)[1:])
                warnings.append(f"{line.cut}/{line.key}: {over:.1f} s over, second sentence dropped: "
                                f"\"{line.shortened}\"")  # fmt: skip
                line.text, line.say = kept_t, kept_s
                clip, err, n2 = voices.best(line, takes)
                n += n2
        line.clip, line.errors, line.takes = clip, err, n
        (clips / f"{line.cut}_{line.key.replace(': ', '_').replace(' ', '-')}.wav").write_bytes(wav_bytes(clip))
        print(f"  {line.cut}/{line.key:28} {line.used:5.1f} s of {line.available:5.1f}  "
              f"takes {n}  errors {err}{'  (in-world, Magpie)' if line.in_world else ''}")  # fmt: skip
    return warnings


# --- the track, the mux -------------------------------------------------------------------------------


def place(lines: list[Line], cfg: dict) -> None:
    """Each line at its shot's start plus ``lead_s`` (an in-world exchange at its ``at_s``), but never on
    top of the one before."""
    cursor = 0.0
    for line in lines:
        line.start = max(line.at + (line.at_s if line.in_world else LEAD), cursor)
        cursor = line.start + line.used + cfg["gap_s"]


def track(lines: list[Line], total: float, path: Path, cfg: dict) -> None:
    """The narration as one WAV the cut's length, then loudnorm (two passes, linear) at 48 kHz."""
    buf = np.zeros(round(total * SR) + SR, np.float32)
    for line in lines:
        i = round(line.start * SR)
        buf[i : i + len(line.clip)] += line.clip
    raw = path.with_suffix(".raw.wav")
    raw.write_bytes(wav_bytes(buf[: round(total * SR)]))
    target = f"I={cfg['lufs']}:TP={cfg['true_peak_db']}:LRA=11"
    probe_ = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(raw), "-af",
                             f"loudnorm={target}:print_format=json", "-f", "null", "-"],
                            capture_output=True, text=True, check=True).stderr  # fmt: skip
    m = json.loads(probe_[probe_.rindex("{") : probe_.rindex("}") + 1])
    second = (f"loudnorm={target}:linear=true:measured_I={m['input_i']}:measured_TP={m['input_tp']}"
              f":measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}"
              f":offset={m['target_offset']}")  # fmt: skip
    sh(["ffmpeg", "-v", "error", "-y", "-i", str(raw), "-af", second, "-ar", "48000", str(path)])
    raw.unlink()


def credit_text(cfg: dict, engine: str, lines: list[Line]) -> str:
    text = cfg["engines"][engine]["credit"]
    if engine != "magpie" and any(x.in_world for x in lines):
        text += " · " + cfg["credit"]["in_world"]
    return text


def credit_ass(lines: list[Line], text: str, out: Path, cut: str) -> str:
    """credit_<cut>.ass: the credit over the first narrated line's segment, in captions.py's Credit style
    (the site's type, just above the caption). Returns the ass filter for it."""
    ccfg = yaml.safe_load((HERE / "captions.yaml").read_text())
    first = next((x for x in lines if not x.in_world), lines[0])
    a, b = first.at + 0.3, first.at + first.seg_s - 0.3
    font = fonts(ccfg, out)
    ass([(a, b, text, "Credit")], ccfg, out / f"credit_{cut}.ass", font)
    return f"ass=credit_{cut}.ass" + (":fontsdir=fonts" if (out / "fonts").is_dir() else "")


def mux(run: Path, cut: str, out: Path, vf: str | None) -> Path:
    """The cut's video with the narration as AAC: the credit burned in (one re-encode, as captions.py
    encodes), or the video stream copied."""
    video = (run / f"cut_{cut}.mp4").resolve()
    dst = out / f"cut_{cut}_narrated.mp4"
    if vf:
        info = probe(video)
        venc = ["-vf", vf, *export_x264(info["fps"], info["h"])]
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


def listen(lines: list[Line], video: Path, voices: Voices, tmp: Path) -> tuple[int, int]:
    """Parakeet on each line's window cut from the finished mp4's audio; (errors, words) for the cut."""
    errs = n_words = 0
    for i, line in enumerate(lines):
        src = tmp / f"check_{line.cut}_{i}.wav"
        sh(["ffmpeg", "-v", "error", "-y", "-ss", f"{max(0.0, line.start - 0.1):.3f}",
            "-t", f"{line.used + 0.4:.3f}", "-i", str(video), "-vn", "-ac", "1", str(src)])  # fmt: skip
        heard = voices.transcribe(src)
        e, n = edits(line.text, heard)
        line.check = {"heard": heard, "errors": e, "words": n, "wer": round(e / max(1, n), 3)}
        errs, n_words = errs + e, n_words + n
        print(f"  check {line.cut}/{line.key:28} WER {e}/{n}  heard: {heard}")
    return errs, n_words


def report(cuts: dict, warnings: list[str], out: Path, cfg: dict, engine: str, voice: str, asr: str) -> None:
    md = ["# Narration", "",
          (f"Narrator: {engine} (voice `{voice}`); the radio exchange in NVIDIA Magpie TTS (`{magpie_name()}`, "
           f"speakers {cfg.get('radio_voices')}). Each line placed {LEAD} s after its shot starts, the track at "
           f"{cfg['lufs']} LUFS. Listen-check: {asr}."), ""]  # fmt: skip
    data = {}
    for cut, (lines, errs, n_words, total) in cuts.items():
        wer = f"{errs / n_words:.3f} ({errs} / {n_words})" if n_words else "not run"
        md += [f"## {cut}: `cut_{cut}_narrated.mp4` ({total:.1f} s), WER {wer}", "",
               "| Shot | At | Available s | Used s | Fits | Takes | WER | Text |", "|---|---|---|---|---|---|---|---|"]  # fmt: skip
        for x in lines:
            w = f"{x.check['errors']}/{x.check['words']}" if x.check else "-"
            fits = "yes" if x.used <= x.available + cfg["max_overrun_s"] else f"over {x.used - x.available:.1f} s"
            md.append(f"| {x.key} | {x.start:.2f} | {x.available:.2f} | {x.used:.2f} | {fits} | {x.takes} | {w} | "
                      f"{x.text}{' *(shortened)*' if x.shortened else ''}{' *(in-world, Magpie)*' if x.in_world else ''} |")  # fmt: skip
        md += [""]
        bad = [x for x in lines if x.check and x.check["errors"]]
        if bad:
            md += ["Heard differently:", ""] + [f'- {x.key}: "{x.check["heard"]}"' for x in bad] + [""]
        data[cut] = {"total_s": total, "errors": errs, "words": n_words,
                     "lines": [{"key": x.key, "text": x.text, "say": x.say, "in_world": x.in_world,
                                "start_s": round(x.start, 3), "available_s": round(x.available, 3),
                                "used_s": round(x.used, 3), "takes": x.takes, "shortened": x.shortened,
                                "check": x.check} for x in lines]}  # fmt: skip
    md += ["## Lines cut or over their shots", ""] + ([f"- {w}" for w in warnings] or ["None."]) + [""]
    (out / "narration_report.md").write_text("\n".join(md))
    (out / "narration.json").write_text(
        json.dumps({"engine": engine, "voice": voice, "cuts": data, "warnings": warnings}, indent=2) + "\n"
    )


def magpie_name() -> str:
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
    ap.add_argument("--engine", choices=("magpie", "elevenlabs", "kokoro"), help="the narrator (default: the config's)")
    ap.add_argument("--voice", help="the engine's voice (default: the config's for that engine)")
    ap.add_argument("--cuts", default="opencv,nebius")
    ap.add_argument("--out", type=Path, help="default <run>/narrated (or <run>/narrated-<engine>-<voice>)")
    ap.add_argument("--takes", type=int, help="override the engine's takes per line")
    ap.add_argument(
        "--no-credit", action="store_true", help="copy the video stream, no credit caption"
    )
    ap.add_argument("--no-check", action="store_true", help="skip the listen-check")
    ap.add_argument("--dry-run", action="store_true", help="no voices: tones sized at wpm")
    args = ap.parse_args(argv)
    cfg = yaml.safe_load(args.config.read_text())
    engine = args.engine or cfg.get("engine", "magpie")
    ecfg = cfg["engines"][engine]
    voice = args.voice or ecfg["voice"]
    takes = args.takes or int(ecfg.get("takes", 1))
    LEAD = float(cfg["lead_s"])
    default_out = args.run / ("narrated" if engine == "magpie" and voice == ecfg["voice"] else f"narrated-{engine}-{voice}")
    out = (args.out or default_out).resolve()
    clips, tmp = out / "clips", out / "tmp"
    for d in (clips, tmp):
        d.mkdir(parents=True, exist_ok=True)

    names = args.cuts.split(",")
    plans = {c: plan(cfg, args.run, c, engine) for c in names}
    voices = Voices(cfg, engine, voice, tmp, args.dry_run, not args.no_check)
    warnings: list[str] = []
    done = {}
    try:
        for cut in names:
            print(f"== {cut} ({engine}, {voice}{', dry run' if args.dry_run else ''})")
            lines = plans[cut]
            warnings += synthesise(lines, voices, cfg, clips, takes)
            place(lines, cfg)
            total = json.loads((args.run / f"cut_{cut}.json").read_text())["total_s"]
            for x in lines:  # a late start (after a long line) must not run into the next segment
                if x.start + x.used > x.at + x.seg_s + cfg["max_overrun_s"]:
                    warnings.append(f"{cut}/{x.key}: ends {x.start + x.used - x.at - x.seg_s:.1f} s past its shot")
            track(lines, total, out / f"narration_{cut}.wav", cfg)
            text = credit_text(cfg, engine, lines)
            check_line(f"{cut} credit", text, False)
            vf = None if args.no_credit or not lines else credit_ass(lines, text, out, cut)
            video = mux(args.run, cut, out, vf)
            narration_srt(lines, out / f"narration_{cut}.srt")
            errs = n_words = 0
            if voices.asr is not None:
                errs, n_words = listen(lines, video, voices, tmp)
            done[cut] = (lines, errs, n_words, total)
            print(f"  wrote {video}" + (f"  WER {errs}/{n_words} = {errs / n_words:.3f}" if n_words else ""))
    finally:
        voices.close()
    report(done, warnings, out, cfg, engine, voice, voices.asr_note)
    shutil.rmtree(tmp, ignore_errors=True)
    if warnings:
        print("\nwarning: lines cut or over their shots (rewrite them in narration.yaml):")
        for w in warnings:
            print(f"  - {w}")
    print(f"\n{out / 'narration_report.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
