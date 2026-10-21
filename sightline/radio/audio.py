"""Audio in and out of the radio desk (LANE_E §8.3): ffmpeg for conversion, the stdlib for WAVs.

The browser records webm/opus (``MediaRecorder``); a cabled radio gives WAV. Parakeet needs 16 kHz
mono, so everything goes through ``to_mono16k``. Needs ffmpeg on the PATH
(``sudo apt install ffmpeg``; installed on the GPU desktop).
"""

from __future__ import annotations

import shutil
import subprocess
import uuid
import wave
from pathlib import Path

ASR_RATE = 16_000
MIN_SECONDS, MAX_SECONDS = 0.4, 30.0  # shorter or longer clips get "say again" (LANE_E §8.3)
SUFFIX = {"audio/webm": ".webm", "audio/ogg": ".ogg", "audio/wav": ".wav", "audio/x-wav": ".wav"}


class AudioError(ValueError):
    """The clip can't be used: unreadable, too short or too long."""


def to_mono16k(data: bytes, mime: str, out_dir: Path) -> Path:
    """Decode ``data`` (webm/opus, ogg, wav, ...) and write a 16 kHz mono 16-bit WAV in
    ``out_dir``; returns its path."""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise AudioError("ffmpeg is not installed (sudo apt install ffmpeg)")
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = uuid.uuid4().hex[:12]
    src = out_dir / f"{stem}.in{SUFFIX.get(mime.split(';')[0].strip(), '')}"
    dst = out_dir / f"{stem}.wav"
    src.write_bytes(data)
    try:
        r = subprocess.run(
            [
                ffmpeg,
                "-nostdin",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(src),
                "-ac",
                "1",
                "-ar",
                str(ASR_RATE),
                "-sample_fmt",
                "s16",
                str(dst),
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    finally:
        src.unlink(missing_ok=True)
    if r.returncode != 0 or not dst.exists():
        raise AudioError(f"could not decode the audio ({mime}): {r.stderr.strip()[:200]}")
    return dst


def duration_s(path: Path) -> float:
    with wave.open(str(path)) as w:
        return w.getnframes() / w.getframerate()


def check_length(path: Path) -> float:
    """The clip's duration, or ``AudioError`` if it is outside 0.4–30 s."""
    d = duration_s(path)
    if not MIN_SECONDS <= d <= MAX_SECONDS:
        raise AudioError(
            f"clip is {d:.1f} s; radio turns must be {MIN_SECONDS}–{MAX_SECONDS:.0f} s"
        )
    return d
