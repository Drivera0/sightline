"""Speech to text for the radio desk (LANE_E §8.2–§8.3).

``ParakeetAsr`` runs NVIDIA Parakeet TDT 0.6B v2 through NeMo; NeMo and torch are imported
lazily, so this module imports without them and tests use ``FakeAsr``. Spike numbers (RTX 4080,
WSL2): 32 s to load, 45–130 ms per phrase (``docs/feedback/radio.md``). ``RivaAsr`` is the same model
hosted on build.nvidia.com (Riva gRPC, ``nvidia-riva-client``), used only for measurements.
"""

from __future__ import annotations

import copy
import os
import time
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

PARAKEET = "nvidia/parakeet-tdt-0.6b-v2"

# Radio vocabulary for NeMo's phrase boosting (``ParakeetAsr(boost=RADIO_BOOST)``), written the way
# Parakeet writes words (it is cased and punctuated, and the boosting tree matches tokens, so case
# counts). Off by default: see ``docs/feedback/radio.md``, "Word boosting".
RADIO_BOOST: tuple[str, ...] = (
    "niner", "four niner", "point niner", "fife", "tree",
    "Sightline", "over", "say again", "Say again", "affirmative", "Affirmative", "negative", "Negative",
    "Team One", "Team Two", "Team Three", "Team Four",
    "Bravo Three", "Charlie Four", "Alpha", "Delta", "POD",
)  # fmt: skip
BOOST_ALPHA = 1.0  # NeMo's ``boosting_tree_alpha``: weight of the phrase tree against the model
BOOST_SCORE = 1.0  # NeMo's ``context_score``: bonus per matched token of a phrase


def boosting_overrides(
    phrases: Sequence[str], alpha: float = BOOST_ALPHA, score: float = BOOST_SCORE
) -> dict[str, Any]:
    """The ``decoding.greedy`` keys that turn on NeMo's GPU phrase boosting tree for a TDT or RNN-T
    model under ``greedy_batch`` decoding (NeMo 3.0, ``BoostingTreeModelConfig``); empty when there
    are no phrases."""
    kept = list(dict.fromkeys(p.strip() for p in phrases if p.strip()))
    if not kept:
        return {}
    return {
        "boosting_tree": {
            "key_phrases_list": kept,
            "context_score": score,
            "depth_scaling": 2.0,  # NeMo's value for CTC, RNN-T and TDT
        },
        "boosting_tree_alpha": alpha,
    }


@dataclass(frozen=True)
class AsrResult:
    text: str
    ms: int
    words: list[tuple[str, float, float]]  # word, start_s, end_s (empty if the model gave none)


class Asr(Protocol):
    def transcribe(self, wav_16k_mono: Path) -> AsrResult: ...


class ParakeetAsr:
    """Parakeet on the GPU (or CPU): loads once, warms up on construction. ``boost`` (for example
    ``RADIO_BOOST``) turns on NeMo's phrase boosting for those phrases; ``None`` decodes as shipped."""

    def __init__(
        self,
        model_id: str = PARAKEET,
        device: str = "auto",
        boost: Sequence[str] | None = None,
        boost_alpha: float = BOOST_ALPHA,
        boost_score: float = BOOST_SCORE,
    ) -> None:
        import torch
        from nemo.collections.asr.models import ASRModel

        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        self.device = device
        self.model: Any = ASRModel.from_pretrained(model_id).to(device).eval()
        self._shipped = copy.deepcopy(self.model.cfg.decoding)
        self.boost: dict[str, Any] = {}
        if boost:
            self.set_boost(boost, boost_alpha, boost_score, warm_up=False)
        self._warm_up()

    def set_boost(
        self,
        phrases: Sequence[str] | None,
        alpha: float = BOOST_ALPHA,
        score: float = BOOST_SCORE,
        warm_up: bool = True,
    ) -> None:
        """Rebuild the decoder with a phrase boosting tree (or, with no phrases, as shipped). NeMo
        keeps the new config in ``model.cfg``, so the rebuild that ``transcribe(timestamps=True)``
        triggers keeps the boost."""
        from omegaconf import open_dict

        self.boost = boosting_overrides(phrases or (), alpha, score)
        cfg = copy.deepcopy(self._shipped)
        if self.boost:
            with open_dict(cfg):
                cfg.strategy = (
                    "greedy_batch"  # NeMo's per-utterance greedy TDT decoder has no boosting
                )
                for key, value in self.boost.items():
                    cfg.greedy[key] = value
        self.model.change_decoding_strategy(cfg, verbose=False)
        if warm_up:
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


RIVA_URI = "grpc.nvcf.nvidia.com:443"
# "ai-parakeet-tdt-0_6b-v2" in the NVCF function list (api.nvcf.nvidia.com/v2/nvcf/functions, 2026-10-22).
RIVA_PARAKEET_FUNCTION = "d3fe9151-442b-4204-a70d-5fcc597fd610"
RIVA_BOOST_SCORE = 1.0  # Riva's docs suggest 20–100; on the hosted model 5 already invents words


class RivaAsr:
    """Parakeet TDT 0.6B v2 hosted on build.nvidia.com through Riva's gRPC API, for measurements
    (``scripts/radio_wer.py --riva``). Needs ``nvidia-riva-client`` and ``NVIDIA_API_KEY``. ``boost``
    is Riva's word boosting (``speech_contexts``) at ``boost_score``. ``verbatim`` turns off the hosted
    inverse text normalisation, which writes "four niner point three" as "four niner.3" (local
    Parakeet writes words or plain digits)."""

    def __init__(
        self,
        boost: Sequence[str] | None = None,
        boost_score: float = RIVA_BOOST_SCORE,
        verbatim: bool = True,
        function_id: str = RIVA_PARAKEET_FUNCTION,
        uri: str = RIVA_URI,
    ) -> None:
        import riva.client

        metadata = [
            ["function-id", function_id],
            ["authorization", "Bearer " + os.environ["NVIDIA_API_KEY"]],
        ]
        self.service = riva.client.ASRService(riva.client.Auth(None, True, uri, metadata))
        self.config = riva.client.RecognitionConfig(
            language_code="en-US",
            max_alternatives=1,
            enable_automatic_punctuation=True,
            audio_channel_count=1,
            verbatim_transcripts=verbatim,
        )
        self.boost = list(dict.fromkeys(p.strip() for p in boost or () if p.strip()))
        if self.boost:
            riva.client.add_word_boosting_to_config(self.config, self.boost, boost_score)

    def transcribe(self, wav_16k_mono: Path) -> AsrResult:
        data = Path(wav_16k_mono).read_bytes()
        t0 = time.perf_counter()
        response = self.service.offline_recognize(data, self.config)
        ms = round((time.perf_counter() - t0) * 1000)
        text = " ".join(
            r.alternatives[0].transcript.strip() for r in response.results if r.alternatives
        )
        return AsrResult(text=text, ms=ms, words=[])


class FakeAsr:
    """Scripted transcripts keyed by file stem (tests, CI, laptops without NeMo)."""

    def __init__(self, scripted: dict[str, str]) -> None:
        self.scripted = scripted

    def transcribe(self, wav_16k_mono: Path) -> AsrResult:
        return AsrResult(text=self.scripted[Path(wav_16k_mono).stem], ms=0, words=[])
