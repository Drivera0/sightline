"""Conditions from Tavily (LANE_B §6 tests 1–4, B-W1/B-W2): extraction only with verbatim quotes,
sun times, the derived values on the four fixtures, offline, the trace."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest

from sightline.agent.llm import FakeChatClient
from sightline.contract import Area, Conditions, LatLon
from sightline.geo.conditions import (
    FakeTavily,
    exposure_band,
    extract_fields,
    fetch_conditions,
    flyability,
    sun_times,
    visibility_factor,
)
from tests.agent.fake_store import FakeMissionStore

FIXTURES = Path(__file__).parent / "fixtures"
SEYMOUR = Area(name="Mount Seymour", lkp=LatLon(lat=49.37, lon=-122.945))
DOCS = [
    {
        "url": "https://weather.gc.ca/f",
        "title": "Hourly forecast",
        "text": "15:00 Cloudy. Wind NW 20 km/h gusts 40. Temperature 6°C. Chance of rain 30%.",
    },
    {
        "url": "https://bcparks.ca/a",
        "title": "Advisory",
        "text": "Lower Seymour trail is closed for repairs until further notice.",
    },
]


def _reply(fields: dict, alerts: list | None = None) -> FakeChatClient:
    return FakeChatClient(default=json.dumps({"fields": fields, "alerts": alerts or []}))


# --- test 1: never a value without a verbatim quote ---------------------------------------------


def test_values_are_kept_only_with_a_verbatim_quote_that_says_them() -> None:
    client = _reply(
        {
            "wind_kmh": {"value": 20, "quote": "Wind NW 20 km/h", "doc": 0},
            "gust_kmh": {"value": 40, "quote": "gusts 40", "doc": 0},
            "temp_c": {"value": 6, "quote": "Temperature 6°C", "doc": 0},
            "precip_prob": {"value": 0.3, "quote": "Chance of rain 30%", "doc": 0},
            "visibility_km": {"value": 10, "quote": "Visibility 10 km", "doc": 0},  # not in the doc
            "precip_mm_h": {"value": 2, "quote": "0", "doc": 0},  # a bare digit says nothing
            "wind_dir_deg": {"value": 400, "quote": "Wind NW 20 km/h", "doc": 0},  # out of range
        },
        [
            {
                "kind": "closure",
                "title": "Lower Seymour trail closed",
                "text": "Closed for repairs.",
                "quote": "Lower Seymour trail is closed for repairs",
                "doc": 1,
            },
            {
                "kind": "warning",
                "title": "Invented warning",
                "text": "x",
                "quote": "Snowfall warning in effect",
                "doc": 0,
            },
        ],
    )
    values, quotes, alerts, _ = extract_fields(DOCS, client)
    assert {k: v for k, v in values.items() if v is not None} == {
        "wind_kmh": 20,
        "gust_kmh": 40,
        "temp_c": 6,
        "precip_prob": 0.3,
    }
    assert all(q in DOCS[0]["text"] for q in quotes.values())
    assert [a["title"] for a in alerts] == ["Lower Seymour trail closed"] and alerts[0][
        "url"
    ] == "https://bcparks.ca/a"


def test_a_reply_that_is_not_json_fills_nothing() -> None:
    values, quotes, alerts, _ = extract_fields(DOCS, FakeChatClient(default="Sorry, I can't."))
    assert set(values.values()) == {None} and quotes == {} and alerts == []


# --- test 2: sun times -----------------------------------------------------------------------------


def test_sun_times_for_mount_seymour_on_oct_24() -> None:
    sunset, dusk = sun_times(49.37, -122.945, date(2026, 10, 24))
    assert (
        sunset == "2026-10-25T01:03:22Z" and dusk == "2026-10-25T01:36:46Z"
    )  # 18:03 and 18:36 PDT


def test_the_evening_uses_the_local_date_not_utc(tmp_path: Path) -> None:
    """Found live: at 19:00 in Vancouver it is already tomorrow in UTC, and the UTC date gave
    tomorrow's sunset and "flyable" in the dark."""
    c = fetch_conditions(
        SEYMOUR,
        fleet_max_wind_kmh=38,
        last_seen_at=None,
        cache_dir=tmp_path,
        now="2026-10-22T02:00:00Z",
        tavily=FakeTavily(),
    )
    assert c.sunset.startswith("2026-10-22T01:")  # Oct 21's sunset, 18:0x local
    assert c.flyable is False and "after civil twilight" in c.flyability_reason


# --- test 3: what the search derives, on the four fixtures ----------------------------------------


