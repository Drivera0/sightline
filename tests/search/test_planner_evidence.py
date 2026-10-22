"""Planner reasons name their evidence (planner.sector_moves, evidence_line): what moved a sector
since the last plan, read off the map log, in under 45 words, never "clear" or "rule out"."""

from __future__ import annotations

import re

import pytest

from sightline.contract import Clue, MapUpdate, Team
from sightline.search.grid import cell_center
from sightline.search.live import LiveMap
from sightline.search.planner import (
    REASON_WORDS,
    SectorMove,
    evidence_line,
    propose_assignments,
    propose_legs,
    sector_moves,
)
from sightline.search.sectors import lattice_sectors
from tests.search.test_planner import LKP, NOW, _conditions, _drone, _fleet

NEVER = re.compile(r"\bclear(s|ed|ing)?\b|\brul(e|es|ed|ing) out\b", re.IGNORECASE)


def _clue(live: LiveMap, layout, sector: str, text: str, cid: str) -> Clue:
    cells = layout.cells_of(sector)
    at = cell_center(live.base.grid, int(cells[len(cells) // 2]))
    return Clue(id=cid, kind="object", text=text, lat=at.lat, lon=at.lon, radius_m=40,
                reliability="high", reported_by="T1", source="form", at=NOW,
                confirmed=True)  # fmt: skip


def _photo(layout, sector: str, ref: str, pod: float = 0.5) -> MapUpdate:
    return MapUpdate(seq=1, kind="step", source="frame", ref=ref, at=NOW, canopy=None,
                     cells=[(int(i), pod) for i in layout.cells_of(sector)])  # fmt: skip


def _log(live: LiveMap, *updates: MapUpdate) -> list[MapUpdate]:
    """The updates numbered and applied, as MissionStore.append_map_update does."""
    out = []
    for u in updates:
        u = u.model_copy(update={"seq": len(out) + 1})
        live.apply(u)
        out.append(u)
    return out


@pytest.fixture
def mission():
    """A 400 m map (16 sectors of 100 m), uniform prior; c001 in C2, two photos over B3."""
    live = LiveMap.start(LKP, size_m=400.0, cell_m=10.0)
    layout = lattice_sectors(live.base.grid)
    c1 = _clue(live, layout, "C2", "red jacket near the lake, seen around noon", "c001")
    log = _log(live, live.clue_update(c1), _photo(layout, "B3", "f0001"),
               _photo(layout, "B3", "f0002"))  # fmt: skip
    return live, layout, log, [c1]


def test_a_clue_that_raised_a_sector_is_named_with_its_text(mission) -> None:
    live, layout, log, clues = mission
    moves = sector_moves(live, log, layout, 0, clues)
    c2 = moves["C2"]
    assert c2.now > c2.before and c2.moves[0][0] == "c001 (red jacket near the lake…)"
    line = evidence_line("C2", c2.now, c2)
    assert line.startswith(f"C2 · {c2.now * 100:.1f} % of remaining probability, up from ")
    assert line.endswith(": c001 (red jacket near the lake…) and 2 photos of B3 raised it")
    # the photos over B3 lowered B3 (and raised C2, named there)
    b3 = moves["B3"]
    assert ("2 photos here", pytest.approx(b3.moves[0][1])) == b3.moves[0] and b3.moves[0][1] < 0
    assert "2 photos here lowered it" in evidence_line("B3", b3.now, b3)
    # a clue elsewhere draws probability away: it is named as what lowered a far sector
    a1 = moves["A1"]
    assert evidence_line("A1", a1.now, a1).endswith(": c001 (red jacket near the lake…) lowered it")


def test_only_what_came_after_the_last_plan_is_named(mission) -> None:
    live, layout, log, clues = mission
    after_clue = sector_moves(live, log, layout, 1, clues)  # the last plan saw the clue
    assert all("c001" not in w for w, _ in after_clue["C2"].moves)
    nothing = sector_moves(live, log, layout, len(log), clues)
    c2 = nothing["C2"]
    assert c2.before == c2.now and c2.moves == ()
    assert evidence_line("C2", c2.now, c2) == (
        f"C2 · {c2.now * 100:.1f} % of remaining probability: no new evidence"
    )
    assert evidence_line("C2", c2.now, c2, top=True).endswith(
        ": no new evidence; highest remaining probability of the open sectors"
    )


def test_the_format_of_the_line() -> None:
    move = SectorMove(before=0.026, now=0.055, updates=2, moves=(
        ("c001 (red jacket near the lake)", 0.02), ("c002 (boot prints east)", 0.009)))  # fmt: skip
    assert evidence_line("C2", 0.055, move) == (
        "C2 · 5.5 % of remaining probability, up from 2.6 %: c001 (red jacket near the lake) and "
        "c002 (boot prints east) raised it"
    )
    assert evidence_line("C2", 0.055, None) == "C2 · 5.5 % of remaining probability"


def test_a_leg_reason_leads_with_its_evidence_and_fits_45_words(mission) -> None:
    live, layout, log, clues = mission
    moves = sector_moves(live, log, layout, 0, clues)
    (leg,) = propose_legs(live, layout, _fleet(_drone()), _conditions(), NOW, k=1, moves=moves)
    assert leg.sector_id == "C2"
    assert leg.reason.startswith(evidence_line("C2", moves["C2"].now, moves["C2"]))
    assert "; expected to lower the remaining probability by " in leg.reason
    assert len(leg.reason.split()) <= REASON_WORDS and not NEVER.search(leg.reason)
    # a trigger in front of it (the loop's "After clue c001 in sector C2.") leaves room for it
    (short,) = propose_legs(live, layout, _fleet(_drone()), _conditions(), NOW, k=1,
                            moves=moves, reason_words=REASON_WORDS - 6)  # fmt: skip
    assert len(short.reason.split()) <= REASON_WORDS - 6


def test_reasons_stay_under_45_words_with_many_long_clues() -> None:
    live = LiveMap.start(LKP, size_m=400.0, cell_m=10.0)
    layout = lattice_sectors(live.base.grid)
    long = "a long description of what the reporting party says they saw by the water"
    clues = [_clue(live, layout, "C2", f"{long} {i}", f"c00{i}") for i in range(1, 5)]
    log = _log(live, *(live.clue_update(c) for c in clues), _photo(layout, "C2", "f0001", 0.2))
    moves = sector_moves(live, log, layout, 0, clues)
    teams = [Team(id=f"T{i}", callsign=f"Team {i}", members=3, status="standby", position=None,
                  position_at=None, note=None) for i in (1, 2)]  # fmt: skip
    reasons = [r for _, _, r in propose_assignments(live, layout, [], teams, moves=moves)]
    reasons += [x.reason for x in propose_legs(live, layout, _fleet(_drone("D1"), _drone("D2")),
                                               _conditions(), NOW, moves=moves)]  # fmt: skip
    assert len(reasons) == 4 and "c00" in reasons[0]
    for r in reasons:
        assert len(r.split()) <= REASON_WORDS and not NEVER.search(r), r
