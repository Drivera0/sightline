# web/src/radio: the radio desk screen (lane E, E-14)

Lane E's folder. Lane E has no owner yet, so lane A built E-14 (issue #36) on the merged backend
(`sightline/radio/`, see its README). **Build on this; don't start it again.** Update the checklist below.

## What exists

| File | What it does |
|---|---|
| `RadioDesk.tsx` | The screen: channel header ("Channel 2 · Sightline relay · Operator: …"), the safety frame (LANE_E §8.1, `SAFETY_FRAME`), **hold to talk** (mouse, touch, or hold `V`), "Speaking as" team, text fallback (always there; the prompt changes when the microphone is refused), the readback card while a clue awaits confirmation, the **outbound queue** (approved briefings; Transmit / Skip), and the log (state word, ASR / model / first-audio timings, transcript and reply) |
| `api.ts` | Typed calls to the radio API (`postTurn`, `getOutbound`, `transmit`, `skip`, `chunkUrl`) and the `RadioTurn` / `TurnResponse` / `OutboundItem` types (mirror contract §12.2 until D-C1 regenerates `contract.ts`) |
| `store.ts` | `useRadio` (Zustand): stage (idle → recording → sending → speaking), turns, outbound, speaking-as, radio sound (the only thing persisted), errors; `DEMO_TEAMS` |
| `recorder.ts` | Push-to-talk recording with `MediaRecorder` (webm/opus); `MicDenied` when there is no microphone or permission |
| `player.ts` | Plays the reply's `audio_chunks` back to back (prefetching the next; a 404 means "still being generated", retried every 100 ms), with the optional radio sound (300–3400 Hz band-pass + faint static) |
| `dev.tsx` + `web/radio.html` | The screen alone (not in the site build) |

Tests (`pnpm exec vitest run src/radio`): rendering and safety frame, text fallback posts and plays,
hold-to-talk records and sends, refused microphone → text box, readback card, transmit only on the
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
- [ ] Lane E: input level meter while recording; "radio sound" also on the outbound playback in the video
- [ ] Lane E: the radio exchange in the Nebius video (LANE_E §8.7 demo script; rehearse with real voices)