@pytest.mark.parametrize(
    ("name", "flyable", "vis", "band"),
    [
        ("clear", True, 1.0, "low"),
        ("windy", False, 1.0, "moderate"),
        ("rainy-dusk", False, 0.336, "severe"),
        ("offline", None, 1.0, None),
    ],
)
def test_derived_values_on_the_fixtures(
    name: str, flyable: bool | None, vis: float, band: str | None
) -> None:
    f = json.loads((FIXTURES / f"conditions_{name}.json").read_text())
    c, now = Conditions.model_validate(f["conditions"]), f["now"]
    assert flyability(c, 38, now)[0] is flyable
    assert visibility_factor(c, now) == vis
    b, note = exposure_band(c, f["last_seen_at"], now)
    assert b == band and "planning heuristic, not a medical assessment" in note
    if band:
        assert "°C" in note and "rain" in note and "wind" in note  # the note names its inputs


def test_fog_in_an_advisory_lowers_visibility() -> None:
    c = Conditions.model_validate(
        json.loads((FIXTURES / "conditions_clear.json").read_text())["conditions"]
    )
    assert (
        visibility_factor(c, "2026-10-24T22:00:00Z", "Fog Advisory. Dense fog this morning.") == 0.6
    )
    assert flyability(c, 10, "2026-10-24T22:00:00Z")[0] is False  # a fleet with a 10 km/h limit


# --- test 4: offline, cache, trace -----------------------------------------------------------------


class Down:
    def search(self, query: str, **kw):
        raise ConnectionError("no network")

    def extract(self, urls, **kw):
        raise ConnectionError("no network")


def test_offline_without_a_cache_is_all_null_with_the_reason(tmp_path: Path) -> None:
    c = fetch_conditions(
        SEYMOUR, fleet_max_wind_kmh=38, last_seen_at=None, cache_dir=tmp_path, tavily=Down()
    )
    assert c.stale and c.flyable is None and c.wind_kmh is None
    assert c.flyability_reason == "no conditions data (offline: ConnectionError)"


def test_offline_with_a_cache_serves_it_as_stale_and_a_refresh_in_the_hour_reuses_it(
    tmp_path: Path,
) -> None:
    client = _reply({"wind_kmh": {"value": 20, "quote": "Wind southeast 20 km/h", "doc": 0}})
    now = "2026-10-24T22:00:00Z"
    first = fetch_conditions(
        SEYMOUR,
        fleet_max_wind_kmh=38,
        last_seen_at=None,
        cache_dir=tmp_path,
        now=now,
        tavily=FakeTavily(),
        client=client,
    )
    assert first.wind_kmh == 20 and not first.stale and first.flyable is True
    again = fetch_conditions(
        SEYMOUR,
        fleet_max_wind_kmh=38,
        last_seen_at=None,
        cache_dir=tmp_path,
        now=now,
        tavily=Down(),
    )
    assert again == first  # the same hour: no Tavily call at all
    later = fetch_conditions(
        SEYMOUR,
        fleet_max_wind_kmh=38,
        last_seen_at=None,
        cache_dir=tmp_path,
        now="2026-10-24T23:30:00Z",
        tavily=Down(),
    )
    assert later.stale and later.wind_kmh == 20 and "cached" in later.flyability_reason


def test_every_tavily_call_and_the_extraction_are_in_the_trace(tmp_path: Path) -> None:
    store = FakeMissionStore()
    mid = store.create("m", "Mount Seymour", SEYMOUR.lkp, "live").mission_id
    client = _reply({"wind_kmh": {"value": 20, "quote": "Wind southeast 20 km/h", "doc": 0}})
    fetch_conditions(
        SEYMOUR,
        fleet_max_wind_kmh=38,
        last_seen_at=None,
        cache_dir=tmp_path,
        now="2026-10-24T22:00:00Z",
        tavily=FakeTavily(),
        client=client,
        store=store,
        mission_id=mid,
    )
    entries = [(e.actor, e.kind, e.summary.split(":")[0]) for e in store.trace_entries(mid)]
    assert entries == [
        ("conditions", "tool_call", "Tavily search (forecast)"),
        ("conditions", "tool_call", "Tavily search (warnings)"),
        ("conditions", "tool_call", "Tavily search (alerts)"),
        ("conditions", "tool_call", "Tavily extract"),
        ("conditions", "model_call", "conditions extracted with quotes"),
    ]
    model = store.trace_entries(mid)[-1]
    assert model.output["fields"] == {
        "wind_kmh": {"value": 20.0, "quote": "Wind southeast 20 km/h"}
    }
