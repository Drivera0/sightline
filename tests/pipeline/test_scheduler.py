"""The mission scheduler: the agent's tick every 5 min or 25 photos; conditions every 30 min."""

from __future__ import annotations

from sightline.mission.scheduler import Scheduler


class Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


class Hooks:
    def __init__(self) -> None:
        self.ticks: list[str] = []

    def on_tick(self, store, mission_id: str) -> None:
        self.ticks.append(mission_id)


def _scheduler(refresh=None):
    clock, hooks = Clock(), Hooks()
    s = Scheduler(hooks, refresh_conditions=refresh, clock=clock)
    s.store = object()
    return s, clock, hooks


def test_ticks_every_five_minutes_while_active() -> None:
    s, clock, hooks = _scheduler()
    s.mission_active("m1")
    clock.t = 299
    s.run_once()
    assert hooks.ticks == []
    clock.t = 300
    s.run_once()
    s.run_once()
    assert hooks.ticks == ["m1"]
    clock.t = 3 * 3600 + 1  # quiet for 3 h: no longer active
    s.run_once()
    assert hooks.ticks == ["m1"]


def test_ticks_every_25_photos() -> None:
    s, clock, hooks = _scheduler()
    for _ in range(24):
        s.photo_processed("m1")
    assert hooks.ticks == []
    s.photo_processed("m1")
    assert hooks.ticks == ["m1"]
    clock.t = 299  # the photo tick reset the 5 min clock
    s.run_once()
    assert hooks.ticks == ["m1"]


def test_conditions_every_thirty_minutes_only_when_lane_b_is_there() -> None:
    refreshed: list[str] = []
    s, clock, _ = _scheduler(refresh=refreshed.append)
    s.mission_active("m1")
    clock.t = 1799
    s.run_once()
    clock.t = 1800
    s.run_once()
    assert refreshed == ["m1"]
    s2, clock2, _ = _scheduler(refresh=None)
    s2.mission_active("m1")
    clock2.t = 1800
    s2.run_once()  # nothing to call, nothing breaks
