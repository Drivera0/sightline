"""Text to speech for the radio desk (LANE_E §8.2–§8.3).

``MagpieTts`` runs NVIDIA Magpie TTS multilingual 357M through NeMo (``do_tts``, the model's
baked speakers); NeMo and torch are imported lazily. Spike numbers (RTX 4080, WSL2): 57 s to
load, about 0.5× real time, 22.05 kHz (``docs/feedback/radio.md``). The hosted NIM fallback in
LANE_E §8.2 was not needed in the spike and is not built.
"""

from __future__ import annotations

import io
import time
import wave
from dataclasses import dataclass
from typing import Any, Protocol

import numpy as np

MAGPIE = "nvidia/magpie_tts_multilingual_357m"

# voice name -> Magpie baked speaker index. TODO (lane E, E-13): listen to the speakers and pick one
# female and one male English voice (LANE_E §8.2); 0 is the model's default and what the spike used.
VOICES = {"en_female": 0, "en_male": 0}


@dataclass(frozen=True)
class TtsResult:
    wav: bytes  # a complete 16-bit mono WAV file
    sample_rate: int
    ms: int


class Tts(Protocol):
    def speak(self, text: str, voice: str = "en_female") -> TtsResult: ...


def wav_bytes(samples: np.ndarray, sample_rate: int) -> bytes:
    """Float samples in [-1, 1] as a 16-bit mono WAV file."""
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


class MagpieTts:
    """Magpie on the GPU (or CPU): loads once."""

    def __init__(self, model_id: str = MAGPIE, device: str = "auto") -> None:
        import torch
        from nemo.collections.tts.models import MagpieTTSModel

        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model: Any = MagpieTTSModel.from_pretrained(model_id).to(device).eval()
        self.sample_rate = int(
            getattr(self.model, "sample_rate", None) or self.model.cfg.sample_rate
        )

    def speak(self, text: str, voice: str = "en_female") -> TtsResult:
        import torch

        t0 = time.perf_counter()
        with torch.inference_mode():
            audio, audio_len = self.model.do_tts(text, speaker_index=VOICES.get(voice, 0))
        samples = audio[0, : int(audio_len[0])].float().cpu().numpy()
        ms = round((time.perf_counter() - t0) * 1000)
        return TtsResult(
            wav=wav_bytes(samples, self.sample_rate), sample_rate=self.sample_rate, ms=ms
        )


class FakeTts:
    """200 ms of silence at 22.05 kHz (tests)."""

    sample_rate = 22050

    def speak(self, text: str, voice: str = "en_female") -> TtsResult:
        return TtsResult(
            wav=wav_bytes(np.zeros(self.sample_rate // 5), self.sample_rate),
            sample_rate=self.sample_rate,
            ms=0,
        )
