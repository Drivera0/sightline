# Exports: files a command post can file

Sightline writes standard search-and-rescue outputs from a live mission: ICS 204, ICS 214, ICS 309
(v1.3), CalTopo GeoJSON and the after-action report (v1.3), and pushes its timeline to a D4H incident
log (v1.3). They follow the FEMA ICS forms, CalTopo's GeoJSON import and D4H's API. The files are
reads, so they work without the write token (`sightline/api/auth.py`); the D4H push is a write. Each is built when you ask for it, from the mission as it stands at that
moment. Code: `sightline/geo/exports.py` (the forms) and `sightline/api/exports.py` (the routes, under
the `exports` tag in the OpenAPI docs at `/docs`). Tests: `tests/geo/test_exports.py`.

Each file holds only what the mission records. Fields Sightline does not know (Operations Section Chief,
phone numbers, the incident's ICS 205 radio plan, home agency, signatures) are printed as `—` or a
signature line for someone to fill in by hand. Sightline never makes them up. A searched area is always
reported with its POD ("searched at POD 0.6").

Set `API` to the server and `MID` to the mission id (`GET /missions` lists missions):

```bash
API=http://127.0.0.1:8000
MID=1a2b3c4d
```

## ICS 204 Assignment List, one team

```bash
curl -s "$API/missions/$MID/ics204/T2.md"   > ics204-T2.md     # printable Markdown
curl -s "$API/missions/$MID/ics204/T2.json" > ics204-T2.json   # one key per form block
curl -s "$API/missions/$MID/ics204/T2.md?pod_target=0.7"       # ask for a different POD (≤ 0.9)
```

`T2` is the team id (case-insensitive). An unknown team returns 404. A team with no sector still gets a
204, and its block 6 says no sector is assigned. The blocks follow FEMA ICS 204 v3.1:

| Block | Filled from |
|---|---|
| 1. Incident Name | the mission's name |
| 2. Operational Period | mission start to the time the file is made (UTC, month/day/year, 24-hour clock) |
| 3. Branch / Division / Group / Staging Area | Division = the team's sector (`Sector A3 (Alpha Three)`) |
| 4. Operations Personnel | blank, to fill in |
| 5. Resources Assigned | the team (id, call sign, persons, radio, last position, where to report), then any drone on an approved or flying leg over the sector |
| 6. Work Assignments | the assignment card in plain words: sector and size, sweep lines and spacing, entry point with bearing and distance from the team, the POD target (default 0.6), POA and drone coverage, what to look for, and the drone leg |
| 7. Special Instructions | weather (wind, gusts, rain), daylight left to civil twilight, no-fly for drones when the conditions say so, alerts, exposure |
| 8. Communications | the radio desk's channel (`Channel 2`, a placeholder until the incident's ICS 205 sets one) |
| 9. Prepared by | the person who approved the team's assignment, from the trace's `decision` entry (else the proposal's `decided_by`); blank signature line; the time the file was made |

The 204's Markdown for Team One on the demo mission is a golden file: `tests/geo/golden/ics204_T1.md`.

## ICS 214 Activity Log, the mission

```bash
curl -s "$API/missions/$MID/ics214.md" > ics214.md
```

Blocks 1–8 of FEMA ICS 214 v3.1. Block 6 lists the teams and drones. Block 7, the activity log, runs
oldest first, with columns Date/Time, Who and Notable Activities. ICS 214 allows extra columns, and Who
is one. It has one row for each of these:

- **decision**: approvals and rejections of assignments, drone legs, re-tasks, recalls, alerts and
  detections. Who decided comes from the trace (`POST /proposals/{pid}/decide` writes a `human`
  `decision` entry). The rejection reason is included.
- **clue logged**: id, kind, reliability, form or radio, text and position.
- **task-board move**: a sector assigned to a team, started, or searched at a POD.

- **direct action** (v1.3): what the search manager did without a proposal: assigned a team, called
  it, recalled it, marked a sector searched at a POD or put it back to recheck, and the find
  (`sightline/mission/command.py` writes a `human` `decision` entry with `action`, `by`, `reason`).
  Printed as "Direct action: Team Two assigned to sector B3", beside the approvals.

Prepared by is the most recent decision-maker.

## ICS 309 Communications Log, the radio (v1.3)

```bash
curl -s "$API/missions/$MID/ics309.md" > ics309.md      # or ics309.json
```

Blocks 1–5 of FEMA ICS 309 v3.1: incident, operational period, radio operator (station
"Sightline (command post)", the name left blank), the log, prepared by. Block 4 has one row per radio
line of the timeline, oldest first: **Time**, **From**, **To**, **Message**. A team's turn is from the
team to the command post, as the radio desk transcribed it; the desk's reply, an approved briefing it
transmitted, or a call the search manager typed (`POST /teams/{team}/call`) is from the command post to
the team ("All teams" for a briefing to all). The transcripts are speech recognition and can mishear:
the footer says so.

## The D4H log push (v1.3)

```bash
export D4H_API_TOKEN=...          # in the API's environment, never in a request
curl -s -X POST "$API/missions/$MID/export/d4h" -H "Authorization: Bearer $SIGHTLINE_API_TOKEN" \
  -H 'Content-Type: application/json' -d '{"org": "1234", "incident_id": "5678"}'
# {"posted": 57, "last_id": "e00107"}; send {"after": "e00107"} next time for the newer lines only
```

Posts each line of the mission's timeline (radio, clue, detection, decision, check-in, drone, found;
`GET /missions/{id}/events?format=json`) to a D4H Operations Center incident log, oldest first:
`POST {D4H_API_URL}/api/v1/orgs/{org}/incidents/{incident_id}/logs` with `{"message", "tags"}` and the
token as `Authorization: Bearer`. D4H stamps each entry with its own time, so the message starts with
the time Sightline logged it: `[21:58 UTC] Team One: Sightline, Team One. Subject located in Charlie
Two…`. Tags: `Sightline`, the line's kind, the team's callsign, the drone, `Sector C2`.
`D4H_API_URL` defaults to `https://operations-center.us.d4h.com`.

