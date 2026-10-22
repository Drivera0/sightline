# web/src/command: the command view (lane E)

Lane E's folder. Lane E has no owner yet, so lane A built **E-07, the approval inbox** (issue #70).
**Build on it; don't start it again.**

## One console (lane A, the one-console redesign)

The console is the whole site (`web/src/shell/README.md` has the addresses). `ingest/LiveMission.tsx` mounts
it for a live mission and for the demo mission alike: `CommandView` with the map in the middle, the task
board and teams on the left, the view's rail on the right, the clue log along the bottom. The views change
the rail, never the map: **Map** (the approval inbox, an Open Radio button under it), **Radio** (the radio desk), **Photos**
(`PhotosRail.tsx`: the survey's photos as they land, or a live mission's upload and watch command; Try a
photo), **Review** (`review/LiveReview.tsx`'s `ReviewRail`: candidates with the second look's verdict and
model chips, your own photo on top), **Debrief** (`Debrief.tsx`, a wide panel: the mission so far, the
measured results with how each is measured, what breaks first, For judges, the links) and **Trace** (a sheet
over the console: the agent's trace or the event log).

**Mission time on the demo mission.** `missionTime.ts` gives the demo mission a `t` dimension: six
checkpoints of its scripted afternoon, told in Mount Seymour's local time (13:35 PDT the call, 14:18 photos land,
14:31 confirm, 14:42 where next, 15:00 run, 15:00 results; the fixtures are dated in UTC, and the app bar and
the scrubber show UTC on hover: `lib/time.ts`, `DEMO_TZ`) and `demoAt(full, clock, user)`, the fixtures as they stood at a clock reading with the
visitor's own actions replayed on top (one data model: the same fixtures, filtered by their own times, which
the generator sets on the story's timeline). `story.ts` holds the clock (checkpoint, progress,
playing), whether the coach marks are on, and the visitor's actions as events. `Scrubber.tsx` is the time
control on the map; `CoachMark.tsx` the story's five marks (hand-rolled, no dependency: a ring on the real
panel, one sentence, Next/Back/Exit, the arrow keys, Space, Esc); `PitchBar.tsx` the landing's two lines.
t3 waits for the visitor's approval of p003 (`STORY_PROPOSAL`: the planner's Team One to C2, on the map the
four clues moved; the card says which clue raised the sector, `clueShift.ts`); t2's third candidate is a recorded second look (`demoReview.ts`:
a 0.18 detection, OpenCV 5's zoom, Nemotron VL's verdict), labelled as recorded on another photo.

| File | What |
|---|---|
| `ApprovalInbox.tsx` | LANE_E §7.2: pending proposals newest first, decided ones collapsed below with "Approved by Dana at 18:58"; kind, summary, reason (expands), evidence thumbnails, briefing; **Approve** (`A`), **Reject** (`X`, needs a one-line reason), **Edit** (the team of an assignment, the briefing text: sent as `edits`, part of what is approved); keys act on the focused card only; "You are ___" kept in `sessionStorage` |
| `ApprovalInbox.test.tsx` | test 4 (and no "clear") |

Mounted in the console's right rail (the Map view; `#m/<id>/approvals` redirects there) with
`useMission().decide`. An approved briefing reaches the radio's outbound queue on the server; nothing is
transmitted from the inbox. Checked in Chromium against the real server (val photos, cv2.dnn, Nemotron):
screenshot in `docs/architecture/screens/approval-inbox.png`.

