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
that frame has painted (`afterPaint` in `ingest/LiveMission.tsx`). About is a section of the home page now (`#about` scrolls there), not a sheet over the console.
Before/after scores: `docs/report/figures/audit/`.



## The command post (lane A, 2026-10-22)

The console is laid out the way a SAR command post works (`.documents/COMMAND_POST.md` §5): one screen,
four regions, every action logged to one timeline.

- **Status line** (`StatusLine.tsx`, the header's second row): elapsed time, daylight left (a bar that
  shrinks), flyability as one word with its gate time (the reason on hover, the Conditions panel behind `W`),
  people out, found or not, clues; the demo's scenario menu and the clock on the right. It replaces the
  conditions row and the KPI sentence.
- **Resources** (`Resources.tsx`, left, the full height beside the map and the timeline): a summary line
  ("4 teams: 1 free · 1 assigned · 2 searching", "3 drones: 3 flying", `resourceSummary`), then a compact
  T-card row per team (a left bar in its status colour, status and sector in words, "heard N min" from its
  last radio turn or check-in, amber near the check-in interval and red past it, back in ~N min) and per drone
  (status and sector, battery, link, leg n/m). Each row has one primary action in words: **Assign to
  sector…** (a team at base; **Reassign…** for one out) or **Fly a leg…** (a drone), which opens the sector
  list under it (`SectorPicker.tsx`: the agent's pick first, POA shown, a tap assigns; or click a sector on
  the map); Call, Recall and Record find are smaller. Rows carry a drag handle and the hint "Drag a row onto a
  sector, or press Assign": while a row is dragged (`consoleStore.dragging`) the map outlines the sector under
  the pointer and says "Drop Team Two on a sector to assign it"; a drone dropped on a sector flies a leg there.
  The rows keep a stable order (out in the field, free, off duty; the roster order within); an overdue team carries a red "Overdue · not heard N min" badge; a returning team counts down "back ~N min"; a free team away from base camp says "in the field". The sectors by POA follow. All four teams and three drones show at 1440 × 900.
- **Map** (centre, about 55 % of 1440 px): click a sector for its popover (`SectorPopover.tsx`: assign any
  team, the agent's pick first; send a drone leg; mark searched at a POD of at most 90 %; recheck; record the
  find). Base camp, one icon set, only the active leg solid. The scrubber shows only inside the story.
- **Needs you** (`NeedsYou.tsx`, right): decisions only, grouped by kind under a head in the kind's colour
  with its count, most urgent first: a team reporting the subject, teams past their check-in, the agent's
  proposals (`ApprovalInbox.tsx`, oldest first), clues awaiting read-back, a live radio's briefings to send
  (`RadioLink.tsx`), then the candidates to review. Each item is one question ("Send Team One to C2?",
  `proposalAsk`) with one primary button that says the outcome ("Send Team One to C2", A; "Call Team Three";
  "Confirm clue"; "Record find in C2"), the rest smaller (Reject X, Edit team or briefing E, Recall, Reply).
  For the guided search: `highlight` (a need id: a proposal's id, `overdue-<team>`, `clue-<clue>`,
  `turn-<turn>`, `report-<team>`, `review`) rings that item (`data-highlighted`) and dims the rest
  (`data-dimmed`); every item carries `data-need` and `data-need-kind`, and `ApprovalInbox` takes
  `highlight` and `order` too. Once
  `Mission.status` is `found`, pending proposals and candidates are closed: one row, "16 items closed at
  15:00, subject found", expands to them (each "closed: subject found"); the header and the Map tab's count
  stop counting them. Overdue teams and read-backs stay, and every direct action still works.
- **Timeline** (`Timeline.tsx`, `timeline.ts`, bottom): one stream, All / Radio / Clues / Drone / Decisions,
  read-only rows (decisions are made in Needs you) with one Show link each; repeats merge, and one assignment said three ways is one line. The talk bar is
  the radio desk: hold `V` (a live radio server) or type, to the team picked. Add a clue is here.
- **Direct actions** (`lib/mission.ts`): assign, call, recall, searched, recheck, found, drone leg, confirm a
  clue. A live mission calls `POST /missions/{id}/teams/{team}/assign|call|recall`,
  `/sectors/{sector}/searched|recheck` and `/found` (falling back to the task and team calls on a server
  without them); the demo does each in memory and logs it ("Search manager assigned B3 to Team Two"), and its
  drone legs fly from base camp photo by photo (`lib/demoFlight.ts`), lowering the map under them.