No token: 503 with the reason. D4H answers an error or can't be reached: 502, saying how many lines went
up before it stopped. Code: `sightline/mission/d4h.py`; tested against a mocked D4H server
(`tests/pipeline/test_command_post.py`). Not yet tried against a real D4H account: the endpoint, the
body and the server-side timing are from D4H's API documentation (Sources), and the bearer header is an
assumption to check on the first real push.

## After-action report (v1.3)

```bash
curl -s "$API/missions/$MID/report.md" > report.md       # or report.json
```

One printable page, written to the mission's files (`report/after_action.md` and `.json`) the moment
the mission is found (`POST /missions/{id}/found`) and built fresh on every request: incident name,
operational period (to the find), base camp, subject profile and the prior used, the outcome (who found
the person, in which sector, where and when), key events (first photo, each clue, each decision with
who, the find), areas searched with their POD and the drones' photo coverage by sector, photos
processed and reviewed, drone legs and flight minutes (from the fleet's leg start and end reports, else
the legs' planned minutes, and it says which), radio turns, the proposals approved and rejected by
who made them (agent, planner, verifier), the direct actions, a limitations line and the links to the
ICS 204s, 214, 309 and the CalTopo file. Code: `sightline/mission/report.py`.

## CalTopo / SARTopo GeoJSON

```bash
curl -s -o sightline.geojson "$API/missions/$MID/caltopo.geojson"
```

Import it in CalTopo or SARTopo with **Import**, then choose the file. GeoJSON keeps folders and styles
on import. The file is a FeatureCollection of five folders (`class: "Folder"`, linked by `folderId`):

| Folder | Features | Style |
|---|---|---|
| Sectors | 16 sector outlines (`Shape`, Polygon): POA, drone coverage, task state and team; the LKP (`Marker`, `cp`) | orange, red while assigned or in progress |
| Searched areas | one Polygon per searched sector, titled `B4 searched at POD 0.6` | blue, fill 0.25 |
| Drone legs | each leg that is not cancelled (`Shape`, LineString): drone, sector, altitude, minutes, status, reason | purple |
| Teams | each team with a position (`Marker`, `point`) | blue |
| Clues | each clue (`Marker`, `clue`): text, reliability, who reported it, time, radius | red |

The properties follow CalTopo's SimpleStyle names: `title`, `description`, `class`, `stroke`,
`stroke-opacity`, `stroke-width`, `pattern`, `fill`, `fill-opacity`, `marker-color`, `marker-symbol` and
`marker-size`. Strokes and fills are written `#RRGGBB`. Marker colours are written `RRGGBB` with no `#`,
as CalTopo exports them. CalTopo's own pages
(<https://training.caltopo.com/all_users/import-export/import>, `.../export`) say GeoJSON keeps styles and
folders on import, but they do not list the property names. The names here follow the SimpleStyle
convention CalTopo's GeoJSON uses, and the classes and marker symbols come from the `caltopo-python` list.
None of this has been tried on a real CalTopo import yet, so test one before relying on the colours and
folders.

## Sources

- FEMA ICS forms, ICS 204 Assignment List v3.1, ICS 214 Activity Log v3.1 and ICS 309 Communications
  Log v3.1: <https://training.fema.gov/icsresource/icsforms.aspx>. The block numbers and titles above
  are those forms'.
- D4H Operations Center API v1, incident logs (`POST /api/v1/orgs/{org}/incidents/{id}/logs`,
  `{message, tags}`, timed by the server): <https://operations-center.us.d4h.com/api/docs/v1>; Team
  Manager v3: <https://api.team-manager.us.d4h.com/v3/docs>. BCSARA chose D4H as BC's provincial SAR
  data system in 2017: <https://bcsara.com/?p=12102>.
- CalTopo import and export: <https://training.caltopo.com/all_users/import-export/import>,
  <https://training.caltopo.com/all_users/import-export/export>. Feature classes and marker symbols:
  <https://caltopo-python.readthedocs.io/en/latest/fixedChoices.html>.
