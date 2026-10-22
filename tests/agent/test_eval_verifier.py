"""The second-verifier options of scripts/eval_verifier.py, with a mocked client: no keys, no
network, no model files."""

import importlib.util
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

from sightline.agent.llm import FakeChatClient, LLMError, TokenFactoryClient
from sightline.agent.verify import verify
from sightline.ml.types import Box

_PATH = Path(__file__).resolve().parents[2] / "scripts" / "eval_verifier.py"
_spec = importlib.util.spec_from_file_location("eval_verifier", _PATH)
assert _spec and _spec.loader
ev = importlib.util.module_from_spec(_spec)
sys.modules["eval_verifier"] = ev
_spec.loader.exec_module(ev)

VERDICT = {
    "person": "yes",
    "posture": "lying",
    "group_size": 1,
    "clothing": "red jacket",
    "reason": "a small figure on the rocks",
}


def test_second_endpoint_needs_its_own_key(monkeypatch) -> None:
    monkeypatch.delenv("NVIDIA_API_KEY", raising=False)
    with pytest.raises(LLMError, match="NVIDIA_API_KEY"):
        ev.make_client(ev.NVIDIA_BASE_URL, "NVIDIA_API_KEY")


def test_second_endpoint_gets_no_token_factory_flags(monkeypatch) -> None:
    monkeypatch.setenv("NVIDIA_API_KEY", "test-key")
    monkeypatch.setenv("NEBIUS_API_KEY", "other")
    client = ev.make_client(ev.NVIDIA_BASE_URL, "NVIDIA_API_KEY")
    assert isinstance(client, TokenFactoryClient)
    assert client.extra_body is None  # Nemotron's NO_THINKING is not sent to Cosmos
    assert str(client._client.base_url).startswith(ev.NVIDIA_BASE_URL)


def test_paced_spaces_call_starts() -> None:
    now, slept = [0.0], []

    def sleep(s: float) -> None:
        slept.append(s)
        now[0] += s

    paced = ev.Paced(FakeChatClient(default="{}"), 2.0, clock=lambda: now[0], sleep=sleep)
    for _ in range(3):
        paced.chat([{"role": "user", "content": "hi"}], model="m")
    assert slept == [2.0, 2.0]


def test_accuracy_counts_unclear_as_wrong() -> None:
    rows = [
        {"tp": True, "person": "yes"},
        {"tp": False, "person": "no"},
        {"tp": True, "person": "unclear"},
        {"tp": False, "person": "yes"},
    ]
    assert ev.accuracy(rows) == 0.5
    assert ev.accuracy([]) is None


def test_same_crop_and_prompt_go_to_the_second_model(tmp_path: Path) -> None:
    photo = tmp_path / "p.jpg"
    cv2.imwrite(str(photo), np.full((3000, 4000, 3), 90, np.uint8))
    store, mid = ev.photo_mission(photo, Box(2000, 1500, 2060, 1560), 0.2)
    client = FakeChatClient(default=json.dumps(VERDICT))
    v = verify(store, mid, "f0001-d01", client, detector=None, model=ev.COSMOS_MODEL)
    assert v.person == "yes" and v.model == ev.COSMOS_MODEL
    assert [c["model"] for c in client.calls] == [ev.COSMOS_MODEL]
    assert len(client.calls[0]["images"]) >= 2  # the crop plus at least one re-look image
