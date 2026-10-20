"""The only Token Factory client (contract §14, docs/LANE_A_SPRINT.md §4 and §5.4).

Token Factory (Nebius) is OpenAI-compatible, so ``TokenFactoryClient`` wraps the ``openai`` SDK,
imported lazily. Other lanes type against ``ChatClient`` and test against ``FakeChatClient``.

The Nemotron models think before answering, and the thinking counts against ``max_tokens``: with
20-60 tokens the smoke test (scripts/smoke_nebius.py) got empty replies. ``DEFAULT_MAX_TOKENS``
leaves room for it; pass ``extra_body=NO_THINKING`` to turn thinking off for short answers.
"""

from __future__ import annotations

import base64
import json
import os
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

MODEL_REASON = os.environ.get("SIGHTLINE_MODEL_REASON", "nvidia/nemotron-3-super-120b-a12b")
MODEL_FAST = os.environ.get("SIGHTLINE_MODEL_FAST", "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B")
MODEL_VISION = os.environ.get("SIGHTLINE_MODEL_VISION", "nvidia/Nemotron-3.5-Super-VL")

DEFAULT_BASE_URL = "https://api.tokenfactory.nebius.com/v1/"
# Contract §14 says 800; the reasoning models can spend most of that thinking.
DEFAULT_MAX_TOKENS = 2048
FAKE_LLM_REPLY = "{}"  # valid JSON, so JSON-schema callers parse it and find no fields
NO_THINKING: dict[str, Any] = {"chat_template_kwargs": {"enable_thinking": False}}

TIMEOUT_S = 60.0
RETRIES = 3  # after the first attempt, on 429 / 5xx / timeouts / connection errors
BACKOFF_S = 1.0  # 1 s, 2 s, 4 s

_MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}


class LLMError(RuntimeError):
    """A model call that cannot succeed as asked (not retried)."""


@dataclass(frozen=True)
class ChatResult:
    text: str
    tool_calls: list[dict]  # [{"id": str, "name": str, "arguments": dict}]
    model: str
    ms: int
    tokens_in: int
    tokens_out: int


class ChatClient(Protocol):
    def chat(
        self,
        messages: list[dict],
        *,
        model: str,
        tools: list[dict] | None = None,
        response_format: dict | None = None,
        images: list[Path] | None = None,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        temperature: float = 0.2,
    ) -> ChatResult: ...


def image_part(path: Path) -> dict:
    """One OpenAI ``image_url`` content part with the file inlined as a data URI."""
    path = Path(path)
    mime = _MIME.get(path.suffix.lower(), "image/jpeg")
    b64 = base64.b64encode(path.read_bytes()).decode()
    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}


def with_images(messages: list[dict], images: list[Path] | None) -> list[dict]:
    """``messages`` with the images appended to the last user message (copies, never mutates)."""
    if not images:
        return messages
    out = [dict(m) for m in messages]
    for m in reversed(out):
        if m.get("role") == "user":
            content = m.get("content") or []
            parts = (
                [{"type": "text", "text": content}] if isinstance(content, str) else list(content)
            )
            m["content"] = parts + [image_part(p) for p in images]
            return out
    raise ValueError("images need a user message to attach to")


def last_user_text(messages: list[dict]) -> str:
    for m in reversed(messages):
        if m.get("role") != "user":
            continue
        content = m.get("content") or ""
        if isinstance(content, str):
            return content
        return "\n".join(p.get("text", "") for p in content if p.get("type") == "text")
    return ""


def _parse_tool_calls(raw: list[Any] | None) -> list[dict]:
    calls = []
    for tc in raw or []:
        try:
            args = json.loads(tc.function.arguments or "{}")
        except json.JSONDecodeError as e:
            raise LLMError(f"tool call {tc.function.name}: arguments are not valid JSON") from e
        if not isinstance(args, dict):
            raise LLMError(f"tool call {tc.function.name}: arguments are not a JSON object")
        calls.append({"id": tc.id, "name": tc.function.name, "arguments": args})
    return calls


def assistant_message(result: ChatResult) -> dict:
    """The assistant turn to append to ``messages`` before the tool results, so the next call can
    answer them (the API matches each ``tool`` message to a call by ``id``)."""
    msg: dict[str, Any] = {"role": "assistant", "content": result.text or None}
    if result.tool_calls:
        msg["tool_calls"] = [
            {
                "id": c["id"],
                "type": "function",
                "function": {"name": c["name"], "arguments": json.dumps(c["arguments"])},
            }
            for c in result.tool_calls
        ]
    return msg


def tool_message(call_id: str, content: object) -> dict:
    """A tool's result for the call ``call_id``; non-strings are sent as JSON."""
    text = content if isinstance(content, str) else json.dumps(content)
    return {"role": "tool", "tool_call_id": call_id, "content": text}


def _retryable(e: Exception) -> bool:
    status = getattr(e, "status_code", None)
    if isinstance(status, int):
        return status == 429 or status >= 500
    import openai

    return isinstance(e, openai.APIConnectionError)  # includes APITimeoutError


