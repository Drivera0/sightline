"""Runs the agent loop off the pipeline's thread (LANE_A §2, §4).

Hooks put a job on a bounded queue and return; one worker thread takes jobs in order and calls
``loop.handle``. Model calls go through ``BudgetClient``: at most ``MAX_CONCURRENT_MODEL_CALLS``
at once, and a per-mission token budget after which the agent stops calling models for that
mission and says so once with a ``mission.note`` event (planner proposals continue; briefings
fall back to the template). A failed job is logged and traced, never raised.
"""

from __future__ import annotations

import logging
import os
import queue
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from sightline.agent import loop
from sightline.agent.llm import NO_THINKING, ChatClient, ChatResult, LLMError
from sightline.agent.trace import trace_call

log = logging.getLogger(__name__)

MAX_CONCURRENT_MODEL_CALLS = 4
QUEUE_SIZE = 1000
DEFAULT_BUDGET_TOKENS = int(os.environ.get("SIGHTLINE_AGENT_BUDGET_TOKENS", "2000000"))


class BudgetExceeded(LLMError):
    """The mission has used its token budget; no more model calls for it."""


@dataclass
class BudgetClient:
    """A ``ChatClient`` that counts one mission's tokens and caps concurrent calls."""

    client: ChatClient
    budget_tokens: int
    semaphore: threading.Semaphore
    on_exceeded: Callable[[], None] = lambda: None
    used: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def chat(self, messages: list[dict], **kw: Any) -> ChatResult:
        with self._lock:
            if self.used >= self.budget_tokens:
                raise BudgetExceeded(f"token budget of {self.budget_tokens} used")
        with self.semaphore:
            result = self.client.chat(messages, **kw)
        with self._lock:
            before, self.used = self.used, self.used + result.tokens_in + result.tokens_out
            if before < self.budget_tokens <= self.used:
                self.on_exceeded()
        return result


@dataclass(frozen=True)
class Job:
    event: str
    store: Any
    mission_id: str
    ref: str
    answer: str | None = None


def _default_client() -> ChatClient | None:
    from sightline.agent.llm import token_factory_client

    try:
        return token_factory_client(extra_body=NO_THINKING)
    except LLMError as e:  # no key: run without models (planner proposals still go out)
        log.warning("agent runs without a model client: %s", e)
        return None


def _default_detector() -> Any:
    from sightline.ml.backend import make_detector

    try:
        return make_detector(backend="cv2")
    except (FileNotFoundError, ImportError) as e:
        log.warning("agent runs without a detector for re-detection: %s", e)
        return None


class Runner:
    def __init__(
        self,
        *,
        client_factory: Callable[[], ChatClient | None] = _default_client,
        detector_factory: Callable[[], Any] = _default_detector,
        budget_tokens: int = DEFAULT_BUDGET_TOKENS,
        queue_size: int = QUEUE_SIZE,
    ) -> None:
        self._client_factory = client_factory
        self._detector_factory = detector_factory
        self._budget = budget_tokens
        self._queue: queue.Queue[Job | None] = queue.Queue(maxsize=queue_size)
        self._semaphore = threading.Semaphore(MAX_CONCURRENT_MODEL_CALLS)
        self._clients: dict[str, BudgetClient | None] = {}
        self._base: ChatClient | None = None
        self._detector: Any = None
        self._ready = False
        self._thread: threading.Thread | None = None
        self._start_lock = threading.Lock()

    def submit(self, job: Job) -> bool:
        """Enqueue without blocking; ``False`` (logged) if the queue is full."""
        self._ensure_started()
        try:
            self._queue.put_nowait(job)
            return True
        except queue.Full:
            log.error("agent queue full; dropped %s %s for %s", job.event, job.ref, job.mission_id)
            return False

    def drain(self) -> None:
        """Block until every submitted job is done (tests, shutdown)."""
        self._queue.join()

    def stop(self) -> None:
        if self._thread is not None:
            self._queue.put(None)
            self._thread.join()
            self._thread = None

    def _ensure_started(self) -> None:
        if self._thread is None:
            with self._start_lock:
                if self._thread is None:
                    self._thread = threading.Thread(target=self._work, name="agent", daemon=True)
                    self._thread.start()

    def _client_for(self, store: Any, mission_id: str) -> BudgetClient | None:
        if mission_id not in self._clients:
            if self._base is None:
                return None

            def exceeded() -> None:
                store.emit(
                    mission_id,
                    "mission.note",
                    f"Agent token budget ({self._budget}) used: no more model calls for this "
                    "mission. Planner proposals continue; briefings use a fixed template.",
                )

            self._clients[mission_id] = BudgetClient(
                self._base, self._budget, self._semaphore, exceeded
            )
        return self._clients[mission_id]

    def _work(self) -> None:
        while True:
            job = self._queue.get()
            try:
                if job is None:
                    return
                if not self._ready:  # build the heavy parts on the worker, never in a hook
                    self._base, self._detector = self._client_factory(), self._detector_factory()
                    self._ready = True
                loop.handle(
                    job.event,
                    job.store,
                    job.mission_id,
                    job.ref,
                    client=self._client_for(job.store, job.mission_id),
                    detector=self._detector,
                    answer=job.answer,
                )
            except Exception as e:  # one bad event must not stop the agent
                log.exception(
                    "agent %s %s failed", getattr(job, "event", "?"), getattr(job, "ref", "?")
                )
                try:
                    trace_call(
                        job.store,
                        job.mission_id,
                        actor="agent",
                        kind="note",
                        summary=f"agent {job.event} {job.ref} failed: {type(e).__name__}",
                        refs=[job.ref],
                    )
                except Exception:
                    log.exception("could not trace the failure")
            finally:
                self._queue.task_done()
