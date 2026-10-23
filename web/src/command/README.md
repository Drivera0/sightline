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
fixtures, filtered by their own times; every scenario keeps this rhythm). The walk-through is the guided
search (below): "Follow the search" on the app bar and the pitch bar, and the home page's Start, open it. The
old step-through story (twelve first-person coach marks, `?t=0` to `?t=6`) is retired: `?t=N` opens the console
at that checkpoint's clock with no marks (it settles on `#m/demo/map?t=N`), so old links still land.
`story.ts` holds that clock (checkpoint, progress, playing), the pitch bar and the visitor's actions as events,
and the guided search's own clock (`useGuide`). `storyCopy.ts` keeps the scenario's roles the guided search
anchors to (the first assignment, the clue it names, the console's regions, the grey bag, the banned words).
`Scrubber.tsx` is the time control on the map while the clock plays (Space outside the guided search), with
Skip to now, and the guided search's strip; `CoachMark.tsx` the guided search's mark (hand-rolled, no
dependency: a ring on the real panel or on a "group:" of cards); `PitchBar.tsx` the landing's two lines.
The old story's stills stay in `docs/report/figures/command-post/` as a record.

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
facts), but for the second look on f0273-d02 (#192): `scripts/make_second_look_fixture.py` ran it on this flight
with the live VL model (`__fixtures__/second_look/`: trace, verdict, crop and zoom), and its answer is replayed
word for word as `recorded/<model>`. Out: 4 teams, 16 tasks in every state, 4 clues (2 by radio, typed turns),
4 proposals (the promotion of f0273-d02, pending with the second look's images in `__fixtures__/relook/`; 3
assignments), the 16 sectors' POA, and
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
  from the generator, with the one live answer replayed), then two earlier runs copied from the repo
  (`demo_trace_avchain.jsonl`, a second look on another HERIDAL photo, and `demo_trace_conditions.jsonl`, with
  the av-chain crops). The view names roles, not provenance: a run is "This flight" or "Earlier run", a model
  is its name (the fixture's `fake/<model>` and `recorded/<model>` ids shown without the prefix), and a decider
  is its role ("Search manager", `roleOf`). The trace's own strings keep the provenance (`fake/<model>`,
  "Search manager (scripted for the demo fixture)"; a step's output shows them), and the header's disclosure
  chip, the Debrief and About say it. The review rail's third
  card at Confirm is this flight's second look (`demoReview.ts`, "Second look · this flight"); Person on it pins a
  sighting at f0273-d02's place, like any candidate.

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

## The guided search (lane A, `#m/demo?guide=1`)

The demo mission as a decision simulation: the home page's Start opens it on a scenario
(`#m/demo?s=<seed>&guide=1`, `shell/flow.ts` `guideHash`). The clock runs to each decision and waits there
until the manager makes it; there is no scrubber, no Skip to now and no Back during play.

- **The decisions** (`guide.ts`, injects in the mission's order, the ones the scenario has): Survey (the
  planner's legs, or a serpentine at +12 min), Triage (three candidates, one at a time: Person, Not a person,
  Not the subject, which logs a witness lead, Unsure; Person on the grey bag sends a team to check it, +10
  min), Clue (confirm the radio call, ask for a bearing at +2 min, or log it without mapping: the clue's map
  update is held until it is confirmed), Assign (approve the agent's team and sector, send another team, or
  pick a sector on the map), Link (let the drone finish its leg, or divert another as a relay), Wind (only
  when the scenario's agent proposes a recall: none of the fixtures do yet), Find. A scenario without drones
  has no Survey or Link. Each option shows what it does and what it costs before the commit; A picks the
  agent's, 1–4 an option, M the map, T takes over from Watch instead, Space pauses between decisions, Esc
  leaves. The console's own actions count too (P/N/U in the queue, Approve or Edit on the card, a sector's
  popover, Confirm on a read-back, Record the find). Needs you shows the current decision only.
- **The consequence model** (`sim.ts`, `missionTime.ts` `guidedAt` and `simulate`): the fixtures' own
  manager steps aside (its decisions, the teams' moves and the find are filtered out), the subject's
  position is the scenario's find, and a team the manager sends walks out (6 min) and sweeps its sector
  (10 min). A pass of the subject's sector detects them with probability POD 0.60, on a draw fixed by the
  seed, the sector and the pass; a pass with no find marks the sector searched at its POD, lowers it on the
  map, and the agent proposes its likeliest open sector next. The second assignment can stand for the rest
  (every free team takes the agent's picks in turn until the find). Found shows only when the manager marks
  it. No fail state: at last light the search suspends. Decisions that take minutes stop the fixtures'
  clock for that long (`fixtureOf`, `realOf`), and the console prints the mission clock (`onMissionClock`).
- **Watch instead** plays the agent's line through the same engine (the reason for 3 s, then "Agent's
  choice: …"); **What you did** (`GuideEnd.tsx`, `hotWash`) compares each decision with the agent's, prints
  every draw, shows the searched sectors at their POD and the subject's sector, says where the two lines
  diverged, and links the after-action report, the trace, `PLANNER_V2.md` and `POD.md`. No score.
- **On screen** (`GuideRun.tsx`, mounted by `ingest/LiveMission.tsx`): `GuideMark` in `CoachMark.tsx`
  ("Your call": amber ring, options, clock paused; "Watch this": progress bar, clock running) and
  `GuideStrip` in `Scrubber.tsx` (the decisions with a check on each one made, a live region for screen
  readers). Phones get the same flow with the mark as a bottom sheet.
- **Not yet:** the counterfactual is computed live from the same engine, not from an offline decision tree;
  the survey pattern, the relay and the bearing change the clock and the record, not the drones' paths or
  the size of the clue's map update; the store methods the interaction worker is adding to
  `demoMission.ts` (a team walks a sector, searched at POD, found if the subject is inside; the survey
  proposal at t0) were not on main, so the minimal rule lives here. Screenshots:
  `docs/report/figures/v3/guided-step-*.webp`.
