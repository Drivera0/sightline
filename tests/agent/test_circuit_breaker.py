"""Token Factory fully down (docs/report/AGENT_EVAL.md, finding 4): ``TokenFactoryClient`` opens a
circuit breaker after ``BREAKER_FAILURES`` failed attempts in a row and fails fast for
``BREAKER_OPEN_S``; the verifier and briefings fall back as for any failed call, and say so in the
trace. A slow, failing model costs the agent's queue a bounded time, not 4 attempts per call."""

from __future__ import annotations

import time
from types import SimpleNamespace

import httpx
import openai
import pytest

from sightline.agent import llm, loop
from sightline.agent.llm import CircuitOpen, TokenFactoryClient, failure_text
from sightline.agent.runner import Job, Runner
from tests.agent.test_loop import _CentreDetector, mission  # noqa: F401 - the fixture

REQ = httpx.Request("POST", "https://token-factory.invalid/v1")


class _Transport:
    """Fails every call (after ``delay_s``, like a timeout) until ``up`` is set."""

    def __init__(self, delay_s: float = 0.0) -> None:
        self.delay_s, self.up, self.calls = delay_s, False, 0
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    def create(self, **kw):
        self.calls += 1
        if not self.up:
            time.sleep(self.delay_s)
            raise openai.APITimeoutError(request=REQ)
        msg = SimpleNamespace(content="Team One, search sector B3.", tool_calls=None)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=msg, finish_reason="stop")],
            usage=SimpleNamespace(prompt_tokens=3, completion_tokens=2),
            model=kw["model"],
        )


class _Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def _ask(c: TokenFactoryClient):
    return c.chat([{"role": "user", "content": "hi"}], model="m")


def test_the_breaker_opens_fails_fast_and_closes_again() -> None:
    clock, t = _Clock(), _Transport()
    c = TokenFactoryClient("k", client=t, sleep=lambda s: None, clock=clock)
    with pytest.raises(openai.APITimeoutError):
        _ask(c)  # a timeout is retried once, not three times
    assert t.calls == 2
    with pytest.raises(openai.APITimeoutError):
        _ask(c)  # its second attempt is the 4th failure in a row: the breaker opens
    assert t.calls == llm.BREAKER_FAILURES
    with pytest.raises(CircuitOpen) as info:
        _ask(c)  # open: no network call at all
    assert t.calls == llm.BREAKER_FAILURES
    assert "CircuitOpen" in failure_text(info.value) and "60 s" in failure_text(info.value)

    clock.t += llm.BREAKER_OPEN_S + 1  # half-open: one call goes through
    t.up = True
    assert _ask(c).text.startswith("Team One")
    t.up = False
    with pytest.raises(openai.APITimeoutError):
        _ask(c)  # closed again: a single failure doesn't reopen it
    assert t.calls == llm.BREAKER_FAILURES + 3


def test_a_failed_trial_call_reopens_it_at_once() -> None:
    clock, t = _Clock(), _Transport()
    c = TokenFactoryClient("k", client=t, sleep=lambda s: None, clock=clock)
    for _ in range(2):
        with pytest.raises(openai.APITimeoutError):
            _ask(c)
    clock.t += llm.BREAKER_OPEN_S + 1
    with pytest.raises(openai.APITimeoutError):
        _ask(c)  # the trial call fails: open again, no retry
    with pytest.raises(CircuitOpen):
        _ask(c)


def test_the_agent_timeout_fits_measured_latencies() -> None:
    # docs/feedback/nebius.md: VL verdict p90 1.65 s (max 2.19 s over 461 calls); first radio call
    # up to 4.5 s. The agent's per-attempt timeout leaves 4x the slowest call seen.
    assert 4 * 4.5 <= llm.AGENT_TIMEOUT_S < llm.TIMEOUT_S


def test_a_down_model_costs_the_queue_a_bounded_time(mission) -> None:  # noqa: F811
    """Two near misses and a tick, with every model attempt hanging ``delay`` then timing out:
    the breaker opens after 4 attempts, everything after fails fast to the fallbacks."""
    store, mid, _ = mission
    delay = 0.3
    t = _Transport(delay_s=delay)
    client = TokenFactoryClient("k", client=t, sleep=lambda s: None)
    runner = Runner(client_factory=lambda: client, detector_factory=_CentreDetector)
    start = time.monotonic()
    for event, ref, answer in (
        ("detection", "f0001-d02", None),
        ("detection", "f0001-d01", None),  # 2 more failed attempts: the breaker opens
        ("review", "f0001-d01", "unsure"),  # a second look while open: fails fast
        ("tick", mid, None),  # assignments with briefings while open: the template
    ):
        runner.submit(Job(event, store, mid, ref, answer))
    runner.drain()
    took = time.monotonic() - start
    runner.stop()

    assert t.calls == llm.BREAKER_FAILURES
    # without the breaker: 3 second looks + the tick's briefings, each 2 attempts of `delay`
    assert took < (llm.BREAKER_FAILURES + 2) * delay
    st = store.state(mid)
    assert {v.person for v in st["verdicts"]} == {"unclear"}
    assert any(p.kind == "assign_sector" for p in st["proposals"])  # planner work went on
    notes = [e.summary for e in store.trace_entries(mid) if e.kind == "note"]
    assert any(n.startswith("No second look") and "CircuitOpen" in n for n in notes)
    assert any(n.startswith("briefing model call failed (CircuitOpen") for n in notes)
    assert all("template used" in n for n in notes if n.startswith("briefing model"))
    assert all(p.briefing for p in st["proposals"] if p.kind == "assign_sector")
    assert loop.check_briefing  # the template stands in, as for any failed call
