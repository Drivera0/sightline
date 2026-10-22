"""Conditions for a search area from live Tavily searches (LANE_B §5.1, B-W1/B-W2): the forecast,
weather warnings and park alerts, turned into ``Conditions`` with sources, plus what the search
derives from them: can the drones fly and until when, how much the weather hides people in
photos, and how exposed a lost person is.

**Fetch.** Three Tavily searches (forecast, warnings, park alerts; advanced, 5 results, the area's
domains), then ``extract`` on the top forecast page for its full text. Cached per area and hour in
``cache_dir/<area-slug>/<YYYYMMDDHH>.json``; a refresh in the same hour reuses it.

**Extract, with sources.** Nemotron (``MODEL_FAST``, JSON) reads the documents and returns, for each
field, a value **and the exact quote** it came from. Code keeps a value only when the quote appears
verbatim in that document, the number is in the quote, and it is in a plausible range; anything
else is null. Never a field without a quote. Alerts keep a title, URL and one sentence.

**Derive (heuristics, labelled):** ``sun_times`` (astral, local, works offline), ``flyability``,
``visibility_factor``, ``exposure_band``: see each function.

**Offline.** No network: the newest cached hour, ``stale: true``; no cache: all null and
``flyable: null`` with the reason. Every Tavily call and the extraction go into the mission's trace
(``actor="conditions"``) when a store is given: that trace is the Tavily evidence.

Built by lane A for lane B (issue #74); lane B owns this file.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta, timezone, tzinfo
from pathlib import Path
from typing import Any, ClassVar, Protocol
from zoneinfo import ZoneInfo

from sightline.contract import Area, ConditionAlert, Conditions

log = logging.getLogger(__name__)

STALE_AFTER = timedelta(minutes=60)
DOC_CHARS = 6000  # per document sent to the model
# Plausible ranges: a value outside is a misread, so null.
RANGES = {
    "wind_kmh": (0, 200),
    "gust_kmh": (0, 250),
    "wind_dir_deg": (0, 360),
    "precip_mm_h": (0, 100),
    "precip_prob": (0, 1),
    "temp_c": (-40, 45),
    "visibility_km": (0, 100),
}
FIELDS = tuple(RANGES)
# A quote must say what it is about, not just hold the number: live, a bare "0" was offered as the
# quote for rain and its chance, and a bare digit is in every document.
QUOTE_WORDS = {
    "wind_kmh": r"km/?h|wind|\b(n|s|e|w|ne|nw|se|sw|vr|calm)\b",
    "gust_kmh": r"gust",
    "wind_dir_deg": r"°|\b(n|s|e|w|ne|nw|se|sw|north|south|east|west)\w*",
    "precip_mm_h": r"mm|rain|precip|shower|drizzle",
    "precip_prob": r"%|percent|chance|pop\b",
    "temp_c": r"°|temperature|high|low|plus|minus|\bc\b",
    "visibility_km": r"km|visib",
}
# What a search team acts on: trails, roads, parks, weather, hazards. Used for alerts from searches
# without trusted local domains.
OPERATIONAL = r"trail|road|clos(ed|ure)|park|weather|wind|rain|snow|storm|fog|fire|flood|avalanche|rockfall|landslide|evacuat"
TZ = "America/Vancouver"  # the demo's area; the local date and hour decide what applies now
ALERT_KINDS = ("closure", "warning", "advisory", "other")


@dataclass(frozen=True)
class AreaQueries:
    """What to search for, per area. The defaults are Mount Seymour's (the demo)."""

    forecast: str = "Environment Canada hourly forecast North Vancouver wind gusts precipitation"
    forecast_domains: tuple[str, ...] = ("weather.gc.ca",)
    alerts: str = "Mount Seymour Provincial Park trail closure advisory"
    alerts_domains: tuple[str, ...] = ("bcparks.ca",)
    warnings: str = "weather warning Metro Vancouver North Shore"
    warnings_domains: tuple[str, ...] = ("weather.gc.ca",)


def queries_for(area: Area) -> AreaQueries:
    """Seymour's queries for the demo area; for any other area, the same searches by its name and the
    last known point's coordinates (a name like "HERIDAL site" alone found a Cincinnati forecast,
    live on AWS), without domain filters."""
    if "seymour" in area.name.lower():
        return AreaQueries()
    n = f"{area.name} near {area.lkp.lat:.2f}, {area.lkp.lon:.2f}"
    return AreaQueries(
        forecast=f"hourly weather forecast {n} wind gusts precipitation",
        forecast_domains=(),
        alerts=f"{n} trail closure park advisory",
        alerts_domains=(),
        warnings=f"weather warning {n}",
        warnings_domains=(),
    )


