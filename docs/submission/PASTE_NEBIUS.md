# Paste-ready: Nebius × NVIDIA Global AI Hackathon (Devpost project form)

> Repo links should point at the tag (`nebius-submit`) once created; until then `main`. To switch, replace
> `/blob/main/` with `/blob/nebius-submit/` throughout. Fields only the owner can fill are marked `<OWNER: …>`.
> Every number below comes from `DEVPOST_NEBIUS.md` here, whose sources list ties each one to its file.

---

## Project name

Sightline

## Elevator pitch

(183 characters, limit 200)

```
One search map for drones, ground teams and the radio. NVIDIA Nemotron on Nebius Token Factory reads the photos and voice reports and proposes where to search next; a person approves.
```

## About the project

```markdown
## Inspiration

A search-and-rescue drone brings back hundreds of photos per flight; a missing person is about 70 px wide in each, and people reviewing by eye found 68 % of them in the published study. Meanwhile the search manager decides where drones and teams go next, from radio calls and a paper map. Drone tools stop at a flagged pixel; mapping tools track clues. None I found keeps one probability map that photos, sweeps and radio reports all update, and that directs both drones and people.

## What it does

- Detects each drone photo as it lands and places it on the map from its own GPS and camera pose.
- Updates a probability map with every photo, review, searched sector and clue. Searched ground shows how well it was searched; the software never rules an area out.
- **Nemotron VL takes a second look** at uncertain detections, from OpenCV re-look images.
- Proposes the next drone flight, re-task, team assignment or alert, with its reason. **A person approves every move**, logged with who and when.
- **A radio desk** for ground teams: Parakeet speech to text, Nemotron 3 Super with tools, Magpie speech. A clue is logged only after a readback.
- **Conditions from Tavily** at run time decide whether drones may fly.

On the [live site](https://sightline-iota-sandy.vercel.app) you are the search manager in a three-minute guided simulation: the AI proposes, you decide, and the end screen compares a manual search with yours (**Without Sightline vs with Sightline**, every assumption with its source). **Open the console** runs the same mission hands-on.

**Run a real search:** [`#new`](https://sightline-iota-sandy.vercel.app/#new) starts a live mission on the AWS API: drop aerial photos and each is detected with OpenCV 5 `cv2.dnn` on the server and placed on the map.

**Physical AI:** drones sense, the agent decides, drones and people act, and each action changes what is sensed next. A team's clue re-tasks the nearest drone; that drone's photo shows the person. The fleet is simulated, flying over real HERIDAL aerial photos through the same photo API a real drone would use.

## How I built it

Every language and vision model call goes through **Nebius Token Factory**, through one OpenAI-compatible client, and every model is an NVIDIA open model:

| Job | NVIDIA model | Runs on |
|---|---|---|
| Second look at uncertain detections | Nemotron-3.5-Super-VL | Token Factory |
| Briefings; reading conditions pages with quotes | Nemotron 3 Nano 30B-A3B | Token Factory |
| Radio turns with tool calls | Nemotron 3 Super 120B-A12B | Token Factory |
| Speech to text / text to speech | Parakeet TDT 0.6B v2 / Magpie TTS 357M | RTX 4080 SUPER (NeMo) |

- **Every AI step in the demo is a real Nemotron answer from Nebius Token Factory:** the demo mission and all four scenarios were re-recorded on Oct 26 with live calls (34 new calls, 50.1 s in all): three Nemotron 3.5 Super VL second looks per mission and one Nemotron 3 Nano briefing per assignment, replayed word for word, each labelled on screen with its model, "Nebius Token Factory" and its time; the Trace view counts them per mission.
- The VL verdict takes 1.35 s p50, about $0.00033 per detection, and 461 of 461 replies were valid JSON. A radio turn's first sound comes back in 2.5 s p50.
- A **Nebius Serverless Job** detected the simulated fleet's 711 photos with OpenCV 5 `cv2.dnn` in 483 s on 16 vCPUs, about $0.10; a **Serverless Endpoint** serves the same detector one photo at a time (5.68 s p50, $0.38 per 1,000 photos).
- **Tavily** searches and extracts the forecast, warnings and park alerts; Nemotron Nano keeps each value only with a verbatim quote. Nemotron Nano can also call Tavily itself to read a public missing-person bulletin.
- AWS runs the live API and photo worker; the web console is React, TypeScript and MapLibre.

## Challenges I ran into

