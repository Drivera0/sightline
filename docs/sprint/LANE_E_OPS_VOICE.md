# Workstream E · Ops & Voice: front door, command view, radio desk

> Superseded by [`web/src/command/README.md`](../../web/src/command/README.md),
> [`web/src/front/README.md`](../../web/src/front/README.md),
> [`sightline/radio/README.md`](../../sightline/radio/README.md) and
> [`docs/feedback/radio.md`](../feedback/radio.md) (measured latency and tool-calling results). This
> file keeps the plan, the radio's safety frame and each task's outcome. The front door is now the home
> page and the command view is the console.

**Folders:** `web/src/front/`, `web/src/command/`, `web/src/radio/`, `sightline/radio/`, `tests/radio/`,
`scripts/radio_*.py`, `docs/feedback/radio.md`.

## 1. Mission

- **Front door:** someone who has never seen Sightline knows who it is for, how photos get in, and
  whether it runs live or after landing, before they click anything.
- **Command view:** the search manager's screen: sectors on a task board, teams on a roster, every
  agent proposal in an approval inbox, ground reports in a clue log, and a printable assignment card
  with GPX for each team.
- **Radio desk:** backcountry teams rarely have cell signal; voice radio is the reliable link. Approved
  briefings go out as speech, and teams ask questions or report clues by voice, on NVIDIA open models.

## 2. Radio safety frame

> The radio desk runs on a **secondary channel under the comms operator**. It never initiates orders and
> never transmits unsupervised: it relays only information the search manager has approved, and the
> operator presses Transmit. Teams can ask it questions and report clues; a clue is committed only after
> Sightline reads it back and the team confirms. Every exchange is logged in the mission record.

Models as planned and as run:

| Step | Planned | Outcome |
|---|---|---|
| Speech → text | Parakeet TDT 0.6B v2 via NeMo on the GPU desktop | Done: 45–130 ms per phrase |
| Reasoning + tools | Nemotron via Token Factory, Nano first, Super if Nano missed tool calls | Done with Nemotron 3 Super, thinking off |
| Text → speech | Magpie TTS multilingual 357M; fallbacks hosted NIM, another NeMo voice, browser speech | Done with Magpie on the GPU desktop, no fallback needed; about 0.5× real time, spoken sentence by sentence |

## 3. Work items

| ID | Task | Outcome |
|---|---|---|
| E-01–E-03 | Front door: hero, how it works, who it is for, principles, roadmap; accessibility and offline check | Done #77, #113 (`web/src/front/`) |
| E-04 | Command view skeleton, demo fixtures from the demo cache's sectors | Done #78, #94 (`demoMission.ts`, `scripts/make_command_fixtures.py`) |
| E-05 | Task board with POD entry (no 100 % option) | Done #78; task moves enforced on the server #102 |
| E-06 | Team roster, fly-to | Done #78, #102 |
| E-07 | Approval inbox: approve, reject with reason, edit, decided by whom and when | Done #71 |
| E-08 | Clue log and Add clue form | Done #78, #102 |
| E-09 | Printable assignment card, GPX and KML | Done #93; GPX import into CalTopo checked #122 |
| E-10 | Event feed, mission header with conditions age | Done #102; the feed is a tab rather than the right rail |
| E-11 | Switch to `useMission` live, keep demo mode | Done #57, #78 |
| E-R0 | Radio spike: Parakeet, Magpie, a Nemotron tool call | Done #28: go, with Nemotron 3 Super |
| E-13 | Radio backend: audio, ASR, TTS, protocol, `radio_router` | Done #31, #34 (`sightline/radio/`) |
| E-14 | Radio desk UI: push-to-talk, log, playback, radio sound, text fallback | Done #37 (`web/src/radio/`) |
| E-15 | Outbound queue and Transmit | Done #34 (`/outbound`, `/outbound/{id}/transmit`) |
| E-16 | Turn handler, tools, prompt | Done #34, #38–#50 |
| E-17 | Clue by voice with readback and confirm | Done: 6/6 clues read back in the latency run |
| E-18 | Latency and word-error scripts, `docs/feedback/radio.md` | Latency Done #41, #110 (first sound p50 2.5 s with real voices); word error rate with three human voices Deferred (issue #49) |
| E-19 | Radio mounted in the app | Done #119 |
| E-12, E-20 | OpenCV and Nebius videos | Cuts rendered by `scripts/demo_video/` (#137, #151, #153); uploads Deferred to the submissions |
| E-21 | Parakeet on a Nebius Serverless Endpoint; a physical radio on an audio cable | Dropped: optional stretches; speech ran on the GPU desktop instead |

Built beyond the plan: a Trace tab that shows each agent chain in the product (#128), and fleet controls
in the command view (#144).

## 4. Tests

Vitest: no area wording in any string of the front door, command view or radio; only the allowed task
moves, with searched needing a POD in (0, 0.9]; demo mission actions append events; reject needs a
reason and an approved briefing is queued, not sent; clue form validation; the front door makes no
network request. `tests/radio/` with fake ASR, TTS and chat client: spoken coordinates round-trip;
callsign and reply parsing; a clue is posted once, only after "affirmative"; tools never change
assignments; a turn validates against the contract.

## 5. Cut order

From the bottom: Serverless Endpoint and physical radio shot · radio sound filter and three-voice word
error rate · clue by voice · radio questions · radio outbound · event feed and conditions header ·
assignment card · clue log · task board and approval inbox (never) · front door (never). Only the first
item and the three-voice recordings were not done.