FAR_KM = 100.0


def _far_away(url: str, lkp: Any) -> bool:
    """True when the URL names coordinates more than FAR_KM from the search area."""
    from urllib.parse import parse_qs, unquote, urlparse

    q = parse_qs(urlparse(url).query)
    lat = lon = None
    if "coords" in q:  # weather.gc.ca: coords=49.316,-123.071
        parts = unquote(q["coords"][0]).split(",")
        if len(parts) == 2:
            lat, lon = parts
    else:
        lat = (q.get("lat") or q.get("latitude") or [None])[0]
        lon = (q.get("lon") or q.get("lng") or q.get("longitude") or [None])[0]
    try:
        la, lo = float(lat), float(lon)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return False  # no coordinates in the URL: nothing to check
    r = 6371.0
    dlat, dlon = math.radians(la - lkp.lat), math.radians(lo - lkp.lon)
    h = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lkp.lat)) * math.cos(math.radians(la)) * math.sin(dlon / 2) ** 2
    )
    return 2 * r * math.asin(math.sqrt(h)) > FAR_KM


class TavilyLike(Protocol):
    """The subset of tavily-python used, so tests can fake it."""

    def search(self, query: str, **kw: Any) -> dict: ...
    def extract(self, urls: list[str], **kw: Any) -> dict: ...


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _t(iso: str) -> datetime:
    return datetime.fromisoformat(iso)


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "area"


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


# --- derive (all heuristics) -------------------------------------------------------------------


def local_tz(lat: float, lon: float) -> tzinfo:
    """The demo area's time zone (Vancouver, with daylight saving); elsewhere the solar offset, one
    hour per 15° of longitude: close enough to pick the local date, without a time-zone database."""
    if 45 <= lat <= 60 and -130 <= lon <= -114:
        return ZoneInfo(TZ)
    return timezone(timedelta(hours=round(lon / 15)))


def sun_times(lat: float, lon: float, day: date, tz: str | tzinfo | None = None) -> tuple[str, str]:
    """(sunset, end of civil twilight) as UTC ISO strings, computed locally with astral, for the
    local calendar ``day`` (time zone: ``local_tz`` unless given)."""
    from astral import Observer
    from astral.sun import sun

    zone = ZoneInfo(tz) if isinstance(tz, str) else tz or local_tz(lat, lon)
    s = sun(Observer(latitude=lat, longitude=lon), date=day, tzinfo=zone)
    iso = lambda t: t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    return iso(s["sunset"]), iso(s["dusk"])


def dawn_time(lat: float, lon: float, day: date, tz: tzinfo | None = None) -> str:
    """Start of civil twilight (first light usable for photos) on the local ``day``, UTC ISO."""
    from astral import Observer
    from astral.sun import dawn

    t = dawn(Observer(latitude=lat, longitude=lon), date=day, tzinfo=tz or local_tz(lat, lon))
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def flyability(
    c: Conditions, fleet_max_wind_kmh: float | None, now: str, dawn: str | None = None
) -> tuple[bool | None, str | None, str]:
    """(flyable, flyable_until, reason). Not flyable before civil dawn (``dawn``) or after civil
    twilight, when gusts (else wind) reach the fleet's lowest wind limit, or with precipitation
    ≥ 1 mm/h. Unknown when no wind data. Until: end of civil twilight (no hourly series is read)."""
    if dawn and _t(now) < _t(dawn):
        return False, None, f"before dawn: no light for photos until {dawn[11:16]} UTC"
    if c.civil_twilight_end and _t(now) >= _t(c.civil_twilight_end):
        return False, None, "after civil twilight: no light for photos"
    gust = c.gust_kmh if c.gust_kmh is not None else c.wind_kmh
    if gust is None:
        return None, None, "no wind data: flyability unknown"
    limit = fleet_max_wind_kmh or 38.0
    if gust >= limit:
        return (
            False,
            None,
            f"{'gusts' if c.gust_kmh is not None else 'wind'} {gust:.0f} km/h at or above the drones' limit of {limit:.0f} km/h",
        )
    if c.precip_mm_h is not None and c.precip_mm_h >= 1.0:
        return False, None, f"rain {c.precip_mm_h:g} mm/h (drones fly below 1 mm/h)"
    return (
        True,
        c.civil_twilight_end,
        f"{'gusts' if c.gust_kmh is not None else 'wind'} {gust:.0f} km/h below the drones' limit of {limit:.0f} km/h",
    )


