"""Photo queues (LANE_D §4, D-P1): where ``POST /photos`` puts jobs and the worker takes them.

``LocalQueue`` runs the worker in a thread of the API process (``SIGHTLINE_QUEUE=local``, the
default). ``SqsQueue`` (AWS, D-W1) is lane D's: same two methods, boto3 long polling, delete after
success, a dead-letter queue after 3 receives.

Done by lane A for lane D (issue #51); lane D owns this file.
"""

from __future__ import annotations

import logging
import queue
import threading
from collections.abc import Callable
from typing import Protocol

from sightline.mission.pipeline import PhotoJob

log = logging.getLogger(__name__)


class PhotoQueue(Protocol):
    def put(self, job: PhotoJob) -> None: ...
    def run_worker(self, handler: Callable[[PhotoJob], None]) -> None: ...


class LocalQueue:
    """One worker thread, so jobs are handled one at a time in the order they were put (which
    keeps each mission's frames in upload order). A failing job is logged and skipped."""

    def __init__(self) -> None:
        self._q: queue.Queue[PhotoJob | None] = queue.Queue()
        self._thread: threading.Thread | None = None

    def put(self, job: PhotoJob) -> None:
        self._q.put(job)

    def run_worker(self, handler: Callable[[PhotoJob], None]) -> None:
        if self._thread is not None:
            raise RuntimeError("the worker is already running")

        def loop() -> None:
            while (job := self._q.get()) is not None:
                try:
                    handler(job)
                except Exception:
                    log.exception("photo job %s/%s failed", job.mission_id, job.frame_id)
                finally:
                    self._q.task_done()
            self._q.task_done()

        self._thread = threading.Thread(target=loop, name="photo-worker", daemon=True)
        self._thread.start()

    def join(self) -> None:
        """Wait until every job put so far is handled (tests, the smoke test)."""
        self._q.join()

    def stop(self) -> None:
        if self._thread is not None:
            self._q.put(None)
            self._thread.join()
            self._thread = None
