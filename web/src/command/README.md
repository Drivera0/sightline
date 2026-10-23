# web/src/command: the command view (lane E)

Lane E's folder. Lane E has no owner yet, so lane A built **E-07, the approval inbox** (issue #70).
**Build on it; don't start it again.**

## One console (lane A, the one-console redesign)

The console is the whole site (`web/src/shell/README.md` has the addresses). `ingest/LiveMission.tsx` mounts
it for a live mission and for the demo mission alike: `CommandView` with the map in the middle (the
command post: resources, Needs you, the timeline; "The command post" below). The views change
the rail, never the map: **Map** (the command post, below; the radio desk is its talk bar), **Photos**
(`PhotosRail.tsx`: the survey's photos as they land, or a live mission's upload and watch command; Try a
photo), **Review** (now in Needs you: `review/LiveReview.tsx`'s `ReviewRail`, candidates with the second look's verdict and
model chips, your own photo on top), **Debrief** (`Debrief.tsx`, a wide panel: the mission so far, the
measured results with how each is measured, what breaks first, For judges, the links) and **Trace** (a sheet
over the console: the agent's trace or the event log).

**Mission time on the demo mission.** `missionTime.ts` gives the demo mission a `t` dimension: seven
checkpoints of its afternoon, told in Mount Seymour's local time (13:35 PDT the call, 14:18 photos land,
14:31 confirm, 14:42 where next, 14:58 the run, 14:59 the find, 15:00 the debrief; the fixtures are dated in UTC,
and the app bar and the scrubber show UTC on hover: `lib/time.ts`, `DEMO_TZ`) and `demoAt(full, clock, user)`, the
fixtures as they stood at a clock reading with the visitor's own actions replayed on top (one data model: the same
fixtures, filtered by their own times; every scenario keeps this rhythm). `storyCopy.ts` is what "Follow the
search" says, read off the loaded scenario in the search manager's present-tense voice: twelve coach marks on the
overdue hiker (the call; the survey and the first candidates; Person, Person, a grey bag, the second look; the
radio clue and the proposal that names it; the lost link and relay, the team walking its sector; the find; the
after-action report), each anchored to a real region by selectors in order of preference ("the first assignment",
"the clue it names", "the found event", never fixed ids), a beat the scenario lacks left out, and none of
demo/recorded/scripted/simulated in the words (the header's chip says it). `story.ts` holds the clock
(checkpoint, beat, progress, playing), whether the marks are on, and the visitor's actions as events.
`Scrubber.tsx` is the time control on the map, with Skip to now and the story's keys under it; `CoachMark.tsx`
the marks (hand-rolled, no dependency: a ring on the real panel or on a "group:" of cards, a sentence or two,
Next/Back/Exit, the arrow keys, Space, Esc; a panel it scrolled goes back when it moves on); `PitchBar.tsx` the
landing's two lines. t3's proposal mark waits for the visitor's approval (the card says which clue raised the
sector, `clueShift.ts`). Recording and stills: `docs/report/figures/command-post/story.webm`, `story-t0…t6.webp`.

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



## The command post (lane A, 2026-10-22)

The console is laid out the way a SAR command post works (`.documents/COMMAND_POST.md` §5): one screen,
four regions, every action logged to one timeline.

- **Status line** (`StatusLine.tsx`, the header's second row): elapsed time, daylight left (a bar that
  shrinks), flyability as one word with its gate time (the reason on hover, the Conditions panel behind `W`),
  people out, found or not, clues; the demo's scenario menu and the clock on the right. It replaces the
  conditions row and the KPI sentence.
- **Resources** (`Resources.tsx`, left): a T-card per team (status, sector, "heard N min" from its last radio
  turn or check-in, amber near the check-in interval and red past it, back in ~N min) and per drone (battery,
  link, leg n/m); Call (addresses the talk bar), Task (pick a sector on the map), Recall. Most overdue first.
  Drag a card onto a sector to assign. The sectors by POA fold below.
- **Map** (centre, about 55 % of 1440 px): click a sector for its popover (`SectorPopover.tsx`: assign any
  team, the agent's pick first; send a drone leg; mark searched at a POD of at most 90 %; recheck; record the
  find). Base camp, one icon set, only the active leg solid. The scrubber shows only inside the story.
- **Needs you** (`NeedsYou.tsx`, right): decisions only. The agent's proposals (`ApprovalInbox.tsx`, a
  one-line reason, A/X/E), candidates to review (the review queue lives here now), teams past their
  check-in, clues awaiting read-back, a live radio's briefings to send (`RadioLink.tsx`). Once
  `Mission.status` is `found`, pending proposals and candidates are closed: one row, "16 items closed at
  15:00, subject found", expands to them (each "closed: subject found"); the header and the Map tab's count
  stop counting them. Overdue teams and read-backs stay, and every direct action still works.
- **Timeline** (`Timeline.tsx`, `timeline.ts`, bottom): one stream, All / Radio / Clues / Drone / Decisions,
  Reply on radio entries, Confirm on clues awaiting read-back, Show on map; repeats merge. The talk bar is
  the radio desk: hold `V` (a live radio server) or type, to the team picked. Add a clue is here.
- **Direct actions** (`lib/mission.ts`): assign, call, recall, searched, recheck, found, drone leg, confirm a
  clue. A live mission calls `POST /missions/{id}/teams/{team}/assign|call|recall`,
  `/sectors/{sector}/searched|recheck` and `/found` (falling back to the task and team calls on a server
  without them); the demo does each in memory and logs it ("Search manager assigned B3 to Team Two"), and its
  drone legs fly from base camp photo by photo (`lib/demoFlight.ts`), lowering the map under them.
- **Scenarios** (`scenarios.ts`, `ScenarioMenu.tsx`): four presets and shuffled seeds (`#m/demo?s=<seed>`).
  The generator's `__fixtures__/scenarios/<seed>.json` is used when it exists; until then a scenario is
  derived from the demo mission (its last known point, prior, base camp, clues and assignments).
- **Photos** (`PhotoDrop.tsx`, `lib/exif.ts`): drop a drone's photos on the demo and they are read (EXIF GPS,
  DJI altitude and heading), ranked by the in-browser detector, placed, and their candidates go to Needs
  you; "Load 20 sample photos" reads the site's own copy of the pack (`public/sample/sightline-sample-photos.zip`,
  same origin, so it works on Vercel and offline; `VITE_SAMPLE_PHOTOS_URL` can point elsewhere), else the demo
  survey's own photos. A live mission
  uploads the drop.
- **After-action report** (`report.ts`, `MissionReport.tsx`): once the subject is found the Debrief is the
  mission report, with Report, ICS 204/214/309, CalTopo and Print; the measured results follow it.

The demo fixture has none of the command post's fields yet; `demoMission.ts` gives the mission its base camp
(the trailhead lot), status and a 30-minute check-in until the regenerated fixture carries them. Screenshots and
the cold-user checklist: `docs/report/figures/command-post/`.