def visibility_factor(c: Conditions, now: str, text: str = "") -> float:
    """How much of a photo's usual chance to see a person survives the weather (multiplies POD):
    × 0.7 for rain ≥ 0.5 mm/h, × 0.6 for visibility < 2 km or fog/mist in the forecast, × 0.8
    within 30 min of sunset; never below 0.3."""
    f = 1.0
    if c.precip_mm_h is not None and c.precip_mm_h >= 0.5:
        f *= 0.7
    if (c.visibility_km is not None and c.visibility_km < 2) or re.search(
        r"\b(fog|mist)\b", text, re.IGNORECASE
    ):
        f *= 0.6
    if c.sunset and abs((_t(now) - _t(c.sunset)).total_seconds()) <= 1800:
        f *= 0.8
    return round(max(0.3, f), 3)


def exposure_band(c: Conditions, last_seen_at: str | None, now: str) -> tuple[str | None, str]:
    """(band, note): cold-wet-wind exposure risk for the lost person. Points for cold (< 5 °C: 1,
    < 0 °C: 2), wet (≥ 0.5 mm/h: 1, ≥ 2: 2), wind (≥ 20 km/h: 1, ≥ 40: 2), time since last seen
    (≥ 12 h: 1, ≥ 24 h: 2) and night falling within 2 h (1); 0–1 low, 2–3 moderate, 4–5 high,
    ≥ 6 severe. A planning heuristic, not a medical assessment."""
    if c.temp_c is None and c.precip_mm_h is None and c.wind_kmh is None:
        return (
            None,
            "no weather data: exposure unknown (planning heuristic, not a medical assessment)",
        )
    pts, why = 0, []
    if c.temp_c is not None:
        p = 2 if c.temp_c < 0 else 1 if c.temp_c < 5 else 0
        pts += p
        why.append(f"{c.temp_c:g} °C")
    if c.precip_mm_h is not None:
        p = 2 if c.precip_mm_h >= 2 else 1 if c.precip_mm_h >= 0.5 else 0
        pts += p
        why.append(f"rain {c.precip_mm_h:g} mm/h")
    wind = c.gust_kmh if c.gust_kmh is not None else c.wind_kmh
    if wind is not None:
        pts += 2 if wind >= 40 else 1 if wind >= 20 else 0
        why.append(f"wind {wind:g} km/h")
    if last_seen_at:
        hours = (_t(now) - _t(last_seen_at)).total_seconds() / 3600
        pts += 2 if hours >= 24 else 1 if hours >= 12 else 0
        why.append(f"{hours:.0f} h since last seen")
    if c.civil_twilight_end:
        left = (_t(c.civil_twilight_end) - _t(now)).total_seconds() / 3600
        if 0 <= left <= 2:
            pts += 1
            why.append(f"night falls in {left * 60:.0f} min")
    band = "low" if pts <= 1 else "moderate" if pts <= 3 else "high" if pts <= 5 else "severe"
    return band, f"{band}: " + ", ".join(why) + " (planning heuristic, not a medical assessment)"


# --- extract -------------------------------------------------------------------------------------

EXTRACT_PROMPT = """You read weather forecasts, weather warnings and park notices for a search-and-rescue team.
From the numbered documents, give the CURRENT or next-few-hours value of each field, with the exact
quote (copied character for character from that document) that states it, or null if no document
states it. Units: wind and gusts in km/h, wind direction in degrees, precipitation in mm per hour,
precip_prob as a fraction 0-1, temperature in °C, visibility in km. Also list park closures,
advisories and weather warnings for the area. Reply with JSON only:
{"fields": {"wind_kmh": {"value": number|null, "quote": str|null, "doc": int|null}, ... for each of
wind_kmh, gust_kmh, wind_dir_deg, precip_mm_h, precip_prob, temp_c, visibility_km},
 "alerts": [{"kind": "closure|warning|advisory|other", "title": str, "text": "one sentence", "quote": str, "doc": int}]}"""


