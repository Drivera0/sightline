"""``scripts/radio_wer.py`` end to end without NeMo (``--dry-run``): finding recordings in any format,
splitting a one-file take on silence, the WER tables and the worst phrases in ``wer.md``."""

from __future__ import annotations

import importlib.util
import json
import math
import shutil
import struct
import subprocess
import sys
import wave
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("radio_wer", ROOT / "scripts" / "radio_wer.py")
assert spec and spec.loader
wer_mod = importlib.util.module_from_spec(spec)
sys.modules["radio_wer"] = wer_mod
spec.loader.exec_module(wer_mod)

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")
RATE = 16_000


def _write(path: Path, parts: list[tuple[float, bool]]) -> Path:
    """A WAV of (seconds, tone or silence) parts, 16 kHz mono."""
    frames = bytearray()
    for seconds, tone in parts:
        for i in range(round(seconds * RATE)):
            v = int(12_000 * math.sin(2 * math.pi * 440 * i / RATE)) if tone else 0
            frames += struct.pack("<h", v)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(bytes(frames))
    return path


def _run(*args: str, out: Path) -> tuple[str, dict]:
    assert wer_mod.main([*args, "--dry-run", "--out", str(out)]) == 0
    (run,) = out.iterdir()
    return (run / "wer.md").read_text(), json.loads((run / "wer.json").read_text())


def test_word_errors_are_counted_after_the_radio_desks_normalisation() -> None:
    assert wer_mod.edits("Sightline, Team Two, over.", "Sight line team 2 over") == (0, 4)
    assert wer_mod.edits("Say again, over.", "say over") == (1, 3)  # one deletion
    assert wer_mod.edits("Say again, over.", "say again again over") == (1, 3)  # one insertion
    assert wer_mod.edits("Copy, Team Four out.", "") == (4, 4)


def test_parse_silencedetect() -> None:
    log = (
        "  Duration: 00:00:12.50, start: 0.000000, bitrate: 256 kb/s\n"
        "[silencedetect @ 0x1] silence_start: -0.002\n"
        "[silencedetect @ 0x1] silence_end: 0.8 | silence_duration: 0.8\n"
        "[silencedetect @ 0x1] silence_start: 3.1\n"
        "[silencedetect @ 0x1] silence_end: 4.2 | silence_duration: 1.1\n"
        "[silencedetect @ 0x1] silence_start: 11.9\n"
    )
    assert wer_mod.parse_silencedetect(log) == ([(0.0, 0.8), (3.1, 4.2), (11.9, 12.5)], 12.5)


def test_segments_cut_at_the_longest_pauses_and_trim_the_ends() -> None:
    pad = wer_mod.PAD_S
    silences = [
        (0.0, 1.0),
        (2.0, 3.5),
        (4.0, 4.7),
        (5.5, 7.0),
        (8.0, 9.0),
    ]  # the 0.7 s is inside a phrase
    assert wer_mod.speech_segments(silences, 9.0, 3) == [
        (1.0 - pad, 2.0 + pad),
        (3.5 - pad, 5.5 + pad),
        (7.0 - pad, 8.0 + pad),
    ]
    with pytest.raises(ValueError, match="found 2 phrases, expected 4"):
        wer_mod.speech_segments([(2.0, 3.0)], 5.0, 4)


def test_dry_run_without_recordings_writes_the_report(tmp_path: Path) -> None:
    md, data = _run("--recordings", str(tmp_path / "none"), out=tmp_path / "runs")
    assert "MOCK transcripts, not a measurement" in md and "DRY RUN" in data["mode"]
    assert len(data["rows"]) == 60 and set(data["summary"]["conditions"]) == set(
        wer_mod.MOCK_VOICES
    )
    assert "## The 5 worst phrases" in md and md.count("- reference, normalised:") == 5
    rows = data["rows"]
    overall = sum(r["errors"] for r in rows) / sum(r["words"] for r in rows)
    assert data["summary"]["overall"]["wer"] == round(overall, 3)
    assert "| # | Phrase | mock voice A | mock voice B | mock voice C | All |" in md
    for p in range(1, 21):
        assert f"\n| {p} | " in md


def test_no_recordings_without_dry_run_is_an_error(tmp_path: Path) -> None:
    with pytest.raises(SystemExit):
        wer_mod.main(["--recordings", str(tmp_path), "--out", str(tmp_path / "runs")])


@needs_ffmpeg
def test_one_file_per_phrase_any_format(tmp_path: Path) -> None:
    rec = tmp_path / "data"
    for i in range(1, 20):  # phrase 20 not recorded yet
        _write(rec / "dan" / f"{i:02d}.wav", [(0.2, False), (0.6, True), (0.2, False)])
    _write(rec / "dan" / "01.radio.wav", [(0.6, True)])
    (rec / "dan" / "notes.txt").write_text("not audio")
    src = rec / "dan" / "19.wav"
    subprocess.run(  # 19 as m4a: any format ffmpeg reads
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", str(src), str(src.with_suffix(".m4a"))],
        check=True,
    )
    src.unlink()
    md, data = _run("--recordings", str(rec), out=tmp_path / "runs")
    conds = data["summary"]["conditions"]
    assert conds["dan"]["phrases"] == 19 and conds["dan"]["missing"] == [20]
    assert conds["dan + radio sound"]["phrases"] == 1
    assert "Missing recordings: " in md and "; dan: [20]." in md


@needs_ffmpeg
def test_one_file_per_voice_is_split_on_silence(tmp_path: Path) -> None:
    parts: list[tuple[float, bool]] = [(1.0, False)]  # leading silence, trimmed
    for i in range(20):
        if i == 7:  # a hesitation inside phrase 8: shorter than the pauses between phrases
            parts += [(0.4, True), (0.7, False), (0.4, True)]
        else:
            parts += [(0.6, True)]
        parts += [(1.2, False)]
    _write(tmp_path / "data" / "ana" / "take1.wav", parts)
    _, data = _run("--recordings", str(tmp_path / "data"), "--one-file", out=tmp_path / "runs")
    assert data["summary"]["conditions"]["ana"]["phrases"] == 20
    assert [r["phrase"] for r in data["rows"]] == list(range(1, 21))

    work = tmp_path / "work"
    work.mkdir()
    found = wer_mod.recordings(tmp_path / "data", True, 20)
    clips = wer_mod.clips_from_recordings(found, work, 20, -35.0, 0.6)
    lengths = []
    for c in clips:
        with wave.open(str(c.wav)) as w:
            assert w.getframerate() == 16_000 and w.getnchannels() == 1
            lengths.append(w.getnframes() / 16_000)
    assert lengths[7] == pytest.approx(1.5 + 2 * wer_mod.PAD_S, abs=0.1)  # kept whole
    assert all(
        x == pytest.approx(0.6 + 2 * wer_mod.PAD_S, abs=0.1)
        for i, x in enumerate(lengths)
        if i != 7
    )


def test_one_file_mode_refuses_two_takes(tmp_path: Path) -> None:
    for name in ("a.wav", "b.wav"):
        _write(tmp_path / "ana" / name, [(0.1, True)])
    with pytest.raises(ValueError, match="one recording per voice"):
        wer_mod.recordings(tmp_path, True, 20)
