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
import logging
import os
import re
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

log = logging.getLogger(__name__)

MODEL_REASON = os.environ.get("SIGHTLINE_MODEL_REASON", "nvidia/nemotron-3-super-120b-a12b")
MODEL_FAST = os.environ.get("SIGHTLINE_MODEL_FAST", "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B")
MODEL_VISION = os.environ.get("SIGHTLINE_MODEL_VISION", "nvidia/Nemotron-3.5-Super-VL")

DEFAULT_BASE_URL = "https://api.tokenfactory.nebius.com/v1/"
# Contract §14 says 800; the reasoning models can spend most of that thinking.
DEFAULT_MAX_TOKENS = 2048
FAKE_LLM_REPLY = "{}"  # valid JSON, so JSON-schema callers parse it and find no fields
NO_THINKING: dict[str, Any] = {"chat_template_kwargs": {"enable_thinking": False}}

TIMEOUT_S = 60.0  # per attempt; conditions read long pages and have no measured latency yet
# The agent's model calls (second look, briefings), per attempt. Measured (docs/feedback/nebius.md):
# VL verdict p50 1.35 s, p90 1.65 s, max 2.19 s over 461 calls; briefings p90 under 1 s; the radio's
# first Super call 3.1-4.5 s. 20 s is over 4x the slowest call seen.
AGENT_TIMEOUT_S = 20.0
RETRIES = 3  # after the first attempt, on 429 / 5xx / timeouts / connection errors
TIMEOUT_RETRIES = 1  # a timeout already cost a whole timeout: retried once, not three times
BACKOFF_S = 1.0  # 1 s, 2 s, 4 s
# Circuit breaker: after this many failed attempts in a row (across calls), every call fails fast
# with CircuitOpen for BREAKER_OPEN_S, then one trial call decides. 4 keeps one call's 3 retries on
# 5xx. Token Factory fully down then costs the agent 4 timed-out attempts in all (2 calls x 2
# attempts: about 4 x 20 s + 2 s of backoff), not 4 attempts of 60 s on every call.
BREAKER_FAILURES = 4
BREAKER_OPEN_S = 60.0

_MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}


_THINK_BLOCK = re.compile(r"<think>.*?</think>", re.DOTALL)


def strip_reasoning(content: str) -> str:
    """The reply without the model's reasoning. With thinking off, Nemotron 3 Super still sometimes
    writes its reasoning into the content after a tool call, ending with ``</think>`` ("Now respond
    per rules ... Keep brief.</think>Team Two, ..."); the radio spoke it aloud. Everything up to the
    last ``</think>`` (and any ``<think>...</think>`` block) is dropped."""
    text = _THINK_BLOCK.sub("", content)
    if "</think>" in text:
        text = text.rsplit("</think>", 1)[1]
    return text.strip()


class LLMError(RuntimeError):
    """A model call that cannot succeed as asked (not retried)."""


class CircuitOpen(LLMError):
    """Token Factory has failed too often in a row: the call fails fast, without the network."""


@dataclass(frozen=True)
class ChatResult:
    text: str
    tool_calls: list[dict]  # [{"id": str, "name": str, "arguments": dict}]
    model: str
    ms: int
    tokens_in: int
    tokens_out: int
    retries: tuple[str, ...] = ()  # why each earlier attempt failed ("HTTP 503", "timeout"), traced


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


def _why(e: Exception) -> str:
    """One failed attempt in a word or two, for the trace: "HTTP 503", "timeout", "connection"."""
    status = getattr(e, "status_code", None)
    if isinstance(status, int):
        return f"HTTP {status}"
    name = type(e).__name__
    return "timeout" if "Timeout" in name else "connection" if "Connection" in name else name


def failure_text(e: Exception) -> str:
    """A failed model call for a trace note: the error, and how often it was tried when the client
    retried it ("InternalServerError after 4 attempts (HTTP 503 ×4)")."""
    if isinstance(e, CircuitOpen):
        return f"CircuitOpen: {e}"
    attempts = getattr(e, "sightline_attempts", None)
    if not attempts or len(attempts) < 2:
        return type(e).__name__
    kinds = list(dict.fromkeys(attempts))
    said = ", ".join(f"{k} ×{attempts.count(k)}" if attempts.count(k) > 1 else k for k in kinds)
    return f"{type(e).__name__} after {len(attempts)} attempts ({said})"