class TokenFactoryClient:
    """``ChatClient`` over Token Factory: retries on 429/5xx (3, exponential), 60 s timeout.

    ``extra_body`` is sent with every call (merged with a per-call ``extra_body``), e.g.
    ``TokenFactoryClient(..., extra_body=NO_THINKING)``.
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        *,
        extra_body: dict | None = None,
        timeout_s: float = TIMEOUT_S,
        client: Any = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if client is None:
            from openai import OpenAI

            client = OpenAI(api_key=api_key, base_url=base_url, timeout=timeout_s, max_retries=0)
        self._client = client
        self.extra_body = extra_body
        self._sleep = sleep

    def chat(
        self,
        messages: list[dict],
        *,
        model: str,
        tools: list[dict] | None = None,
        response_format: dict | None = None,
        images: list[Path] | None = None,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        temperature: float = 0.2,
        extra_body: dict | None = None,
    ) -> ChatResult:
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": with_images(messages, images),
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if tools:
            kwargs["tools"] = tools
        if response_format:
            kwargs["response_format"] = response_format
        body = {**(self.extra_body or {}), **(extra_body or {})}
        if body:
            kwargs["extra_body"] = body

        start = time.perf_counter()
        for attempt in range(RETRIES + 1):
            try:
                resp = self._client.chat.completions.create(**kwargs)
                break
            except Exception as e:
                if attempt == RETRIES or not _retryable(e):
                    raise
                self._sleep(BACKOFF_S * 2**attempt)
        ms = round((time.perf_counter() - start) * 1000)

        choice = resp.choices[0]
        text = (choice.message.content or "").strip()
        tool_calls = _parse_tool_calls(choice.message.tool_calls)
        if not text and not tool_calls and choice.finish_reason == "length":
            raise LLMError(
                f"{model} used all {max_tokens} max_tokens before answering (thinking counts): "
                "raise max_tokens or pass extra_body=NO_THINKING"
            )
        usage = resp.usage
        return ChatResult(
            text=text,
            tool_calls=tool_calls,
            model=getattr(resp, "model", None) or model,
            ms=ms,
            tokens_in=getattr(usage, "prompt_tokens", 0) or 0,
            tokens_out=getattr(usage, "completion_tokens", 0) or 0,
        )


def token_factory_client(*, extra_body: dict | None = None) -> TokenFactoryClient | FakeChatClient:
    """The client from env: ``NEBIUS_API_KEY`` (required), ``NEBIUS_BASE_URL`` (optional).

    With ``SIGHTLINE_FAKE_LLM=1`` (D's smoke test, demos without a key) it returns a
    ``FakeChatClient`` that answers every prompt with ``FAKE_LLM_REPLY`` and needs no key."""
    if os.environ.get("SIGHTLINE_FAKE_LLM") == "1":
        return FakeChatClient(default=FAKE_LLM_REPLY)
    api_key = os.environ.get("NEBIUS_API_KEY")
    if not api_key:
        raise LLMError("NEBIUS_API_KEY is not set (put it in your environment or .env)")
    base_url = os.environ.get("NEBIUS_BASE_URL") or DEFAULT_BASE_URL
    return TokenFactoryClient(api_key, base_url, extra_body=extra_body)


Reply = str | ChatResult | Exception


@dataclass
class FakeChatClient:
    """Scripted ``ChatClient`` for tests: no network, no keys.

    ``replies`` maps a substring of the last user message to a reply: a string, a ``ChatResult``
    (for tool calls), an exception to raise, or a list of those used in order (the last one
    repeats). The first matching key wins; ``default`` answers anything else. Every call is
    recorded in ``calls``.
    """

    replies: dict[str, Reply | list[Reply]] = field(default_factory=dict)
    default: Reply | None = None
    calls: list[dict] = field(default_factory=list)
    _used: dict[str, int] = field(default_factory=dict, repr=False)

    def chat(
        self,
        messages: list[dict],
        *,
        model: str,
        tools: list[dict] | None = None,
        response_format: dict | None = None,
        images: list[Path] | None = None,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        temperature: float = 0.2,
        extra_body: dict | None = None,
    ) -> ChatResult:
        prompt = last_user_text(messages)
        self.calls.append(
            {
                "messages": messages,
                "model": model,
                "tools": tools,
                "response_format": response_format,
                "images": list(images or []),
                "max_tokens": max_tokens,
                "temperature": temperature,
                "extra_body": extra_body,
            }
        )
        reply = self._pick(prompt)
        if isinstance(reply, Exception):
            raise reply
        if isinstance(reply, ChatResult):
            return reply
        return ChatResult(
            text=reply.strip(),
            tool_calls=[],
            model=model,
            ms=0,
            tokens_in=len(prompt.split()),
            tokens_out=len(reply.split()),
        )

    def _pick(self, prompt: str) -> Reply:
        for key, reply in self.replies.items():
            if key in prompt:
                if isinstance(reply, list):
                    i = self._used.get(key, 0)
                    self._used[key] = i + 1
                    return reply[min(i, len(reply) - 1)]
                return reply
        if self.default is not None:
            return self.default
        raise KeyError(f"FakeChatClient has no reply for: {prompt[:80]!r}")
