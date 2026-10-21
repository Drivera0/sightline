"""Speech to text for the radio desk (LANE_E §8.2–§8.3).

``ParakeetAsr`` runs NVIDIA Parakeet TDT 0.6B v2 through NeMo; NeMo and torch are imported
lazily, so this module imports without them and tests use ``FakeAsr``. Spike numbers (RTX 4080,
WSL2): 32 s to load, 45–130 ms per phrase (``docs/feedback/radio.md``).
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

PARAKEET = "nvidia/parakeet-tdt-0.6b-v2"


@dataclass(frozen=True)
class AsrResult:
    text: str
    ms: int
    words: list[tuple[str, float, float]]  # word, start_s, end_s (empty if the model gave none)


class Asr(Protocol):
    def transcribe(self, wav_16k_mono: Path) -> AsrResult: ...


class ParakeetAsr:
    """Parakeet on the GPU (or CPU): loads once, warms up on construction."""

    def __init__(self, model_id: str = PARAKEET, device: str = "auto") -> None:
        import torch
        from nemo.collections.asr.models import ASRModel

        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        self.device = device
        self.model: Any = ASRModel.from_pretrained(model_id).to(device).eval()
        self._warm_up()

    def _warm_up(self) -> None:
        """One second of silence, so the first radio turn doesn't pay for kernel compilation."""
        import tempfile
        import wave

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "silence.wav"
            with wave.open(str(path), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(16_000)
                w.writeframes(b"\x00\x00" * 16_000)
            self.transcribe(path)

    def transcribe(self, wav_16k_mono: Path) -> AsrResult:
        t0 = time.perf_counter()
        out = self.model.transcribe([str(wav_16k_mono)], timestamps=True, verbose=False)[0]
        ms = round((time.perf_counter() - t0) * 1000)
        stamps = (getattr(out, "timestamp", None) or {}).get("word", [])
        words = [(w["word"], float(w["start"]), float(w["end"])) for w in stamps]
        return AsrResult(text=getattr(out, "text", str(out)), ms=ms, words=words)


class FakeAsr:
    """Scripted transcripts keyed by file stem (tests, CI, laptops without NeMo)."""

    def __init__(self, scripted: dict[str, str]) -> None:
        self.scripted = scripted

    def transcribe(self, wav_16k_mono: Path) -> AsrResult:
        return AsrResult(text=self.scripted[Path(wav_16k_mono).stem], ms=0, words=[])