- **Small people:** below 60 px Nemotron VL mostly answers "unclear". I kept that abstention rather than prompt it away.
- **Keeping a voice model honest:** with thinking off, Nemotron 3 Super sometimes put its reasoning in the reply, and once invented weather without calling the tool. Both are now enforced in code.
- **Never letting software rule an area out:** tests check every proposal, briefing and screen string.

## Accomplishments that I'm proud of

- Five NVIDIA models in one loop, each doing one job, each call traced.
- 6 of 6 radio clue reports read back and confirmed before they were logged.
- With Token Factory fully down, a mission pays about 82 s in all, not minutes per call; the approval gate held in 12 of 12 runs.
- What breaks first, stated up front: the detector misses 46 of 337 test people; the second look adds only 4 people for 15 false alarms; the fleet is simulated.

## What I learned

Tool calling with thinking off needs code-side guards for anything safety-relevant, and thinking tokens count against `max_tokens`, silently. A Serverless Endpoint needs no TLS or auth code on my side, but it has no scale to zero. Per-tool notes: [docs/feedback/nebius.md](https://github.com/Drivera0/sightline/blob/main/docs/feedback/nebius.md).

## What's next for Sightline

A Jetson field kit without internet (roadmap only, not yet run on a Jetson); thermal for night searches; real drone photos straight from the drone platform; a field trial with a search-and-rescue team.
```

## Built with

```
nvidia, nemotron, nvidia-nemo, parakeet, magpie, nebius, nebius-token-factory, nebius-serverless, tavily, opencv, python, onnx, yolo, ultralytics, pytorch, sahi, fastapi, pydantic, docker, react, typescript, vite, tailwindcss, maplibre, zustand, onnxruntime-web, aws, amazon-ec2, amazon-s3, amazon-sqs, amazon-cloudwatch, vercel, playwright, github-actions
```

## Try it out

- https://sightline-iota-sandy.vercel.app (guided simulation and hands-on console)
- https://sightline-iota-sandy.vercel.app/#new (a live search on the AWS API)
- https://sightline-iota-sandy.vercel.app/#try (try your own aerial photo: the detector runs in your browser)
- https://github.com/Drivera0/sightline
- https://github.com/Drivera0/sightline/blob/main/docs/report/OPENCV_REPORT.md

## Video demo link

`<YOUTUBE LINK>` (public, 3 minutes or less)

## Image gallery (upload in this order, 3:2)

Files in `docs/submission/figures/` (and in the Desktop `devpost/` folder).

1. `console-t0-the-call-pitch-bar.png`: 13:35, the call: the console on the overdue-hiker mission, the lost-hiker rings around the last known point on the probability map, two teams out on a hasty search and two at base camp.
2. `photos-land-t1-each-photo-ranked-and-placed.png`: Photos landing: each real HERIDAL photo, on a simulated drone's flight path, is ranked by the detector and placed on the probability map as it lands.
3. `second-look-t2-a-017-candidate-this-flight-opencv5-zoom-nemotron-vl.png`: The second look: a 0.17 candidate below the review threshold; Nemotron 3.5 Super VL on Nebius Token Factory calls it two people standing, and a person decides.
4. `trace-which-model-did-what-second-look.png`: Which NVIDIA model did what: the Trace view, step by step: the OpenCV zoom, the Nemotron VL call with the images it saw and its JSON verdict, then the proposal waiting for a person.
5. `run-t4-fleet-flying-b4-pod-60-conditions.png`: Physical AI: simulated drones (one flying on with its link lost, one relaying a team's radio) and ground teams act on one map; the Conditions panel (Tavily pages read by Nemotron 3 Nano, each value with its quote) decides whether drones may fly.
6. `debrief-t6-after-action-report-what-breaks-first.png`: The Debrief after the find: the after-action report, the areas searched at their POD, and what breaks first.

---

## Hackathon-specific questions

**Track:** Physical AI.

**Bonus awards (opt in if the form offers it):** Best Use of Tavily and Most Valuable Feedback. Not City Winner Awards (no in-person event).

**Representative:** `<OWNER TO FILL>`

**Team:** Solo, Daniel Rivera. `<OWNER: confirm age of majority and country/province of residence as the form asks>`

**Licence (open source, visible at the top of the repo):** GNU AGPL-3.0-or-later ([LICENSE](https://github.com/Drivera0/sightline/blob/main/LICENSE)), matching Ultralytics YOLO; the model weights are treated the same way. HERIDAL imagery: CC BY 3.0 (the Pyrrö VOC copy).

**Which NVIDIA models are used?** `nvidia/Nemotron-3.5-Super-VL` (the second look), `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` (briefings, conditions extraction, the debrief summary, the bulletin tool call), `nvidia/nemotron-3-super-120b-a12b` (radio turns with tool calls), Parakeet TDT 0.6B v2 (speech to text) and Magpie TTS multilingual 357M (text to speech), the last two through NeMo on a local RTX 4080 SUPER. Table with code paths: [README, Built with NVIDIA + Nebius](https://github.com/Drivera0/sightline/blob/main/README.md#built-with-nvidia--nebius).

**How is Nebius Token Factory used?** Every language and vision model call at run time goes through Token Factory's OpenAI-compatible API, through one client ([`sightline/agent/llm.py`](https://github.com/Drivera0/sightline/blob/main/sightline/agent/llm.py)); the key lives on the server only (AWS Secrets Manager), never in the browser. Every call is traced (model, input, output, ms). Measured: VL verdict 1.35 s p50, 461 of 461 valid JSON, about $0.00033 per detection; a circuit breaker after 4 failed attempts keeps a mission with Token Factory fully down to about 82 s in all. Nebius also ran the batch detection (Serverless Job, 711 photos in 483 s, about $0.10) and a Serverless Endpoint for on-demand detection.

**What was significantly updated during the submission period?**
Sightline began at BCS Hackathon 2026 (Oct 16–17, tag `bcs-final-submission`), built in 36 hours by a team of four (Daniel Rivera, Grace Chu (@bamobam), Harvir Nijjar (@har-vir) and Jason Kim (@jkiim)) as a batch tool: one drone survey, a tiled detector, a map and a Bayesian probability map, all from a precomputed cache. Everything below I added from Oct 20 to the `nebius-submit` tag (`git diff bcs-final-submission..nebius-submit`):
- live missions: photos processed as each flight lands, updates over server-sent events;
- every NVIDIA model call on Token Factory (Nemotron VL second look, Nemotron 3 Super radio turns, Nemotron 3 Nano briefings and conditions), each traced;
- an agent that proposes and a person who approves every move;
- the radio desk (Parakeet, Nemotron with tools, Magpie) with readback before a clue is logged;
- a simulated drone fleet whose clue-driven re-task uses the real planner, and an information-gain planner;
- Tavily conditions at run time, and the subject from a public bulletin;
- the Nebius Serverless Job and Endpoint; command-post exports (ICS 204, ICS 214, CalTopo); real-footage intake; the console, the guided simulation and the AWS deployment.
What stayed from BCS: the detector weights, the tiling, the map's core update and the demo survey. Full list: [NEBIUS_WHAT_CHANGED.md](https://github.com/Drivera0/sightline/blob/main/docs/submission/NEBIUS_WHAT_CHANGED.md). The same project is also entered in the OpenCV AI Competition 2026. Development used Claude Code (Anthropic) as an AI coding assistant; it is not part of the running product.

**Product feedback (per tool):** [docs/feedback/nebius.md](https://github.com/Drivera0/sightline/blob/main/docs/feedback/nebius.md) (and the radio desk's [docs/feedback/radio.md](https://github.com/Drivera0/sightline/blob/main/docs/feedback/radio.md)). Summary:
- Token Factory: key to first chat call in about 3 minutes; one OpenAI-compatible client for vision, text and tools. Snag: with thinking on, replies came back empty once thinking used the token budget, silently; fixed by turning thinking off.
- Nemotron VL: 461 of 461 valid JSON, 1.35 s p50; on people under 60 px it mostly answers "unclear".
- Nemotron 3 Super: good tool use, but with thinking off it sometimes leaked reasoning into the spoken reply and once invented weather; code-side guards needed.
- Serverless Jobs and Endpoints: first detection from my endpoint in about 14 minutes; the CLI prints the token in plain text and endpoints have no scale to zero (272.9 s to answer again after a stop).
- NVIDIA hosted catalogue lists Cosmos Reason, but every call returned 404 with nothing marking it retired.

**Tavily usage (bonus):** runtime calls, not a one-off. Each active mission's conditions are checked every 30 minutes: three Tavily searches (forecast, weather warnings, park and trail alerts, limited to the sources that publish them) and one extract of the best forecast page, cached per area and clock hour (at most four calls per area per hour). Nemotron Nano reads the pages and keeps a value only with a verbatim quote; the values gate the drones (gust limit, flyable-until), set how much a photo can see, and go into team briefings. Nemotron Nano can also call Tavily itself as a tool (`search_public_bulletin`) to read a public missing-person bulletin; three live runs, two abstained, one proposed "hiker, 20". [docs/report/TAVILY.md](https://github.com/Drivera0/sightline/blob/main/docs/report/TAVILY.md).