Lane A also built the **front door** (`web/src/front/`: `FrontDoor.tsx`, `copy.ts` with LANE_E §6.2's words exactly, the default route `#`, test 6). Lane A also built `CommandView.tsx` (mission header with conditions, task board with POD entry capped at 90%, team roster, clue log with Add clue) as the **Console** tab, and `GET /missions/{id}/sectors` (live POA and drone coverage). Still lane E's: lane B's map in the middle, event feed filters, the printable assignment card page, `__fixtures__` for demo mode.

## Assignment card (E-09, lane A)

`AssignmentCardView.tsx`, at `#m/<id>/card/<sector>` (a **Card** link on assigned and in-progress tasks):
lane B's card (`GET /cards/{sector}`) as one printable page, with the sector outline north up, the entry point
with bearing and distance from the team, what to look for with photo crops, the waypoints, conditions,
daylight and the radio line. Print, Download GPX and Download KML. `@media print` (`theme.css`) gives white
paper and black text, and hides the buttons. Checked in Chromium: a real card prints on **one Letter page**
(25 waypoints) and the GPX downloads as `application/gpx+xml`. Screenshot: `docs/architecture/screens/assignment-card.png`.
CalTopo: the GPX imports cleanly (every waypoint and the boundary; `docs/architecture/screens/caltopo-import.png`, in the report §1).


## Demo mission (E-04, lane A)

The demo mission runs the console with **no API** (the Vercel site; it is the landing): `demoMission.ts` loads
`__fixtures__/demo_mission.json` and the demo cache's `map.json` (its 500 frame steps become the map log, then
`map_updates`: the four clues' reweights and two ground searches) into `useMission().useDemo`. The fixtures are
generated by running the mission through the product offline, not written by hand:
`uv run python scripts/make_command_fixtures.py`, then `make_fleet_fixture.py`. The mission API (in process)
logs the cache's frame steps, the clues (`POST /clues`, so `LiveMap.clue_update` reweights the map) and the
task updates; the agent's own `loop.handle` makes every proposal (the second look on the cache's near-miss
detections, the planner's tick at 21:42 UTC); a scripted search manager and image reviewer decide them through
`POST /decide`. The models are fakes and say so (`fake/<model>`: scripted VL answers, short briefings from the
facts). Out: 4 teams, 16 tasks in every state, 4 clues (2 by radio, typed turns), 5 proposals (2 promotions,
one pending with the second look's images in `__fixtures__/relook/`; 3 assignments), the 16 sectors' POA, and
`demo_trace.jsonl`, the mission's whole trace, so every proposal has its chain in the Trace view. The car in the
trailhead lot is a mission note, not a clue: it marks where the search starts, and as a clue it would pull the
map toward the corner sector A1. The script validates everything against the contract and refuses the word
"clear". It is labelled DEMO in the app bar, its drones SIM on the map; actions change the mission in memory and
are stamped with the mission clock. The Photos and Review rails and the Debrief's numbers read the demo
cache (`/cache/demo`). Screenshots: `docs/report/figures/one-console/`.

## Audit fixes (lane A, 2026-10-22)

- **Task moves are enforced on the server** (E-05, §9 test 2): `effects.TASK_MOVES` allows proposed → assigned,
  assigned → in progress or back to proposed, in progress → searched, searched → proposed (reopen), and the same
  state again (reassign); `searched` needs POD above 0 and at most 90 %. Tested in `test_mission_api.py`.
- **Clue form** (E-08, test 5): lat/lon range checks with a message, an optional radius (empty: the default for
  the kind); the server refuses a position off the globe too (`resolve_position`).
- **Event feed** (E-10): `EventFeed.tsx`, newest first, the last 50, filter chips by kind. It is the Trace view's
  "Event log" (`#m/<id>/trace?log`).
- **Roster fly-to** (E-06): a team's callsign selects it (`useSelection().selectTeam`, D-M2), and the live map
  flies to its position; clicking a team, drone or clue on the map selects it.

## Console and Trace (lane A, redesign)

- **Console** (`CommandView` with `map`): a conditions row (flyability, conditions, Sources; the name, mode and
  clock are in the app bar), a status line above the map (`missionStatus`: approvals waiting, drone leg ready, teams out,
  sectors in progress, clues), one-line task rows (sector · POA · state · team; actions on hover or focus,
  the row expands to details, the team picker and the POD entry). The first-visit hint and the "Desktop
  recommended" note are gone: the story's coach marks and the bottom bar replace them.
- **Status colours** (`shell/theme.css`): one pill, `.sl-pill`, driven by `--c` through `data-tone`: ok
  (green: searching, done), caution (amber), alert (red), action (orange: needs a person), neutral, muted.
  `StatusPill`, `ModeChip` (LIVE / DEMO / SIM / Recorded) and `Badge` all use it.
- **Trace view** (`TraceView.tsx`, `trace.ts`, `#m/<id>/trace`): `GET /missions/{id}/trace` polled with
  `?after=`; entries grouped into chains by shared ids (perception → decision → action → approval), one line
  per step (span type, tool or model, input, output, ms), the proposal each chain led to and who decided, and
  a "which model did what" strip. The demo mission shows its own trace first (`__fixtures__/demo_trace.jsonl`,
  from the generator: labelled Demo, fake models and scripted people named), then two recorded runs copied from
  the repo (`demo_trace_avchain.jsonl`, `demo_trace_conditions.jsonl`, the av-chain crops), labelled Recorded.

## Load order (web audit, 2026-10-22)

The first bundle holds the shell and the console; MapLibre, the Trace view, the radio desk, the Debrief (and its
charts), About, Try a photo and the assignment card are their own chunks (`React.lazy`). The demo console appears
whole once its fixtures and recorded conditions are in (nothing moves as they arrive), and the map mounts after
that frame has painted (`afterPaint` in `ingest/LiveMission.tsx`), or when the About sheet over it closes.
Before/after scores: `docs/report/figures/audit/`.

