# Conditions from the web: how Sightline uses Tavily

Sightline is the brain of a drone search: drones and ground teams feed one probability map, and the map
tells both where to look next. **Tavily is how it knows the conditions** the search runs in: the
forecast, weather warnings and park or trail alerts for the search area, looked up at run time: checked every
30 minutes for each active mission, with the Tavily results cached per area and clock hour. Four parts of the search act on what comes back.

Code: `sightline/geo/conditions.py`. Evidence from a live run: `docs/evidence/conditions-live-20261021/`
(made by `scripts/conditions_live.py`).

## What a lookup does

Every 30 minutes for each active mission (`CONDITIONS_S` in `sightline/mission/scheduler.py`, and on
`POST /missions/{id}/conditions/refresh`); results are cached per area and clock hour, so the second check
in an hour reuses them and an area costs at most four Tavily calls per hour. A lookup:

1. **Three Tavily searches** (`search_depth="advanced"`, 5 results): the hourly forecast, weather
   warnings, and park and trail alerts, each limited to the sources that publish them for the area
   (Environment Canada, BC Parks for Mount Seymour).
2. **One Tavily extract** of the best forecast page.
3. **Nemotron reads the pages** and returns each value **with the sentence it came from**. A value is kept
   only if that quote is found verbatim in the page, contains the number and names the field (wind,
   gusts, rain…), and the value is in a sane range. Otherwise the field stays empty: nothing is guessed.
4. Sunset and civil twilight are computed locally (astral), for the area's own date and time zone.

Offline, the last values are kept and marked stale with their time; with nothing cached, every field is
empty and the reason says why. Every Tavily call (its query and the result URLs), the extract and every
extracted value with its quote go into the mission's trace (`actor="conditions"`). The key lives only on
the server (AWS Secrets Manager); the browser never sees it.

## What the conditions change

| Where | What changes | Code | Test |
|---|---|---|---|
| **Flying** | The planner proposes no drone leg when gusts exceed the drones' limit, rain is 1 mm/h or more, or it is before dawn or after civil twilight; the agent proposes recalling drones that are in the air, once | `search/planner.py`, `agent/loop.py` | `tests/search/test_planner.py::test_limits`, `tests/agent/test_loop.py::test_unflyable_conditions_recall_drones_once` |
| **What a photo can see** | Fog or haze in a warning lowers the visibility factor; each photo then rules out less of the map (its POD × visibility), and a drop replans the drones | `geo/conditions.py`, `search/live.py`, `mission/pipeline.py` | `tests/geo/test_conditions.py::test_fog_in_an_advisory_lowers_visibility`, `tests/search/test_live.py::test_poor_visibility_lowers_what_a_photo_rules_out`, `tests/agent/test_loop.py::test_visibility_drop_replans` |
| **Where people shelter** | When exposure rises to high or severe, probability shifts toward tree cover (once per level; a labelled planning heuristic) | `search/live.py` (`conditions_update`) | `tests/search/test_live.py::test_worse_exposure_shelters_once_per_level` |
| **What teams hear** | Briefings read to ground teams carry daylight left, wind and gusts, and alerts by name; the radio's "what are the conditions" is answered from them | `agent/loop.py` (`conditions_facts`), `radio/tools.py` | `tests/agent/test_loop.py::test_assignment_briefings_carry_the_conditions` |

## A live run (Mount Seymour, Oct 21, 22:31 PDT)

From `docs/evidence/conditions-live-20261021/trace.jsonl`, the mission's own trace:

```
tool_call  Tavily search (forecast): Environment Canada hourly forecast North Vancouver wind gusts precipitation
           → weather.gc.ca hourly forecast pages (North Vancouver)
tool_call  Tavily search (warnings): weather warning Metro Vancouver North Shore
           → Environment Canada alerts for Metro Vancouver – North Shore
tool_call  Tavily search (alerts): Mount Seymour Provincial Park trail closure advisory
           → bcparks.ca/mount-seymour-park, hiking pages
tool_call  Tavily extract: weather.gc.ca hourly forecast (6,943 characters)
model_call conditions extracted with quotes
           wind_kmh 20  quote "NW 20" · gust_kmh 40  quote "gusts 40" · no alerts
```

What it changed, on the same mission (`effects.json`):

- **Flying:** not flyable ("after civil twilight: no light for photos"); the planner proposed **no legs**.
  (The gust check needs the fleet's wind limit; this mission had no fleet attached when it was fetched.)
- **Briefings:** teams would hear "wind 20 km/h, gusts 40 km/h".
- **Seeing and shelter:** no fog or haze in any warning (visibility factor 1.0) and exposure below high,
  so neither changed the map that night, as they should not. The tests above show both acting on the
  committed condition fixtures (`tests/geo/fixtures/conditions_*.json`: clear, windy, rainy at dusk,
  offline).

An earlier run gave the same values on two runs (`sightline/geo/README.md`); the model is given the current
time so it reads the same forecast hour each time.

## Limits

- Values are only as good as the pages: a forecast phrased unusually leaves a field empty rather than
  guessed. That is deliberate.
- The exposure band and the visibility factor are planning heuristics, labelled so on screen; they move the
  map, they don't measure anything.
- Alerts are kept only when they name the area and are operational (closures, warnings), so a generic
  regional bulletin doesn't trigger a recall.