def _number_in(quote: str, value: float, field: str) -> bool:
    """The value (or, for a probability, the percentage) is written in the quote."""
    nums = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", quote.replace(",", ""))]
    target = value * 100 if field == "precip_prob" else value
    return any(abs(n - target) < 0.51 for n in nums) or (
        field == "temp_c" and any(abs(-n - target) < 0.51 for n in nums)
    )


def extract_fields(
    docs: list[dict],
    client: Any,
    *,
    model: str | None = None,
    now: str | None = None,
    place: str | None = None,
) -> tuple[dict, dict[str, str], list[dict], Any]:
    """(values, field → supporting quote, alerts, the model result). A value is kept only when its
    quote is verbatim in its document, carries the number, and is in range; else null."""
    from sightline.agent.llm import MODEL_FAST

    numbered = "\n\n".join(
        f"[doc {i}] {d.get('title', '')} ({d.get('url', '')})\n{d['text'][:DOC_CHARS]}"
        for i, d in enumerate(docs)
    )
    # Forecast pages are hourly tables: live, two runs minutes apart picked different hours (wind 5,
    # then 20 gusting 40). Say which hour is wanted.
    when = ""
    if now:
        local = _t(now).astimezone(ZoneInfo(TZ))
        when = f"It is now {local:%A %d %B, %H:%M} local time ({TZ}). Use the hour that contains now, else the next hour listed.\n\n"
    r = client.chat(
        [
            {"role": "system", "content": EXTRACT_PROMPT},
            {"role": "user", "content": when + numbered},
        ],
        model=model or MODEL_FAST,
        response_format={"type": "json_object"},
        temperature=0.0,
        max_tokens=1500,
    )
    try:
        data = json.loads(r.text[r.text.find("{") : r.text.rfind("}") + 1])
    except ValueError:
        data = {}
    values: dict[str, float | None] = dict.fromkeys(FIELDS)
    quotes: dict[str, str] = {}
    for field in FIELDS:
        item = (data.get("fields") or {}).get(field) or {}
        v, q, k = item.get("value"), item.get("quote"), item.get("doc")
        if v is None or not q or not isinstance(k, int) or not 0 <= k < len(docs):
            continue
        try:
            v = float(v)
        except (TypeError, ValueError):
            continue
        lo, hi = RANGES[field]
        if (
            not lo <= v <= hi
            or _norm(q) not in _norm(docs[k]["text"])
            or not _number_in(q, v, field)
            or not re.search(QUOTE_WORDS[field], q, re.IGNORECASE)
        ):
            log.info("conditions: %s=%r dropped (quote not verified)", field, v)
            continue
        values[field], quotes[field] = v, q
    alerts = []
    for a in data.get("alerts") or []:
        k, q = a.get("doc"), a.get("quote") or ""
        if (
            not isinstance(k, int)
            or not 0 <= k < len(docs)
            or not q
            or _norm(q) not in _norm(docs[k]["text"])
        ):
            continue
        # Searches without trusted local domains return regional news: live, for an area near Mostar,
        # a road closure 120 km away. Such an alert must name the place.
        about = _norm(f"{a.get('title', '')} {a.get('text', '')} {q}")
        if place and (
            not any(w in about for w in re.findall(r"[a-z]{4,}", _norm(place)))
            or not re.search(OPERATIONAL, about)  # live: a national travel advisory got through
        ):
            continue
        alerts.append(
            {
                "kind": a.get("kind") if a.get("kind") in ALERT_KINDS else "other",
                "title": str(a.get("title") or q)[:120],
                "text": str(a.get("text") or q)[:300],
                "url": docs[k].get("url", ""),
                "quote": q,
            }
        )
    return values, quotes, alerts, r


# --- fetch ---------------------------------------------------------------------------------------


def _tavily() -> TavilyLike:
    if os.environ.get("SIGHTLINE_FAKE_TAVILY") == "1":
        return FakeTavily()
    from tavily import TavilyClient

    return TavilyClient(api_key=os.environ["TAVILY_API_KEY"])


