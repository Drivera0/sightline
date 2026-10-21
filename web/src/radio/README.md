# web/src/radio: the radio desk screen (lane E, E-14)

Lane E's folder. Lane E has no owner yet, so lane A built E-14 (issue #36) on the merged backend
(`sightline/radio/`, see its README). **Build on this; don't start it again.** Update the checklist below.

## What exists

| File | What it does |
|---|---|
| `RadioDesk.tsx` | The screen: channel header ("Channel 2 · Sightline relay · Operator: …"), the safety frame (LANE_E §8.1, `SAFETY_FRAME`), **hold to talk** (mouse, touch, or hold `V`), "Speaking as" team, text fallback (always there; the prompt changes when the microphone is refused), the readback card while a clue awaits confirmation, the **outbound queue** (approved briefings; Transmit / Skip), a **level meter** while recording (and a warning if the clip was silent: wrong input device), and the log, newest first (state word; ASR / model / voice timings, where voice "cached" means the opener came from the phrase cache; **first sound**, measured in the browser from Send to the first audio played, standby included; transcript and reply) |
| `api.ts` | Typed calls to the radio API (`postTurn`, `getOutbound`, `transmit`, `skip`, `chunkUrl`) and the `RadioTurn` / `TurnResponse` / `OutboundItem` types (`RadioTurn` comes from the generated `contract.ts`) |
| `store.ts` | `useRadio` (Zustand): stage (idle → recording → sending → speaking), turns, outbound, speaking-as, radio sound (the only thing persisted), errors; `DEMO_TEAMS` |
| `recorder.ts` | Push-to-talk recording with `MediaRecorder` (webm/opus), plus `level()` (RMS from an `AnalyserNode`) for the meter; `MicDenied` when there is no microphone or permission |
| `player.ts` | Plays the reply's `audio_chunks` back to back (prefetching the next; a 404 means "still being generated", retried every 100 ms), with the optional radio sound (300–3400 Hz band-pass + faint static) |
| `dev.tsx` + `web/radio.html` | The screen alone (not in the site build) |

Tests (`pnpm exec vitest run src/radio`): rendering and safety frame, text fallback posts and plays,
hold-to-talk records and sends, level meter and silent-clip warning, log newest first, refused microphone → text box, readback card, transmit only on the
button and skip, multipart payload shape for text and audio, and no "clear"/"cleared" in any radio file.

## Run it

```bash
uv run uvicorn sightline.radio.dev:app --port 8010      # backend with the demo mission (live Nemotron if NEBIUS_API_KEY)
cd web && pnpm dev                                       # then open http://localhost:5173/radio.html
```

Real voices need the NeMo environment: `SIGHTLINE_RADIO_MODELS=real ~/radio-env/bin/uvicorn sightline.radio.dev:app --port 8010`
(see `sightline/radio/README.md`). `?api=<base>&mission=<id>` points the page at another server.

## Still to do

- [ ] Lane D (D-R3): mount `<RadioDesk api={{ base: "", missionId }} teams={...} operator={...} />` in the
      command view's right rail or `#radio`; pass the mission's teams from `useMission` (D-M1) instead of `DEMO_TEAMS`
- [ ] Lane D (D-R4): mount `radio_router` with a `RadioContext` (backend README)
- [x] Input level meter while recording, silent-clip warning, first sound measured in the browser, log newest first
- [x] "Radio sound" for the video: the desk already applies it to transmitted briefings; `scripts/radio_rehearse.py --audio --radio-sound` bakes it into the rehearsal WAVs
- [ ] Lane E: the radio exchange in the Nebius video (LANE_E §8.7 demo script; rehearse with real voices)
