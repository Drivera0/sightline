# Devpost draft: Nebius × NVIDIA Global AI Hackathon (Physical AI track)

**Name:** Sightline
**Tagline:** The brain of a drone search: one brain, many eyes, every channel.
**Track:** Physical AI
**Repo:** https://github.com/Drivera0/sightline (AGPL-3.0, tag `nebius-submit`)
**Demo:** https://sightline-iota-sandy.vercel.app (`#m/demo/command` for the command view on a demo mission)
**Video:** TODO (≤ 3 min, public YouTube)

## Inspiration

When a hiker goes missing, search-and-rescue teams fly drones and come back with hundreds of photos. A
person is about 70 pixels wide in each one. Volunteers reviewing by eye take about 33 s a photo, and in
a published study they found 68 % of the people. Meanwhile the search manager has to decide where the
drones and the ground teams go next.

## What it does

Drones and ground teams feed one probability map, and the map directs both.

- **Photos:** each drone photo is detected as it arrives (YOLO11s on OpenCV 5 `cv2.dnn`) and placed
  from its own GPS and camera pose.
- **The map:** a probability map of where the person could still be updates with every photo, every
  review, every searched sector and every clue a team reports.
- **The agent:** Nemotron VL takes a second look at uncertain detections. The agent and an
  information-gain planner propose the next drone leg, a re-task, a team assignment or an alert, each
  with its reason. **A person approves every move.**
- **The radio:** ground teams talk to Sightline on a radio channel. Parakeet hears them, Nemotron
  answers from the mission with tools, and Magpie speaks. Clues are logged only after a readback.
- **Conditions:** Tavily brings the forecast, warnings and park alerts. They decide whether drones may
  fly and what teams are told.
- **The fleet:** a simulated fleet of three drones flies the approved legs. In the creek scenario, a
  team's clue re-tasks the nearest drone, and its photo shows the person.

## How we built it

- **Nebius Token Factory** for every model call: Nemotron-3.5-Super-VL, Nemotron 3 Super, Nemotron 3
  Nano.
- **Speech:** Parakeet TDT and Magpie TTS on an RTX 4080 SUPER.
- **Nebius Serverless Job** for batch detection of the fleet's photos: 711 photos in 483 s on 16 vCPUs,
  about $0.10.
- **Tavily** for conditions.
- **App stack:** FastAPI, React and MapLibre, on AWS (S3, SQS, EC2, CloudWatch).
- **Records:** every model and tool call is in a per-mission trace.

## Challenges

- Small people in big photos: we tile the photos, and the second look abstains below 60 px rather than
  guess.
- Keeping a voice model honest. A spoken clue is read back and confirmed in code, conditions must come
  from a tool that turn, and nothing is transmitted without approval.
- Never letting software say an area is "clear". Tests check this across the whole system.

## Accomplishments

- On the HERIDAL test set the detector finds 86 % of people (strict scoring; 90 % under the study's
  scoring), against 68 % for people reviewing by eye.
- The first sound on the radio comes in 2.5 s (p50) and 3.0 s (p90), with real voices.
- In simulation, three coordinated drones find the person within 30 minutes about 3× as often as one.
  Against a hand split of the sectors it is only a small edge, and we say so.

## What we learned

See `docs/feedback/nebius.md` (Token Factory, Serverless Jobs) and `docs/feedback/radio.md` (Parakeet,
Magpie, tool calling over voice).

## What's next

Thermal cameras for night searches. DJI FlightHub 2 so photos arrive by themselves. An NVIDIA Jetson
field kit with no internet. Field trials with a search-and-rescue team.

**What changed during the submission period:** see `docs/submission/NEBIUS_WHAT_CHANGED.md`.
