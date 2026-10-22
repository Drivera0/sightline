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
| **Flying** | The planner proposes no drone leg when gusts exceed the drones' limit, rain is 1 mm/h or more, or it is before dawn or after civil twilight (the trace and team briefings say why); the agent proposes recalling each drone in the air, once, quoting the fact and its page | `search/planner.py`, `agent/loop.py` | `tests/search/test_planner.py::test_limits`, `tests/agent/test_loop.py::test_unflyable_conditions_recall_each_flying_drone_once`, `tests/agent/test_loop.py::test_the_recall_quotes_the_tavily_fact_its_page_and_the_limit`, `tests/agent/test_recall.py` |
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

## The recall moment

When a lookup (the 30-minute refresh or `POST /conditions/refresh`) comes back with gusts at or above the
fleet's weakest airframe limit (the simulated DJI Mavic 3E's 12 m/s, 43 km/h), or civil twilight has passed,
the agent proposes a recall for **each drone in the air**, one proposal per drone, each for a person to
approve. The reason quotes the fact verbatim with its page and fetch time, for example
`Gusts 50 km/h ("Wind southeast 30 km/h gusting to 50", weather.gc.ca, as of 20:05 UTC) > DJI Mavic 3E limit 43 km/h.`
(`tests/agent/test_loop.py::test_the_recall_quotes_the_tavily_fact_its_page_and_the_limit`), and the
console's approval card shows the quote, a link to the page, and the drone's battery and position. Approving
it cancels the drone's leg the way any re-task does and the drone flies home. While it stays unflyable, no
drone leg is proposed and team briefings say "Drones: grounded, …".

A recall is a `retask_drone` whose leg flies home and whose target has `home`, not a new proposal kind: a new
kind would change the frozen contract (`docs/01_CONTRACT.md` §10), and the re-task path already does what a
recall needs.

Real gusts don't come on cue, so for the demo and the video `POST /missions/{id}/conditions/override` (or
`python -m sightline.client conditions --api URL --mission ID --gust 50`) puts in a synthetic record labelled
`override (demo)` in its sources, its reason, the trace and the feed, and on screen ("Demo override: not
from Tavily"). It is never mixed with a Tavily lookup, it is refused for a real fleet, and the next refresh
replaces it whole. The console's **Fleet controls** strip (demo only) has the same button.

```bash
uv run --extra conditions python scripts/recall_demo.py --serve-local
```

One run on Oct 22 at 02:35 PDT, with **Tavily and the model faked** (`--serve-local`) and the creek scenario's
three simulated drones. It was night, so the real conditions said no flying and the script started from a
calm override (it then skips its fresh lookup, which would have recalled them for the dark instead). The
timeline, wall seconds from the start:

```
  1.2 s  conditions said no flying (before dawn: no light for photos until 14:11 UTC): calm override (demo), gusts 15 km/h
  1.7 s  opening legs approved (scripted): C2, B2, C3
 10.0 s  override (demo): gusts 50 km/h → flyable False: override (demo): gusts 50 km/h at or above the drones' limit of 43 km/h
 10.4 s  proposal p004 Recall Drone 1: fly home now (leaves sector B2, battery 98%): Gusts 50 km/h (override (demo),
         not from Tavily, as of 09:35 UTC) > DJI Mavic 3E limit 43 km/h. Recall Drone 1 to its launch point, under a minute away.
 10.4 s  proposal p005 Recall Drone 2 … p006 Recall Drone 3 (the same reason)
 10.4 s  approved p004, p005, p006 (scripted)
 11.8 s  fleet: Drone 1: L002 cancelled
 11.8 s  fleet: Drone 1: recalled (L004), turns home at 98 % battery
 12.0 s  Drone 1 turning home: battery 97 %, at 49.37644, -122.93877
 14.2 s  all drones home
```

The mission's trace, the conditions and agent entries:

```
09:35:03  conditions tool_call  Tavily search (forecast): Environment Canada hourly forecast North Vancouver wind gusts precipitation
09:35:03  conditions tool_call  Tavily search (warnings): weather warning Metro Vancouver North Shore
09:35:03  conditions tool_call  Tavily search (alerts): Mount Seymour Provincial Park trail closure advisory
09:35:03  conditions tool_call  Tavily extract: https://weather.gc.ca/fake-forecast
09:35:03  conditions model_call conditions extracted with quotes
09:35:04  conditions note       Conditions override (demo) by recall_demo (calm start): gust 15 km/h (not from Tavily)
09:35:12  conditions note       Conditions override (demo) by recall_demo: gust 50 km/h (not from Tavily)
09:35:12  agent      proposal   p004 retask_drone: Recall Drone 1: fly home now (leaves sector B2, battery 98%)
09:35:12  agent      proposal   p005 retask_drone: Recall Drone 2: fly home now (leaves sector C3, battery 98%)
09:35:12  agent      proposal   p006 retask_drone: Recall Drone 3: fly home now (leaves sector C2, battery 98%)
09:35:15  agent      note       No drone legs proposed: not flyable (override (demo): gusts 50 km/h at or above the drones' limit of 43 km/h)
```

The approvals were scripted for the run (`decided_by` says so). With real Tavily, a daytime run also does a
fresh lookup before the override, and a recall from real gusts quotes the forecast page instead of "override
(demo)".

## Limits

- Values are only as good as the pages: a forecast phrased unusually leaves a field empty rather than
  guessed. That is deliberate.
- The exposure band and the visibility factor are planning heuristics, labelled so on screen; they move the
  map, they don't measure anything.
- Alerts are kept only when they name the area and are operational (closures, warnings), so a generic
  regional bulletin doesn't trigger a recall.