class FakeTavily:
    """``SIGHTLINE_FAKE_TAVILY=1`` (smoke test, demos offline): fixed documents, no network."""

    DOCS: ClassVar[dict[str, dict[str, str]]] = {
        "forecast": {
            "url": "https://weather.gc.ca/fake-forecast",
            "title": "Forecast (fake)",
            "content": "Tonight: Rain. Amount 2 mm. Wind southeast 20 km/h gusting to 40. Low plus 6.",
        },
        "alerts": {
            "url": "https://bcparks.ca/fake-alert",
            "title": "Trail closure (fake)",
            "content": "Lower Seymour trail closed for repairs until further notice.",
        },
        "warnings": {
            "url": "https://weather.gc.ca/fake-warning",
            "title": "No warnings (fake)",
            "content": "No watches or warnings in effect.",
        },
    }

    def search(self, query: str, **kw: Any) -> dict:
        key = "forecast" if "forecast" in query else "alerts" if "closure" in query else "warnings"
        return {"results": [self.DOCS[key]]}

    def extract(self, urls: list[str], **kw: Any) -> dict:
        return {
            "results": [{"url": u, "raw_content": self.DOCS["forecast"]["content"]} for u in urls]
        }


def _trace(store: Any, mission_id: str | None, **kw: Any) -> None:
    if store is not None and mission_id is not None:
        from sightline.agent.trace import trace_call

        trace_call(store, mission_id, actor="conditions", **kw)


def _offline(area: Area, cache: Path, now: str, why: str) -> Conditions:
    files = sorted(cache.glob("*.json"))
    if files:
        c = Conditions.model_validate(json.loads(files[-1].read_text())["conditions"])
        return c.model_copy(
            update={
                "stale": True,
                "flyability_reason": f"{c.flyability_reason} (cached {c.fetched_at}; {why})",
            }
        )
    return Conditions(
        fetched_at=now,
        stale=True,
        area=area.name,
        sources=[],
        wind_kmh=None,
        gust_kmh=None,
        wind_dir_deg=None,
        precip_mm_h=None,
        precip_prob=None,
        temp_c=None,
        visibility_km=None,
        sunset=None,
        civil_twilight_end=None,
        alerts=[],
        flyable=None,
        flyable_until=None,
        flyability_reason=f"no conditions data (offline: {why})",
        visibility_factor=1.0,
        exposure_band=None,
        exposure_note="no weather data (planning heuristic, not a medical assessment)",
    )


