# Exports: files a command post can file

Sightline writes three standard search-and-rescue outputs from a live mission. They follow the FEMA
ICS forms and CalTopo's GeoJSON import. All three are reads, so they work without the write token
(`sightline/api/auth.py`). Each is built when you ask for it, from the mission as it stands at that
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

Prepared by is the most recent decision-maker.

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

- FEMA ICS forms, ICS 204 Assignment List v3.1 and ICS 214 Activity Log v3.1:
  <https://training.fema.gov/icsresource/icsforms.aspx>. The block numbers and titles above are those
  forms'.
- CalTopo import and export: <https://training.caltopo.com/all_users/import-export/import>,
  <https://training.caltopo.com/all_users/import-export/export>. Feature classes and marker symbols:
  <https://caltopo-python.readthedocs.io/en/latest/fixedChoices.html>.
