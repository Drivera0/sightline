"""Token Factory client (sightline/agent/llm.py): no network, no keys."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from sightline.agent.llm import (
    DEFAULT_BASE_URL,
    NO_THINKING,
    ChatResult,
    FakeChatClient,
    LLMError,
    TokenFactoryClient,
    assistant_message,
    token_factory_client,
    tool_message,
)


def _resp(content: str | None, finish: str = "stop", tool_calls: list | None = None):
    msg = SimpleNamespace(content=content, tool_calls=tool_calls)
    return SimpleNamespace(
        choices=[SimpleNamespace(message=msg, finish_reason=finish)],
        usage=SimpleNamespace(prompt_tokens=12, completion_tokens=5),
        model="m",
    )


class _StubOpenAI:
    """Stands in for ``openai.OpenAI``: records kwargs, returns or raises scripted outcomes."""

    def __init__(self, *outcomes) -> None:
        self.outcomes = list(outcomes)
        self.kwargs: list[dict] = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.kwargs.append(kwargs)
        out = self.outcomes.pop(0)
        if isinstance(out, Exception):
            raise out
        return out


class _Status(Exception):
    def __init__(self, status_code: int) -> None:
        super().__init__(f"HTTP {status_code}")
        self.status_code = status_code


def _client(*outcomes, **kw) -> tuple[TokenFactoryClient, _StubOpenAI]:
    stub = _StubOpenAI(*outcomes)
    return TokenFactoryClient("k", client=stub, sleep=lambda _: None, **kw), stub


def test_reply_is_stripped_and_usage_reported() -> None:
    client, _ = _client(_resp("\n  planner ready \n"))
    r = client.chat([{"role": "user", "content": "hi"}], model="m")
    assert r == ChatResult("planner ready", [], "m", r.ms, 12, 5)


def test_images_go_as_data_uris_on_the_last_user_message(tmp_path: Path) -> None:
    img = tmp_path / "crop.jpg"
    img.write_bytes(b"\xff\xd8jpeg")
    messages = [{"role": "user", "content": "is this a person?"}]
    client, stub = _client(_resp("yes"))
    client.chat(messages, model="m", images=[img])
    sent = stub.kwargs[0]["messages"][0]["content"]
    assert sent[0] == {"type": "text", "text": "is this a person?"}
    assert sent[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    assert messages[0]["content"] == "is this a person?"  # caller's list untouched


def test_extra_body_merges_client_and_call() -> None:
    client, stub = _client(_resp("a"), _resp("b"), extra_body=NO_THINKING)
    client.chat([{"role": "user", "content": "x"}], model="m")
    client.chat([{"role": "user", "content": "x"}], model="m", extra_body={"top_k": 1})
    assert stub.kwargs[0]["extra_body"] == NO_THINKING
    assert stub.kwargs[1]["extra_body"] == {**NO_THINKING, "top_k": 1}


def test_no_extra_body_by_default() -> None:
    client, stub = _client(_resp("a"))
    client.chat([{"role": "user", "content": "x"}], model="m")
    assert "extra_body" not in stub.kwargs[0]


def test_retries_429_and_5xx_then_succeeds() -> None:
    client, stub = _client(_Status(429), _Status(503), _resp("ok"))
    assert client.chat([{"role": "user", "content": "x"}], model="m").text == "ok"
    assert len(stub.kwargs) == 3


def test_gives_up_after_three_retries_and_not_on_4xx() -> None:
    client, stub = _client(*[_Status(500)] * 4)
    with pytest.raises(_Status):
        client.chat([{"role": "user", "content": "x"}], model="m")
    assert len(stub.kwargs) == 4
    client, stub = _client(_Status(400), _resp("never"))
    with pytest.raises(_Status):
        client.chat([{"role": "user", "content": "x"}], model="m")
    assert len(stub.kwargs) == 1


def test_empty_reply_from_thinking_out_of_tokens_is_an_error() -> None:
    client, _ = _client(_resp(None, finish="length"))
    with pytest.raises(LLMError, match="max_tokens"):
        client.chat([{"role": "user", "content": "x"}], model="m", max_tokens=40)


def test_tool_calls_are_parsed() -> None:
    tc = SimpleNamespace(
        id="call_1", function=SimpleNamespace(name="zoom", arguments='{"px": 384}')
    )
    client, _ = _client(_resp(None, finish="tool_calls", tool_calls=[tc]))
    r = client.chat([{"role": "user", "content": "x"}], model="m", tools=[{"type": "function"}])
    assert r.tool_calls == [{"id": "call_1", "name": "zoom", "arguments": {"px": 384}}]
    bad = SimpleNamespace(id="call_2", function=SimpleNamespace(name="zoom", arguments="{nope"))
    client, _ = _client(_resp(None, finish="tool_calls", tool_calls=[bad]))
    with pytest.raises(LLMError, match="not valid JSON"):
        client.chat([{"role": "user", "content": "x"}], model="m")


def test_tool_results_go_back_with_their_call_ids() -> None:
    """Two rounds, as lane E's radio desk does: the second request carries the assistant's tool
    calls and one tool message per call id, in the shape the OpenAI API requires."""
    tc = SimpleNamespace(
        id="call_7", function=SimpleNamespace(name="get_conditions", arguments="{}")
    )
    client, stub = _client(_resp(None, finish="tool_calls", tool_calls=[tc]), _resp("Wind 18."))
    messages = [{"role": "user", "content": "Sightline, Team Two, wind? over"}]
    first = client.chat(messages, model="m", tools=[{"type": "function"}])
    messages += [assistant_message(first), tool_message("call_7", {"wind_kmh": 18})]
    assert client.chat(messages, model="m", tools=[{"type": "function"}]).text == "Wind 18."
    sent = stub.kwargs[1]["messages"]
    assert sent[1] == {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "id": "call_7",
                "type": "function",
                "function": {"name": "get_conditions", "arguments": "{}"},
            }
        ],
    }
    assert sent[2] == {"role": "tool", "tool_call_id": "call_7", "content": '{"wind_kmh": 18}'}


def test_fake_llm_env_needs_no_key(monkeypatch) -> None:
    monkeypatch.setenv("SIGHTLINE_FAKE_LLM", "1")
    monkeypatch.delenv("NEBIUS_API_KEY", raising=False)
    client = token_factory_client()
    assert isinstance(client, FakeChatClient)
    assert client.chat([{"role": "user", "content": "anything"}], model="m").text == "{}"


def test_factory_needs_the_key_and_defaults_the_base_url(monkeypatch) -> None:
    monkeypatch.delenv("SIGHTLINE_FAKE_LLM", raising=False)
    monkeypatch.delenv("NEBIUS_API_KEY", raising=False)
    with pytest.raises(LLMError, match="NEBIUS_API_KEY"):
        token_factory_client()
    monkeypatch.setenv("NEBIUS_API_KEY", "sk-test")
    monkeypatch.delenv("NEBIUS_BASE_URL", raising=False)
    client = token_factory_client()
    assert str(client._client.base_url) == DEFAULT_BASE_URL


def test_fake_client_scripts_replies_in_order_and_records_calls(tmp_path: Path) -> None:
    fake = FakeChatClient({"verify": ["{not json", '{"person": "yes"}']}, default="ok")
    msgs = [{"role": "user", "content": "please verify this crop"}]
    assert fake.chat(msgs, model="vl", images=[tmp_path / "a.jpg"]).text == "{not json"
    assert fake.chat(msgs, model="vl").text == '{"person": "yes"}'
    assert fake.chat(msgs, model="vl").text == '{"person": "yes"}'  # last reply repeats
    assert fake.chat([{"role": "user", "content": "other"}], model="m").text == "ok"
    assert fake.calls[0]["images"] == [tmp_path / "a.jpg"]
    with pytest.raises(KeyError):
        FakeChatClient().chat(msgs, model="m")


def test_fake_client_raises_scripted_exceptions() -> None:
    fake = FakeChatClient({"x": TimeoutError("slow")})
    with pytest.raises(TimeoutError):
        fake.chat([{"role": "user", "content": "x"}], model="m")


LAZY_MODULES = [
    "sightline.agent.llm",
    "sightline.agent.trace",
    "sightline.agent.hooks",
    "sightline.ml.backend",
    "sightline.agent.relook",
    "sightline.agent.verify",
]


def test_importing_lane_a_does_not_import_openai_or_torch() -> None:
    code = (
        f"import sys, {', '.join(LAZY_MODULES)}; "
        "bad = [m for m in ('openai', 'torch', 'ultralytics') if m in sys.modules]; "
        "sys.exit(f'imported {bad}' if bad else 0)"
    )
    root = Path(__file__).resolve().parents[2]
    r = subprocess.run(
        [sys.executable, "-c", code], check=False, cwd=root, capture_output=True, text=True
    )
    assert r.returncode == 0, r.stderr or r.stdout


def test_leaked_reasoning_is_stripped_from_the_reply() -> None:
    """Seen live after a tool call, thinking off: the radio spoke the model's reasoning."""
    leaked = (
        "Team Two, Sightline. Now respond per rules, start with callsign then Sightline. Keep brief.\n"
        "</think>\nTeam Two, Sightline. Sector Bravo Three, entry east ridge, over."
    )
    client, _ = _client(_resp(leaked))
    r = client.chat([{"role": "user", "content": "x"}], model="m")
    assert r.text == "Team Two, Sightline. Sector Bravo Three, entry east ridge, over."
    client, _ = _client(_resp("<think>plan the answer</think> Copy, over."))
    assert client.chat([{"role": "user", "content": "x"}], model="m").text == "Copy, over."
