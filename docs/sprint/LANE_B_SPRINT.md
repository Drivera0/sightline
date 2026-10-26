# Workstream B · Geo & Conditions: conditions, clues on the map, assignment cards, photo clients

> Superseded by [`docs/LANE_B_GEO.md`](../LANE_B_GEO.md) (geo, map, integration status) and
> [`docs/report/TAVILY.md`](../report/TAVILY.md) (conditions, with a live run's trace). This file keeps
> the plan, the rules the conditions tool was built to, and each task's outcome.

**Folders:** `sightline/geo/`, `sightline/client/`, `web/src/map/MapView.tsx`, `web/src/map/base/`,
`tests/geo/`, `tests/client/`.

## 1. Mission

1. **Conditions.** Runtime Tavily searches for the forecast, park alerts and closures in the search
   area, turned into structured `Conditions` with sources, and what the search needs from them: can the
   drones fly and until when, how much the weather degrades what photos can see, how urgent it is. The
   point is that conditions **change the flight plan, the map and the briefings**, not that they sit in a
   widget.
2. **Clues and teams on the map:** ground reports get a resolved position and a pin; teams and drones
   get markers and legs.
3. **Assignment cards:** entry point, bearing and distance, waypoints, what to look for, conditions, and
   GPX/KML that open in CalTopo and handheld GPS units.
4. **Photo clients:** `replay` pushes a recorded flight through the live API at drone pace; `watch`
   uploads photos as they land in a folder.

## 2. Rules the conditions tool was built to

- **Never invent weather.** A model extracts each field with the exact quote it came from; code checks
  the quote appears verbatim in the page, the value parses from it and is in a plausible range.
  Anything failing is `null`.
- **Sunset and civil twilight are computed** locally (`astral`), never scraped.
- **Derived values are labelled heuristics:** flyability (gusts or wind at or above the fleet's lowest
  limit, rain at 1 mm/h or more, or after civil twilight), a visibility factor that multiplies photo POD
  (rain, fog, dusk; floor 0.3), and an exposure band (low to severe) that names its inputs and says it
  is not a medical assessment.
- **Offline:** the newest cached result marked stale with its age; with no cache, all fields `null` and
  the reason "offline". Batch mode never waits on conditions.
- **Trace:** each Tavily call (query, domains, URLs and titles, not page text) and each extraction
  (fields and quotes).

The four places conditions act:

| Hook | Where | Effect |
|---|---|---|
| Flyability gate | planner (C) | no legs when not flyable; legs end before `flyable_until` |
| Honest coverage | live map (C) | photo POD × visibility factor |
| Shelter shift | live map (C) | as the exposure band worsens, mass moves toward high-canopy cells |
| Briefing context | briefings (A), console header and cards (E) | launch window, daylight left, closures |

## 3. Work items

| ID | Task | Outcome |
|---|---|---|
| — | GPX/KML writer spike | Done, folded into B-K1 |
| B-W1 | `fetch_conditions`: Tavily, extraction with quotes, cache, offline | Done #75 (`sightline/geo/conditions.py`); at most 4 Tavily calls per area per hour; live run in `docs/evidence/conditions-live-20261021/` |
| B-W2 | Flyability, daylight, visibility factor, exposure band | Done #75; queries pinned to the search area, pages for other places dropped #112 |
| — | The four hooks | Done: planner gate (#67), visibility and shelter in `LiveMap` (#65), briefings (#17); unflyable conditions recall flying drones once |
| B-C1 | `resolve_position` + clue pins | Done #79, #103 (`sightline/geo/clues.py`) |
| B-M3 | `useMap().onPick` | Done #90 |
| B-T1 | Team and drone markers, leg lines | Done #90, #103 (`web/src/map/base/`) |
| B-K1 | `assignment_card`, `to_gpx`, `to_kml` | Done #76 (`sightline/geo/cards.py`); CalTopo import checked #122 |
| B-R1 | `python -m sightline.client replay` | Done #82 |
| B-R2 | `python -m sightline.client watch` | Done #82 |
| — | Tavily write-up | Done #109 (`docs/report/TAVILY.md`) |
| — | Report sections (geo, conditions, responsible use) | Done (`docs/report/OPENCV_REPORT.md`) |

## 4. Tests

`tests/geo/` and `tests/client/` with no network: every non-null field has a verbatim quote; sun times
for Mount Seymour against a fixture; the derived values on four condition fixtures; offline with and
without a cache; clue positions (team position, stale or missing team, outside the grid); card bearing
and distance, entry point on the boundary, at most 40 waypoints, GPX and KML that parse; clients against
a fake API (pacing, resume, partial files, offline queue). Web: `onPick` and the mission layers.

## 5. Cut order

From the bottom: `watch` client · drone and leg layers · KML · visibility factor and shelter shift ·
`replay` · card and GPX · clue pins and team markers · `onPick` · flyability gate and briefing context ·
fetch with sources (never). Nothing was cut.