- **Scenarios** (`scenarios.ts`; the home page's scenario cards choose one): four presets and shuffled seeds (`#m/demo?s=<seed>`).
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
  agent's, 1–4 an option, M the map, T takes over from Watch instead, Space pauses between decisions, →
  skips ahead to the next one; Leave (with a confirm) leaves. The console's own actions count too (P/N/U in the queue, Approve or Edit on the card, a sector's
  popover, Confirm on a read-back, Record the find). Needs you shows the current decision only.
- **One place to decide** (Dan's review, 2026-10-25): a decision lives where it lives on the real console:
  the photo's card (P/N/S/O/U), the proposal's main button ("Send Team One to C2") or Edit, Confirm clue on
  the read-back, a sector on the
  map, Record find on the team's report in Needs you (`sightingReports` reads the server timeline too). The
  coach bar names the control, rings it ("Do this first") and focuses its `data-primary` button; it shows buttons only for choices the console
  has no control for (the serpentine survey, the relay drone, ask for a bearing, log without mapping, ask for
  a confirmation), with what each costs; `Option.on` marks the others. The keys still work (A, 1–4, M).
  Needs you keeps its grouping and uses its one pointing system, `highlight` (#219): the step's item (`review`,
  `clue-<id>`, the proposal's id, `report-<team>`) ringed, every other one `data-dimmed` and out of reach
  (pointer events off) until its step; "none" between decisions dims them all. No toasts while the run is on (`useEventToasts` `quiet`): the bar says each row.
- **Time passing** (`story.ts` `lapseStep`, `lapseBeats`; Dan's review 2026-10-25: "way too fast"): one
  thing at a time, and the bar says what it is. The timeline rows between two decisions (read from the
  mission as it will stand at the next decision, `demoAt` once per run) are grouped into beats: rows alike
  landing within 5 mission minutes of each other are one ("Drone 3: flight line approved · 3 drones",
  "… · 2 photos"). The clock travels from beat to beat, never faster than 4 mission minutes a second
  (0.25 s a minute; a short stretch at most 1 s a minute), and stops on each beat for 1.2 s (1 s when
  there are many): the caption names it ("14:10 · AI re-check of a near-miss photo: probably not a person ·
  2 photos") and the map outlines the sectors and rings the teams it is about, panning gently only when
  it is off-screen (`map/heat/focusLayers.ts` `useBeatLayer`). At 1× a stretch takes 15–25 s (the
  first, 13:35 to 14:31 with eight beats, about 24 s). 2× and 4× travel 2 and 4 times faster and shorten
  each beat by the square root; Pause (Space), Skip ahead (→). Reduced motion: no travel, the clock steps
  beat to beat. Watch instead uses the same pacing. The clock reads real elapsed time, so a slow frame
  does not slow the mission. The heat changes as one 750 ms fade at most every 0.9 s (`LiveHeatMap`
  `useSpaced`), and drones glide at a constant speed between the clock's readings (`FleetGlide`).
- **A new run each time**: arriving at `?guide=1` (a home card's Start, Try another scenario then Start)
  always starts a new run from the call, with the last run's actions, answers, toasts and flights gone
  (`storyFromRoute`, `freshConsole` in `ingest/LiveMission.tsx`); before, a finished run on the same seed
  opened again at its end screen (held in `ingest.test.tsx`).
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
  On top of it, **You vs the agent** (`compare.ts`): your search and the agent's line side by side (time
  from the call to the find in mission minutes, sectors searched, team-hours on passes, the share of the
  agent's map searched before the find, candidates triaged, decisions unlike the agent's), the two times
  to find as bars, your decision time (wall clock from when each decision was shown to when it was made:
  `useGuide.show` stamps `Choice.shownAt`, `choose` stamps `decidedAt`; Watch instead's are left out; the
  trace has no latency for the agent's proposals, so it says they came as the data landed), each decision
  with its clock cost, and a one-line verdict; Try again, Follow the agent this time, Another scenario.
  The detail above sits under "Show the details". No no-agent baseline yet (sim.ts has none).
- **On screen** (`GuideRun.tsx`, mounted by `ingest/LiveMission.tsx`): `GuideMark` in `CoachMark.tsx`, a
  coach bar along the top of the map, never over Needs you ("Your call": "Step 2 of 6 · Triage", where to
  act, the agent's reason, an amber ring on the real control, clock paused; "Watch this": the time-lapse) and
  `GuideStrip` in `Scrubber.tsx` (the decisions with a check on each one made, a live region for screen
  readers). Phones get the same flow with the mark as a bottom sheet.
- **Not yet:** the counterfactual is computed live from the same engine, not from an offline decision tree;
  the survey pattern, the relay and the bearing change the clock and the record, not the drones' paths or
  the size of the clue's map update; the store methods the interaction worker is adding to
  `demoMission.ts` (a team walks a sector, searched at POD, found if the subject is inside; the survey
  proposal at t0) were not on main, so the minimal rule lives here. Screenshots:
  `docs/report/figures/v3/guided-step-*.webp`.

### After the cold usability test (2026-10-25, `a/subject-guide`)

Lead with the subject and the map; show only what needs a decision; one control per action.

- **Subject strip** (`SubjectStrip.tsx`): under the status line on every console, guided or not: the profile
  (`Mission.subject`), "last seen 10:30 at the trailhead lot · 3 h 05 min ago" in the mission's local time
  (`last_seen_at`, the scenario card's `lastSeen` place), LKP (centres the map: `consoleStore.centreOn`) and
  Profile; "Subject not found" on the status line opens the same profile. The home page's scenario cards no
  longer list the clues the run will bring.
- **One Send action**: the assign step's one primary, on the card and on the coach bar alike, is "Send all N
  free teams to the agent's picks" (`sendAllLabel`, option `all`: from then on every team that comes back
  takes the agent's next pick, `standingFrom`); the card's own Approve becomes "Send only Team X to C2". After
  every pass with no find the agent proposes again for that team, and from last light every free team goes on
  the agent's picks through the night (`searchEnd`), so every choice path ends in the find (`guide.test.ts`,
  "every choice path reaches the find"). Nothing is asked after the find (a later lost link or gust).
- **The bar never covers the map**: the coach bar and the step strip sit at the top of the Needs you column
  (a bottom sheet on a phone); the ring no longer greys the screen; out-of-step Needs you items are hidden,
  not dimmed, with "N more after this step".
- **Esc** closes overlays only. Leave asks "Leave the simulation? Your decisions so far will be lost" and goes
  to the home page's scenario cards (`#scenarios`). The shortcuts overlay sits above everything.
- **Triage** opens each photo in the review frame, the subject's description beside it, the photo enlargeable;
  the answers have one meaning on every photo: The subject (a pin), Another person (a witness lead), Not a
  person; under More: A group (2+ people) (a pin and a witness lead; sent to the server as `person`), Object…,
  Unsure. Keys stay (P S N G O U) as badges on desktop only; no key letters inside sentences.
- **Record find stops the clock**; "Stay on the console" keeps the run on screen, stopped, with "What you did"
  and "Back to the scenarios". "Replay, following the agent" shows only when the visitor did not already.

### Fit the screen (round 2 of the cold test, `a/fit-the-screen`)

"I can't see the button": at 1280 × 720 the bar took the Needs you column and the step's control was cut off.

- **One scroll column** (`CommandView` `data-guided`, `shell/theme.css`): on a desktop the bar and Needs you
  share the right column's one scroll, the bar first, Needs you at its natural height. When a step starts the
  mark scrolls its control into view (`showControl`: the column at its top when the control fits there, else
  just enough) and focuses it, looking again while Needs you fills in. Scrolled past the instruction, it stays
  pinned on one line at the column's top (`data-guide-pinned`, the whole text on hover; a click scrolls back).
- **Short screens** (height under 800 px): the step strip folds away, the AI's reason keeps one line, each
  option's effect moves to its tooltip, and the choices the console has no control for (ask for a bearing,
  log without mapping, ask for a confirmation) go after Needs you (`data-guide-more`), one link away. Under
  960 px the step strip shows the other steps by number only.
- **Status line** (`StatusLine.tsx`): wraps to a second line instead of cutting off; under 1536 px the lowest
  value stats go first (Rest of world, which the sector list also gives; daylight's "light until", in the
  tooltip; the daylight bar). Clock, elapsed, daylight, subject and the bell stay.
- **Phones**: the bar sits above the bottom tabs (the tabs are above the review frame and the bar); while the
  review frame is open the bar folds to a one-line chip ("Show the guide"), so the answers are in reach; the
  crop sits under the photo, never over it.
- **The ring** is drawn only where its target shows: under the Conditions panel, the Trace page, Photos, the
  Debrief or any sheet it is hidden (`covered`, elementFromPoint on each target).
- **Leave the simulation?** is a modal above every sheet (z 80); while it is open the mission clock waits,
  Watch instead waits, no guided key acts, and no review frame opens over it (`consoleStore.confirming`: a
  review asked for then opens on Stay).
- Checked in Chromium at 1280 × 720, 1366 × 768, 1440 × 900, 1920 × 1080 and 390 × 844: every step's control
  on screen and hit by elementFromPoint; `fitScreen.test.tsx` holds the rules in jsdom.

## Feedback, review and the visitor's decisions (v3 interaction, lane A)

What changed after Dan's v3 review (`docs/report/figures/v3/`: review-frame, toast, proposal-glow, timeline-tall,
heat-tween-1..3; 1440 and 390):

- **Nothing changes silently.** Every mission event that is news becomes a toast (`shell/toasts.tsx`,
  `shell/notify.ts`; the mapping is `notifications.ts`, tested): bottom right, 5 s, stacking (same key merges with
  a count), one action ("Show me", `showMe.ts`). The status line has a bell with the unread count and the last
  30. New timeline rows hold a highlight in their kind's colour for 3 s; new proposal cards slide in with a slow
  ring; the map's clue ring fades over 2 s. A team past its check-in raises an alert toast too.
- **The heat evolves.** A change tweens cell by cell over 400 ms; the new class fills and contours are held back
  until the tween ends, then crossfade in (`map/heat/surface.ts` `setSurfaceMode(…, fade)`).
- **The map follows Needs you** (`map/heat/focusLayers.ts`): a candidate in focus (clicked, J/K, the review frame)
  outlines its photo's footprint and pulses its pin; a proposal in focus glows its sector and the team or drone
  card violet; the map pans when the focus is near the edge; an assignment draws the team's route growing from
  where it is, its last sector or base camp (`map/base/teamRoute.ts`). One pin popup at a time
  (`map/base/onePopup.ts`).
- **Review frame** (`ReviewFrame.tsx`): when candidates arrive where there were none, a toast says how many and
  the first opens large (outside the guided story): the photo with the box, the crop, the AI second look, P/N/U,
  moving on by itself. The second look (`review/SecondLook.tsx`) says what it does, runs from one button
  (Run AI second look) with its model chips and its two steps, then shows the verdict first ("Likely a
  person", `verdictHead`), its details (2 people · standing · red jacket…), the detector's crop beside the
  OpenCV 5 image the VL model saw, each step with what it said (`secondLookSteps`: the OpenCV 5 cv2.dnn
  detector's score and the review line, each OpenCV 5 re-look tool, Nemotron VL's answer and reason) and the
  time; only the verdict's own fields, no invented scores. The detector score carries what made it
  (`DetectorScore`: "OpenCV 5 · cv2.dnn 0.17" on the survey's and a live mission's candidates, "ONNX Runtime
  Web" on dropped photos, no name on a distractor whose box was placed by hand); the demo cache re-detects
  identically on cv2.dnn (`docs/LANE_A_ML.md`). Rail cards with no second look say so in one line.
- **Timeline**: 20 rem by default, a handle to resize it (remembered), readable rows, a remembered filter with
  counts, Add clue in its header; right-click or long-press the map adds a clue there (what, who reported,
  reliability); the first radio call brings a one-time hint.
- **Call and Task**: Call addresses the talk bar ("Calling Team Two"); Task lists the sectors by POA under the
  card, the agent's pick first (`SectorPicker.tsx`). No folded lists: "Show N more" links instead.
- **Two voices** (`RadioBubble.tsx`): what goes on the air is a teal radio bubble with mono callsigns ("Desk →
  Team One"); what the agent tells you is a plain violet note ("Agent → you").
- **The visitor decides** (`missionTime.demoAt(…, guided, { hold, seed })`, `holdFor`): a proposal the visitor
  decided is logged once; once they play the clock outside the story, the scenario's own approvals wait for them
  and what followed from them does not happen. What they assign then plays through the guided search's engine
  (`sim.ts` via `simulate`: the walk, the sweep, the seeded draw at POD, the find or the sector searched), the one
  engine for the free console and the guided search. Free mode labels the scenario's decisions "the scenario's
  search manager". The map draws each new assignment's route (`focusLayers.ts`, `map/base/teamRoute.ts`).
- **The judges' list (2026-10-23)**: team status from its tasks; overdue fires; POA at 15:00 from the map log;
  Outside the grid N %; drones read "Drone 1"; Record find on the team card and in Needs you; the story's
  scrubber steps one checkpoint on a phone; Replayed (not This flight) on stand-in model calls; survey and leg
  photos apart; the strict 86.4 % leads People found. Held in `judges.test.ts` and the files' own tests.

## The fixtures' new content, wired in (PR #215's hand-offs)

The regenerated fixtures carry more than the contract's records (`lib/fixtureExtras.ts`: `feeds`, `report`,
`distractors`; `MissionData` keeps them, optional, so a live mission without them is unchanged). Screenshots:
`docs/report/figures/v3/` (bearing-arc, drone-feed, radio-voices, review-object, review-cards-object,
clue-candidate, report-fields, map-still, object-photo).

- **Bearing clues** (`map/base/clueLayer.ts`, `map/README.md`): a sound a team heard with a bearing draws as an
  amber arc from where the team stood, bearing ± spread, range ± radius, its words on hover.
- **Drone feed** (`DroneFeed.tsx`): while a leg flies, a tile at the bottom left of the map plays that leg's clip
  from `public/feed/` (the selected drone's first), muted and looping with its poster, labelled "drone feed ·
  public-domain footage, not this flight". A phone starts it folded and never plays before a tap or a key;
  reduced motion waits for Play; prefers-reduced-data hides it. A leg the visitor sends plays the clip of a leg
  over the same sector, else none.
- **Radio voices** (`Timeline.tsx` mounts `radio/RadioAudio.tsx` on the server timeline): a turn's clip plays
  when it lands, after the first click or key, one at a time, the team's voice then the desk's reply; a jump of
  the clock plays only the newest turn; a new scenario starts afresh. The mute toggle is in the timeline's
  header, and rows with a clip show a speaker.
- **Review answers** (`review/answers.tsx`): Person P, Not a person N, Not the subject S, Object O (then the type,
  1–4: backpack, fire ring, shelter, other; the second look's guess marked), Unsure U, in the review frame and on
  the cards. A live mission sends them to `POST /reviews` (with `object`); on the demo an Object answer makes the
  clue candidate the server would (`demoReview.ts` `objectClue`: low reliability, `source: "review"`, not
  confirmed; a distractor's keeps the fixture's clue id), and Needs you lists it as "Clue candidate to confirm"
  until a team has seen it (`POST /clues/{id}/confirm` on a live mission). The scenario's distractor frames join
  the demo queue once their second look is on the timeline (`distractorCards`), with the live verdict they got.
- **After-action report** (`report.ts`, `MissionReport.tsx`): last seen (and how long before the call), every
  sector's final POD (the server's report, a ground search recorded since added as one more look) and the drone
  legs with their minutes (reported or planned) and photos, in the view and the Markdown export.
- **Object photo badge**: a distractor frame's photo (ground level, among the aerial ones) carries an "object
  photo" badge in the review frame and on its card.

## Status truth (lane A, the cold usability test 2026-10-25)

A BC SAR search manager: "Clever, but I can't trust what it tells me about my teams." What changed:

- **One last-heard clock** (`console.ts` `lastHeard`, `teamOrder`): the newest of a team's `last_heard_at`, its
  radio turns and check-ins in the events, and its calls and check-ins in the server's timeline. `CommandView`
  computes the board once; the Resources rows, Needs you, the overdue toasts and the bell all read it. A toast
  says "not heard since 14:05" (true as the clock runs); once the team is heard again its toast leaves and the
  bell's line becomes "Team Three heard again" (`notify.resolve`). The header reads "Radio check-in every 30 min".
- **Where teams are** (`missionTime.ts` `placeOf`, `hastyAt`): a team walks out, sweeps, and after a pass with no
  find (or a recall, `sim.ts` `passesFrom`) walks back, Returning with an ETA that counts down, then Free at base
  camp. A team that radios clues before the board is seeded was out on a hasty search along the trail, with a
  position report every 20 minutes. The guided search drops a scenario proposal for a team or sector the
  visitor already sent (never the first assignment).
- **Drones by the clock** (`fleetSim.ts`): out to the leg at the drone's speed, the leg's own minutes, back,
  landed, a pack swap (Charging), then At base with a full pack; 2 % battery a minute in the air. The survey
  flight is a sortie too. A leg the manager sends photographs the map as it flies; a scenario leg for a drone
  the manager has in the air is not flown. Every approval names the approver: "You approved…", "(sent by you)",
  "auto-approved: guided survey", "(by the search manager)".
- **Sightings change the plan**: a reviewer's Person makes the agent propose "Send Team Two to the sighting in
  C3 (+16 min)" (`sight-<clue>`), at the top of Needs you and never dimmed by the guide; the status line says
  "Possible sighting · 14:31"; the agent's other assignment proposals say the sighting comes first; its
  next-sector proposals take the table's top open sector, or name the higher one another proposal asks for.
- **Stale items**: a radio call held for read-back leaves Needs you once its clue is on the board; the timeline
  has no Confirm or Reply; a clue candidate from an image review offers "Send Team Two to look (+16 min)" and a
  live Confirm.
- Held in `statusTruth.test.tsx` (every minute of a run: rows = Needs you = toasts = bell).
