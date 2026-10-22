"""Clue positions (LANE_B §6 test 5): team position, stale fix, missing team, outside grid, radii."""

from __future__ import annotations

import pytest

from sightline.contract import ClueDraft, LatLon, Team
from sightline.geo.clues import DEFAULT_RADIUS_M, default_radius, resolve_position
from sightline.search.grid import make_grid

LKP = LatLon(lat=49.376, lon=-122.94)
GRID = make_grid(LKP)
NOW = "2026-10-24T22:00:00+00:00"


def _team(position: LatLon | None, at: str | None = "2026-10-24T21:50:00+00:00") -> Team:
    return Team(
        id="T2", callsign="Team Two", members=3, status="searching",
        position=position, position_at=at, note=None,
    )  # fmt: skip


def _draft(**kw) -> ClueDraft:
    base = {"kind": "object", "text": "blue backpack", "lat": None, "lon": None,
            "reported_by": "T2", "source": "radio"}  # fmt: skip
    return ClueDraft.model_validate({**base, **kw})


def test_at_team_position_uses_the_teams_last_fix() -> None:
    lat, lon, warnings = resolve_position(_draft(at_team_position=True), [_team(LKP)], GRID, NOW)
    assert (lat, lon, warnings) == (LKP.lat, LKP.lon, [])


def test_a_stale_fix_is_kept_with_a_warning() -> None:
    _, _, warnings = resolve_position(
        _draft(at_team_position=True), [_team(LKP, "2026-10-24T21:15:00+00:00")], GRID, NOW
    )
    assert warnings == ["Team Two's position is 45 min old"]


def test_no_team_or_no_position_is_an_error() -> None:
    with pytest.raises(ValueError, match="no team"):
        resolve_position(_draft(at_team_position=True, reported_by="T9"), [_team(LKP)], GRID, NOW)
    with pytest.raises(ValueError, match="no known position for Team Two"):
        resolve_position(_draft(at_team_position=True), [_team(None)], GRID, NOW)
    with pytest.raises(ValueError, match="lat/lon"):
        resolve_position(_draft(), [_team(LKP)], GRID, NOW)


def test_outside_the_grid_is_kept_with_a_warning() -> None:
    lat, lon, warnings = resolve_position(_draft(lat=49.5, lon=-122.94), [], GRID, NOW)
    assert (lat, lon) == (49.5, -122.94) and "outside the search grid" in warnings[0]
    assert resolve_position(_draft(lat=49.5, lon=-122.94), [], None, NOW)[2] == []  # no grid yet


def test_default_radii_by_kind_and_a_given_radius_wins() -> None:
    assert {k: default_radius(_draft(kind=k, lat=1, lon=1)) for k in DEFAULT_RADIUS_M} == {
        "object": 30.0, "track": 75.0, "sighting": 100.0, "sound": 200.0, "other": 75.0,
    }  # fmt: skip
    assert default_radius(_draft(lat=1, lon=1, radius_m=12)) == 12


def test_a_position_off_the_globe_is_an_error() -> None:
    with pytest.raises(ValueError, match="latitude must be"):
        resolve_position(_draft(lat=91.0, lon=0.0), [], GRID, NOW)
    with pytest.raises(ValueError, match="longitude -180 to 180"):
        resolve_position(_draft(lat=49.0, lon=-200.0), [], GRID, NOW)
