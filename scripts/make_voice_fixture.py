"""The demo fixtures' radio lines, spoken: each team in its own Magpie speaker, the desk in speaker 0.

    uv run python scripts/make_command_fixtures.py --scenarios   # the mission and the four scenarios
    uv run python scripts/make_fleet_fixture.py                  # the fleet
    ~/radio-env/bin/python scripts/make_voice_fixture.py         # this: the voices (NeMo env)
    uv run python scripts/make_voice_fixture.py --dry-run        # no NeMo: silent clips, no check

For every radio line of ``web/src/command/__fixtures__/demo_mission.json`` and ``scenarios/*.json``
(the timeline's ``kind: "radio"`` entries) it speaks the line with Magpie TTS multilingual 357M
(``sightline/radio/tts.py``): a team's line (``direction`` "in") in its team's speaker (Team One 1 …
Team Four 4, ``TEAM_SPEAKERS``), the desk's reply or call in speaker 0, sentence by sentence as the radio
desk speaks. Each clip is then **heard back by Parakeet** (TDT 0.6B v2, ``ParakeetAsr``) and scored
against the line (word error rate after ``protocol.normalize``, as ``scripts/radio_wer.py``); Magpie
samples, so a line is spoken up to ``--takes`` times and the take Parakeet heard best is kept. One
model is on the GPU at a time: Magpie speaks every line of a take, is freed, then Parakeet hears them.

Writes ``web/public/voices/<scenario>/<turn_id>.mp3`` (team) and ``<turn_id>-desk.mp3`` (desk), 22.05
kHz mono MP3 at 48 kbps, ``voices.json`` beside them (per clip: the line, the speaker, what Parakeet
heard, its WER, the takes, seconds and bytes; the pooled WER), and the fixtures' timeline ``audio``
(``sightline.radio.voices.attach_audio``; the fixture scripts re-attach on a re-run when the words are
the same). A clip that already says its line (the manifest's key) is kept unless ``--force``. Fails
when the clips pass ``MAX_BYTES`` (3 MB) together. Every clip is synthetic speech, labelled so in the
manifest.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sightline.radio.protocol import normalize
from sightline.radio.voices import (
    MANIFEST,
    VOICES_DIR,
    attach_audio,
    radio_lines,
    text_key,
)

FIX = ROOT / "web/src/command/__fixtures__"
PUBLIC = ROOT / "web/public"
MAX_BYTES = 3_000_000
RATE, BITRATE = 22_050, "48k"


def fixtures() -> list[tuple[str, Path]]:
    """(slug, path) of the story and each scenario fixture."""
    out = [("demo", FIX / "demo_mission.json")]
    out += [(p.stem, p) for p in sorted((FIX / "scenarios").glob("*.json"))]
    return [(s, p) for s, p in out if p.is_file()]


def word_errors(ref: str, hyp: str) -> tuple[int, int]:
    """(word errors, reference words) after ``normalize`` on both sides (Levenshtein over words)."""
    r, h = normalize(ref).split(), normalize(hyp).split()
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev, d[j] = d[j], cur
    return d[len(h)], len(r)


def to_mp3(wav: Path, mp3: Path) -> None:
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-ac", "1", "-ar", str(RATE),
                    "-codec:a", "libmp3lame", "-b:a", BITRATE, str(mp3)], check=True)  # fmt: skip


def to_16k(wav: Path, out: Path) -> Path:
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-ac", "1", "-ar", "16000",
                    str(out)], check=True)  # fmt: skip
    return out


def _free() -> None:
    """Give the GPU back between engines (one model loaded at a time)."""
    import gc

    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass


def speak_all(jobs: list[tuple[str, int, Path]], device: str, dry_run: bool) -> None:
    """Each ``(text, speaker, wav)``: Magpie speaks the text sentence by sentence into ``wav``.
    The model is loaded for this pass only and freed after it."""
    from sightline.radio.tts import FakeTts, concat_wavs, split_sentences, wav_bytes

    if dry_run:
        fake = FakeTts()
        for text, _, wav in jobs:
            wav.write_bytes(fake.speak(text).wav)
        return
    import torch

    from sightline.radio.tts import MagpieTts

    tts = MagpieTts(device=device)
    try:
        for text, speaker, wav in jobs:
            chunks = []
            for part in split_sentences(text, max_words=14):
                with torch.inference_mode():
                    audio, n = tts.model.do_tts(part, speaker_index=speaker)
                chunks.append(
                    wav_bytes(audio[0, : int(n[0])].float().cpu().numpy(), tts.sample_rate)
                )
            wav.write_bytes(concat_wavs(chunks))
    finally:
        del tts
        _free()


def hear_all(jobs: list[tuple[str, Path]], device: str, dry_run: bool) -> list[str]:
    """What Parakeet hears in each ``(text, wav)`` (16 kHz copies made here); loaded for this pass
    only. The dry run hears the line itself."""
    if dry_run:
        return [text for text, _ in jobs]
    from sightline.radio.asr import ParakeetAsr

    asr = ParakeetAsr(device=device)
    try:
        return [asr.transcribe(to_16k(wav, wav.with_suffix(".16k.wav"))).text for _, wav in jobs]
    finally:
        del asr
        _free()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--dry-run", action="store_true", help="silent clips, no NeMo, nothing measured"
    )
    ap.add_argument("--takes", type=int, default=3, help="speak a line up to this many times")
    ap.add_argument("--force", action="store_true", help="speak every line again")
    ap.add_argument("--device", default="auto")
    args = ap.parse_args(argv)
    if shutil.which("ffmpeg") is None:
        print("needs ffmpeg")
        return 1
    # every line of every fixture first, so each engine loads once per take
    plan: list[dict] = []
    docs: dict[str, tuple[Path, dict, dict, dict]] = {}
    for slug, path in fixtures():
        fx = json.loads(path.read_text())
        folder = PUBLIC / VOICES_DIR / slug
        folder.mkdir(parents=True, exist_ok=True)
        try:
            old = json.loads((folder / MANIFEST).read_text())["clips"]
        except (OSError, ValueError, KeyError):
            old = {}
        clips: dict[str, dict] = {}
        docs[slug] = (path, fx, clips, old)
        for _entry, name, speaker, text in radio_lines(fx["timeline"]):
            key = text_key(text, speaker)
            if not args.force and old.get(name, {}).get("key") == key and (folder / name).is_file():
                clips[name] = old[name]
                continue
            plan.append({"slug": slug, "name": name, "speaker": speaker, "text": text, "key": key,
                         "best": None})  # fmt: skip
    with tempfile.TemporaryDirectory() as tmp:
        for take in range(1, args.takes + 1):
            todo = [p for p in plan if p["best"] is None or p["best"][0] > 0]
            if not todo:
                break
            wavs = [Path(tmp) / f"{k}-{take}.wav" for k in range(len(todo))]
            speak_all([(p["text"], p["speaker"], w) for p, w in zip(todo, wavs, strict=True)],
                      args.device, args.dry_run)  # fmt: skip
            heard = hear_all([(p["text"], w) for p, w in zip(todo, wavs, strict=True)],
                             args.device, args.dry_run)  # fmt: skip
            for p, w, h in zip(todo, wavs, heard, strict=True):
                err, words = word_errors(p["text"], h)
                if p["best"] is None or err < p["best"][0]:
                    p["best"] = (err, words, h, take, w)
            print(f"take {take}: {len(todo)} lines spoken and heard")
        for p in plan:
            err, words, heard, take, wav = p["best"]
            folder = PUBLIC / VOICES_DIR / p["slug"]
            to_mp3(wav, folder / p["name"])
            seconds = float(subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                 str(folder / p["name"])], capture_output=True, text=True, check=True).stdout.strip() or 0)  # fmt: skip
            docs[p["slug"]][2][p["name"]] = {
                "key": p["key"], "speaker": p["speaker"], "text": p["text"], "heard": heard,
                "errors": err, "words": words, "wer": round(err / max(1, words), 3), "take": take,
                "seconds": round(seconds, 2), "bytes": (folder / p["name"]).stat().st_size}  # fmt: skip
            print(f"{p['slug']}/{p['name']} speaker {p['speaker']} take {take}: "
                  f"WER {err}/{words}  {p['text']!r} -> {heard!r}")  # fmt: skip
    total_err = total_words = 0
    for slug, (path, fx, clips, _old) in docs.items():
        folder = PUBLIC / VOICES_DIR / slug
        for stale in folder.glob("*.mp3"):
            if stale.name not in clips:
                stale.unlink()
        errs = sum(c["errors"] for c in clips.values())
        words = sum(c["words"] for c in clips.values())
        total_err, total_words = total_err + errs, total_words + words
        (folder / MANIFEST).write_text(json.dumps({
            "note": "Generated by scripts/make_voice_fixture.py: synthetic speech (NVIDIA Magpie TTS "
                    "multilingual 357M; teams in speakers 1-4, the desk in speaker 0), heard back by "
                    "Parakeet TDT 0.6B v2; WER after protocol.normalize."
                    + (" DRY RUN: silent clips, nothing measured." if args.dry_run else ""),
            "wer": round(errs / max(1, words), 3), "errors": errs, "words": words,
            "clips": dict(sorted(clips.items()))}, indent=1, ensure_ascii=False) + "\n")  # fmt: skip
        n = attach_audio(fx["timeline"], slug, PUBLIC)
        path.write_text(json.dumps(fx, indent=1, ensure_ascii=False) + "\n")
        print(f"{slug}: {len(clips)} clips, {n} timeline lines with audio, WER {errs}/{words}")
    size = sum(p.stat().st_size for p in (PUBLIC / VOICES_DIR).rglob("*.mp3"))
    print(f"all: WER {total_err}/{total_words} = {total_err / max(1, total_words):.3f}; "
          f"{size} bytes of MP3")  # fmt: skip
    if size > MAX_BYTES:
        print(f"over {MAX_BYTES} bytes")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