def fetch_conditions(
    area: Area,
    *,
    fleet_max_wind_kmh: float | None,
    last_seen_at: str | None,
    cache_dir: Path,
    now: str | None = None,
    queries: AreaQueries | None = None,
    tavily: TavilyLike | None = None,
    client: Any = None,
    store: Any = None,
    mission_id: str | None = None,
) -> Conditions:
    now = now or _now()
    queries = queries or queries_for(area)
    cache = Path(cache_dir) / _slug(area.name)
    cache.mkdir(parents=True, exist_ok=True)
    hour_file = cache / f"{_t(now).strftime('%Y%m%d%H')}.json"
    if hour_file.is_file():
        return Conditions.model_validate(json.loads(hour_file.read_text())["conditions"])
    try:
        tavily = tavily or _tavily()
        docs: list[dict] = []
        for name, q, domains in (
            ("forecast", queries.forecast, queries.forecast_domains),
            ("warnings", queries.warnings, queries.warnings_domains),
            ("alerts", queries.alerts, queries.alerts_domains),
        ):
            kw: dict[str, Any] = {"search_depth": "advanced", "max_results": 5}
            if domains:
                kw["include_domains"] = list(domains)
            res = tavily.search(q, **kw).get("results", [])
            _trace(
                store,
                mission_id,
                kind="tool_call",
                summary=f"Tavily search ({name}): {q}",
                input={"query": q, "domains": list(domains)},
                output={"results": [{"url": r.get("url"), "title": r.get("title")} for r in res]},
            )
            docs += [
                {
                    "url": r.get("url", ""),
                    "title": r.get("title", ""),
                    "text": r.get("content", ""),
                    "search": name,
                }
                for r in res
            ]
        # a page whose URL says it is for somewhere else (weather.gov lat=/lon=, Environment Canada
        # coords=) is dropped, so a far-away forecast can't be quoted as this area's
        kept = [d for d in docs if not _far_away(d["url"], area.lkp)]
        for d in docs:
            if d not in kept:
                _trace(
                    store,
                    mission_id,
                    kind="note",
                    summary=f"skipped (for another place): {d['url']}",
                )
        docs = kept
        top = next((d for d in docs if d["search"] == "forecast"), None)
        if top and top["url"]:
            ext = tavily.extract([top["url"]]).get("results", [])
            _trace(
                store,
                mission_id,
                kind="tool_call",
                summary=f"Tavily extract: {top['url']}",
                input={"urls": [top["url"]]},
                output={
                    "results": [
                        {"url": e.get("url"), "chars": len(e.get("raw_content") or "")} for e in ext
                    ]
                },
            )
            if ext and ext[0].get("raw_content"):
                docs.insert(
                    0,
                    {
                        "url": top["url"],
                        "title": top["title"] + " (full page)",
                        "text": ext[0]["raw_content"],
                        "search": "forecast",
                    },
                )
    except Exception as e:  # noqa: BLE001 - no network, no key, Tavily down: never block the search
        log.warning("conditions offline: %s", e)
        return _offline(area, cache, now, type(e).__name__)

    if client is None:
        from sightline.agent.llm import LLMError, token_factory_client

        try:
            from sightline.agent.llm import NO_THINKING

            client = token_factory_client(extra_body=NO_THINKING)
        except LLMError:
            client = None
    values: dict[str, float | None] = dict.fromkeys(FIELDS)
    quotes: dict[str, str] = {}
    alerts: list[dict] = []
    if client is not None and docs:
        try:
            # with trusted local domains (the demo area), any alert they return is local
            local = bool(queries.alerts_domains)
            values, quotes, alerts, r = extract_fields(
                docs, client, now=now, place=None if local else area.name.split(",")[0]
            )
            _trace(
                store,
                mission_id,
                kind="model_call",
                summary="conditions extracted with quotes",
                input={"documents": [d["url"] for d in docs]},
                output={
                    "fields": {
                        k: {"value": values[k], "quote": quotes.get(k)}
                        for k in FIELDS
                        if values[k] is not None
                    },
                    "alerts": [{"title": a["title"], "quote": a["quote"]} for a in alerts],
                },
                result=r,
            )
        except Exception as e:  # noqa: BLE001 - a failed extraction leaves the fields null
            log.warning("conditions extraction failed: %s", e)

    lkp = area.lkp
    # The local date, not the UTC one: in Vancouver every evening is already tomorrow in UTC, and
    # live that gave tomorrow's sunset at 19:00 local and "flyable" in the dark.
    zone = local_tz(lkp.lat, lkp.lon)
    local_day = _t(now).astimezone(zone).date()
    sunset, dusk = sun_times(lkp.lat, lkp.lon, local_day, zone)
    base = Conditions(
        fetched_at=now,
        stale=False,
        area=area.name,
        sources=sorted({d["url"] for d in docs if d["url"]}),
        wind_kmh=values["wind_kmh"],
        gust_kmh=values["gust_kmh"],
        wind_dir_deg=values["wind_dir_deg"],
        precip_mm_h=values["precip_mm_h"],
        precip_prob=values["precip_prob"],
        temp_c=values["temp_c"],
        visibility_km=values["visibility_km"],
        sunset=sunset,
        civil_twilight_end=dusk,
        alerts=[
            ConditionAlert(kind=a["kind"], title=a["title"], text=a["text"], url=a["url"])
            for a in alerts
        ],
        flyable=None,
        flyable_until=None,
        flyability_reason="",
        visibility_factor=1.0,
        exposure_band=None,
        exposure_note="",
    )
    flyable, until, reason = flyability(
        base, fleet_max_wind_kmh, now, dawn_time(lkp.lat, lkp.lon, local_day, zone)
    )
    band, note = exposure_band(base, last_seen_at, now)
    # the forecast and the alerts: a fog advisory hides people in photos as much as fog in the forecast
    text = " ".join(d["text"][:DOC_CHARS] for d in docs if d["search"] == "forecast")
    text += " " + " ".join(f"{a.title}. {a.text}" for a in base.alerts)
    c = base.model_copy(
        update={
            "flyable": flyable,
            "flyable_until": until,
            "flyability_reason": reason,
            "visibility_factor": visibility_factor(base, now, text),
            "exposure_band": band,
            "exposure_note": note,
        }
    )
    hour_file.write_text(
        json.dumps(
            {
                "conditions": c.model_dump(mode="json"),
                "quotes": quotes,
                "documents": [
                    {"url": d["url"], "title": d["title"], "search": d["search"]} for d in docs
                ],
            },
            indent=2,
        )
    )
    return c
