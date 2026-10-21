"""Text to speech for the radio desk (LANE_E §8.2–§8.3).

``MagpieTts`` runs NVIDIA Magpie TTS multilingual 357M through NeMo (``do_tts``, the model's
baked speakers); NeMo and torch are imported lazily. Spike numbers (RTX 4080, WSL2): 57 s to
load, about 0.5× real time, 22.05 kHz (``docs/feedback/radio.md``). The hosted NIM fallback in
LANE_E §8.2 was not needed in the spike and is not built.
"""

from __future__ import annotations

import io
import re
import threading
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


_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


def split_sentences(text: str, max_words: int = 10) -> list[str]:
    """Chunks to speak one by one, so the first plays while the rest are generated (Magpie runs at
    about 0.66× real time, so time to first sound grows with chunk length): sentences, and any
    sentence over ``max_words`` cut at commas into pieces of at most about that many words."""
    chunks: list[str] = []
    for sentence in (p.strip() for p in _SENTENCE_END.split(text.strip()) if p.strip()):
        if len(sentence.split()) <= max_words:
            chunks.append(sentence)
            continue
        piece: list[str] = []
        for part in re.split(r"(?<=[,;:])\s+", sentence):
            if piece and len(" ".join(piece + [part]).split()) > max_words:
                chunks.append(" ".join(piece))
                piece = []
            piece.append(part)
        chunks.append(" ".join(piece))
    return chunks


def concat_wavs(chunks: list[bytes]) -> bytes:
    """One WAV from several with the same format."""
    frames, params = [], None
    for c in chunks:
        with wave.open(io.BytesIO(c)) as w:
            params = params or w.getparams()
            frames.append(w.readframes(w.getnframes()))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as out:
        out.setparams(params)
        for f in frames:
            out.writeframes(f)
    return buf.getvalue()


class CachedTts:
    """A ``Tts`` that remembers what it has said (callsign openings repeat on every turn) and lets
    one call at a time reach the model. ``warm`` pre-speaks phrases at start-up."""

    def __init__(self, tts: Tts, max_items: int = 256) -> None:
        self.tts = tts
        self.max_items = max_items
        self._cache: dict[tuple[str, str], TtsResult] = {}
        self._lock = threading.Lock()

    def speak(self, text: str, voice: str = "en_female") -> TtsResult:
        key = (text, voice)
        hit = self._cache.get(key)  # outside the lock: a cached phrase never waits for the model
        if hit is not None:
            return TtsResult(wav=hit.wav, sample_rate=hit.sample_rate, ms=0)
        with self._lock:
            result = self.tts.speak(text, voice)
            if len(self._cache) < self.max_items:
                self._cache[key] = result
            return result

    def warm(self, texts: list[str]) -> None:
        for t in texts:
            self.speak(t)