def _retryable(e: Exception) -> bool:
    status = getattr(e, "status_code", None)
    if isinstance(status, int):
        return status == 429 or status >= 500
    import openai

    return isinstance(e, openai.APIConnectionError)  # includes APITimeoutError


class TokenFactoryClient:
    """``ChatClient`` over Token Factory: retries on 429/5xx (3, exponential) and timeouts (1),
    ``timeout_s`` per attempt, and a circuit breaker (``BREAKER_FAILURES`` failed attempts in a row
    → ``CircuitOpen`` for ``BREAKER_OPEN_S``, logged; callers trace it as any failed call).

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
        clock: Callable[[], float] = time.monotonic,
        breaker_failures: int = BREAKER_FAILURES,
        breaker_open_s: float = BREAKER_OPEN_S,
    ) -> None:
        if client is None:
            from openai import OpenAI

            client = OpenAI(api_key=api_key, base_url=base_url, timeout=timeout_s, max_retries=0)
        self._client = client
        self.extra_body = extra_body
        self._sleep = sleep
        self._clock = clock
        self._breaker_failures, self._breaker_open_s = breaker_failures, breaker_open_s
        self._failures = 0  # failed attempts in a row
        self._open_until: float | None = None
        self._trial = False  # half-open: one call is finding out whether it is back
        self._lock = threading.Lock()

    def _admit(self) -> None:
        """Let an attempt through, or raise ``CircuitOpen`` without touching the network."""
        with self._lock:
            if self._open_until is None:
                return
            left = self._open_until - self._clock()
            if left <= 0 and not self._trial:
                self._trial = True  # half-open: this attempt decides
                return
            raise CircuitOpen(
                f"Token Factory failed {self._failures} attempts in a row; calls fail fast "
                f"for {self._breaker_open_s:g} s (next try in {max(0.0, left):.0f} s)"
            )

    def _result(self, ok: bool) -> bool:
        """Count an attempt; True when this failure opened (or reopened) the breaker."""
        with self._lock:
            self._trial = False
            if ok:
                self._failures, self._open_until = 0, None
                return False
            self._failures += 1
            if self._failures < self._breaker_failures:
                return False
            self._open_until = self._clock() + self._breaker_open_s
        log.warning(
            "Token Factory: %d failed attempts in a row, circuit open for %g s",
            self._failures,
            self._breaker_open_s,
        )
        return True

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
        failed: list[str] = []
        for attempt in range(RETRIES + 1):
            self._admit()  # raises CircuitOpen while the breaker is open
            try:
                resp = self._client.chat.completions.create(**kwargs)
                self._result(ok=True)
                break
            except Exception as e:
                failed.append(_why(e))
                retryable = _retryable(e)
                opened = self._result(ok=not retryable)  # a 4xx is our request, not an outage
                if (
                    attempt == RETRIES
                    or not retryable
                    or opened
                    or failed.count("timeout") > TIMEOUT_RETRIES
                ):
                    try:  # the caller's failure note says how often it was tried
                        e.sightline_attempts = failed  # type: ignore[attr-defined]
                    except AttributeError:
                        pass
                    raise
                self._sleep(BACKOFF_S * 2**attempt)
        ms = round((time.perf_counter() - start) * 1000)

        choice = resp.choices[0]
        text = strip_reasoning(choice.message.content or "")
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
            retries=tuple(failed),
        )


def token_factory_client(
    *, extra_body: dict | None = None, timeout_s: float = TIMEOUT_S
) -> TokenFactoryClient | FakeChatClient:
    """The client from env: ``NEBIUS_API_KEY`` (required), ``NEBIUS_BASE_URL`` (optional).

    With ``SIGHTLINE_FAKE_LLM=1`` (D's smoke test, demos without a key) it returns a
    ``FakeChatClient`` that answers every prompt with ``FAKE_LLM_REPLY`` and needs no key."""
    if os.environ.get("SIGHTLINE_FAKE_LLM") == "1":
        return FakeChatClient(default=FAKE_LLM_REPLY)
    api_key = os.environ.get("NEBIUS_API_KEY")
    if not api_key:
        raise LLMError("NEBIUS_API_KEY is not set (put it in your environment or .env)")
    base_url = os.environ.get("NEBIUS_BASE_URL") or DEFAULT_BASE_URL
    return TokenFactoryClient(api_key, base_url, extra_body=extra_body, timeout_s=timeout_s)


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
