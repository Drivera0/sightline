"""Periodic work for active missions (LANE_D §5.3, A's ``hooks.on_tick``): the agent's tick every
``TICK_S`` or every ``TICK_PHOTOS`` processed photos (standby teams get ``assign_sector``
proposals), and a conditions refresh every ``CONDITIONS_S`` once lane B's ``fetch_conditions``
exists. A mission is active from its creation or its last photo, for ``ACTIVE_S``.

Done by lane A for lane D (issue #51); lane D owns this file.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from typing import Any

log = logging.getLogger(__name__)

TICK_S = 300.0  # 5 min
TICK_PHOTOS = 25
CONDITIONS_S = 1800.0  # 30 min
ACTIVE_S = 3 * 3600.0
POLL_S = 10.0


class Scheduler:
    def __init__(
        self,
        hooks: Any,
        *,
        refresh_conditions: Callable[[str], None] | None = None,
        clock: Callable[[], float] = time.monotonic,
        tick_s: float = TICK_S,
        tick_photos: int = TICK_PHOTOS,
        conditions_s: float = CONDITIONS_S,
    ) -> None:
        self.hooks = hooks
        self.store: Any = None
        self.refresh_conditions = refresh_conditions
        self.clock = clock
        self.tick_s, self.tick_photos, self.conditions_s = tick_s, tick_photos, conditions_s
        self._lock = threading.Lock()
        self._seen: dict[str, float] = {}  # mission → last activity
        self._ticked: dict[str, float] = {}
        self._photos: dict[str, int] = {}  # photos since the last tick
        self._conditions: dict[str, float] = {}
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    def mission_active(self, mission_id: str) -> None:
        """A mission was created or got a photo: keep its periodic work going."""
        now = self.clock()
        with self._lock:
            self._seen[mission_id] = now
            self._ticked.setdefault(mission_id, now)
            self._conditions.setdefault(mission_id, now)

    def photo_processed(self, mission_id: str) -> None:
        self.mission_active(mission_id)
        with self._lock:
            self._photos[mission_id] = self._photos.get(mission_id, 0) + 1
            due = self._photos[mission_id] >= self.tick_photos
        if due:
            self._tick(mission_id)

    def _tick(self, mission_id: str) -> None:
        with self._lock:
            self._ticked[mission_id] = self.clock()
            self._photos[mission_id] = 0
        if self.hooks is not None and self.store is not None:
            try:
                self.hooks.on_tick(self.store, mission_id)
            except Exception:
                log.exception("on_tick failed for %s", mission_id)

    def run_once(self) -> None:
        """Do whatever is due now (the thread calls this every ``POLL_S``; tests call it)."""
        now = self.clock()
        with self._lock:
            active = [m for m, t in self._seen.items() if now - t < ACTIVE_S]
            ticks = [m for m in active if now - self._ticked[m] >= self.tick_s]
            conds = [m for m in active if now - self._conditions[m] >= self.conditions_s]
            for m in conds:
                self._conditions[m] = now
        for m in ticks:
            self._tick(m)
        if self.store is not None:  # teams out of contact past the mission's check-in interval
            from sightline.mission.command import check_overdue
            from sightline.mission.store import now_iso

            for m in active:
                try:
                    check_overdue(self.store, m, now_iso(), self.hooks)
                except Exception:
                    log.exception("overdue check failed for %s", m)
        if self.refresh_conditions is not None:
            for m in conds:
                try:
                    self.refresh_conditions(m)
                except Exception:
                    log.exception("conditions refresh failed for %s", m)

    def start(self, store: Any) -> None:
        self.store = store
        if self._thread is not None:
            return

        def loop() -> None:
            while not self._stop.wait(POLL_S):
                self.run_once()

        self._thread = threading.Thread(target=loop, name="mission-scheduler", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
