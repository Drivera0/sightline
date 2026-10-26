# Devpost: Nebius × NVIDIA Global AI Hackathon (Physical AI track)

**Name:** Sightline
**Subtitle:** One search map for drones, ground teams and the radio, on Nemotron: drone photos and voice reports in, where to search next out
**Track:** Physical AI
**Repo:** https://github.com/Drivera0/sightline (AGPL-3.0, tag `nebius-submit`, created at submission)
**Demo:** https://sightline-iota-sandy.vercel.app (no server needed). Start from the home page: press **Try the guided simulation** and pick a scenario under **Guided simulation** (**Start the simulation**; the overdue hiker is marked "Start here"). You are the search manager: the clock runs to each decision and waits, the AI proposes with its reason and what each option costs in minutes, you decide, and the simulation shows what your decisions change on the map, the teams and the clock. **What you did** at the end sets your line beside the agent's and prints every draw. `#m/demo/map` is the plain console at the end of the scenario's timeline.
**Where to look, in order:** the home page (`#`) → **Start the simulation** on a scenario card (about 3 min, `#m/demo?s=<seed>&guide=1`) → **What you did** → the Trace view (`#m/demo/trace`) → Conditions, W in the console (`#m/demo/map/conditions`) → the Debrief: results, what breaks first and the links out (`#m/demo?t=6`; the old `#judges` redirects to its list for judges) → About on the home page (`#about`), and Built with for the models
**Video:** <to add>

<!--
Video outline for Dan (≤ 3:00, public YouTube; from .documents/WIN_RESEARCH.md §8, Nebius video, a trim of the OpenCV master):
0:00–0:10 Dan on camera, one line + "runs on Nebius Token Factory" said aloud.
0:10–0:25 The home page → Start on the overdue hiker: the guided search, photos landing, 2× speed.
0:25–0:55 Detection → re-look with the Trace view showing which NVIDIA model did what (Nemotron VL, Nemotron Super, Parakeet, Magpie).
0:55–1:25 Fleet re-task moment: clue by radio → map shifts → agent proposes diverting the nearest drone → approve → drone turns (≥ 1 min of key modules in action starts here).
1:25–1:50 Assignment card → radio exchange, 8 s of audio.
1:50–2:15 Tavily moment: gusts → no-fly → recall, with the cited source. Architecture with the Nebius box highlighted; Serverless Job line (711 photos, 483 s, ~$0.10).
2:15–2:40 Limits (2 bullets) + what's next (Jetson field kit, thermal).
2:40–3:00 On camera close, repo + live URL.
Production: burn in captions; name Nebius and NVIDIA with audio; mark "Not for Kids"; no copyrighted music.
-->

**Gallery (in this order):**

1. *The console on the demo mission at 13:35 PDT, the call (Demo and "Simulation on real aerial photographs" chips): the pitch bar, the status line (5 min elapsed, 5 h 02 min of daylight left, flyable to 18:36, nobody out, subject not found), the four team cards on standby, Koester's lost-hiker rings around the last known point on the probability map, base camp at the trailhead lot, and the timeline along the bottom.* (`docs/submission/figures/console-t0-the-call-pitch-bar.png`)
2. *14:00 PDT, photos landing: partway through the survey flight (real HERIDAL photos on a simulated flight path), each photo is ranked by the detector and placed on the probability map as it lands, the map lowers where the first leg has looked, and Needs You fills with the first 8 candidates for a person to confirm.* (`docs/submission/figures/photos-land-t1-each-photo-ranked-and-placed.png`)
3. *14:31, confirm: a person answers every candidate. The third, from this flight's photo f0273, scored only 0.17, below the review threshold; Nemotron 3.5 Super VL on Token Factory looked again at an OpenCV zoom and answered "likely a person, standing, 2 people", so the agent promoted it, and marking it Person pins a sighting on the map. The zoom is open on the card (the model's live answer, kept word for word).* (`docs/submission/figures/second-look-t2-a-017-candidate-this-flight-opencv5-zoom-nemotron-vl.png`)
4. *Which NVIDIA model did what: the Trace view's model strip (Nemotron 3.5 Super VL for the second look, Nemotron 3 Nano for the conditions pages) and that chain step by step: the crop and the native zoom Nemotron VL answered from, its verdict (the live answer, replayed word for word in the demo's own trace), and the proposal waiting for a person.* (`docs/submission/figures/trace-which-model-did-what-second-look.png`)
5. *14:58 PDT, the run: three simulated drones fly their legs, Drone 2 has lost its link (it flies its approved leg on its own and keeps its photos on board) and Drone 3's degraded link relays Team Two, who has no signal; Teams One and Two are searching C2 and B2, and B4 is searched at POD 60 %, its probability lowered by that. The Conditions panel (W) is open: the flyability gate (flyable until about 18:36 PDT, gust limit 43 km/h for Drone 1) on the demo's own conditions, and another evening's recorded live lookup folded below it (Tavily searched and extracted the pages, Nemotron 3 Nano on Token Factory read them, each value with its quote and page).* (`docs/submission/figures/run-t4-fleet-flying-b4-pod-60-conditions.png`)
6. *15:00 PDT, the Debrief after the find: the after-action report (found by Team One in C2 at 14:59, where found, the areas searched at their POD: B4 60 %, C4 40 %) and what breaks first, in the report's words, with the radio exchange that reported the find in the timeline. Its second line is the Nemotron VL second look's measured gain. The key events, the exports and the measured results sit between the two in the app and are left out of this frame; the fleet simulation and radio latency numbers are in the report's tables.* (`docs/submission/figures/debrief-t6-after-action-report-what-breaks-first.png`)

---

For search managers, Sightline turns drone photos and radio reports into one map that says where to look next, so teams are tasked in minutes.

**What breaks first,** before you ask [13]:

1. The detector misses 46 of the 337 people in the HERIDAL test set (recall 0.864, strict VOC), and 28 of those 46 are at two sites, MED and CAB: groups, clothing that matches pale or dark rock, people sitting or lying down.
2. The second look is a small gain: on test it finds 4 more of the 337 people for 15 more false alarms (95 % CI of the recall gain [+0.003, +0.023]), it is advice a person approves, and on people under 60 px it mostly answers "unclear".
3. The fleet and the approvals in the demo are simulated: the drones, their flights and their photos are simulated, and the human approvals in the recorded traces are scripted; both are labelled so on screen and in the trace.

Measured, with the caveat beside each number:

- **The detector finds 89.6 % of people on the HERIDAL test set against 68 % for people reviewing by eye, scored the study's loose SAR-APD way; under strict VOC scoring it is 86.4 %** [1].
- **In simulation, with a clue at the start, three drones planning on one shared map find the person within 30 minutes in 22.7 % of trials against 20.0 % for a hand split; with realistic wind, battery swaps, GPS error and link loss the lead holds (15.9 % vs 11.5 %, seed ranges apart); with no clue they are level** [2].
- **With Token Factory fully down, a mission now pays about 82 s in all (a circuit breaker after 4 failed attempts), and on the whole live system the agent sent the drone, alert, team and promotion to the person's sector or detection in every run of its evaluation, with the approval-gate checks passing in 12 of 12 runs (fake models)** [12].
- **Nemotron VL's second look finds 4 more of 337 people on test at the cost of 15 more false alarms (95 % CI of the gain [+0.003, +0.023], p < 0.05), and is advisory** [3].
- **The planner adds nothing on a flat prior; with a clue it finds the person within 30 minutes in 10.7 % of trials against 6.3 % for a fixed order** [4].
- **A 500-photo mission's compute costs under a dollar:** about $0.67 with detection on AWS, the Nemotron VL second look and Tavily, or $0.49 with detection as a Nebius Serverless Job; the detector uses about 17 Wh (an estimate from CPU-seconds) [14].

## Inspiration

A drone brings back hundreds of photos per flight; a missing person is about 70 px wide in each, and people reviewing by eye found 68 % of them in the published study [1]. The search manager meanwhile decides where drones and teams go next, from radio calls and a paper map.

Everyone detects; nobody closes the loop. DJI FlightHub 2, Skydio and Eagle Eyes stop at a flagged pixel; CalTopo tracks clues, but none we found keeps a probability map that photos and sweeps update. Sightline joins the two: every photo, negative sweep and radio report updates one map, and the map directs both drones and people.

## What it does

- Detects each drone photo as it lands and places it on the map from its own GPS and camera pose.
- Updates a probability map with every photo, review, searched sector and clue. Searched ground shows how well it was searched; the software never rules an area out.
- Proposes the next drone leg, re-task, team assignment or alert, with its reason. **A person approves every move.**
- Talks to ground teams on a secondary radio channel, and logs a clue only after a readback.
- Takes real footage too: `scripts/real_flight.py` checks each file's GPS, altitude, gimbal and GSD, geotags video frames from a DJI SRT or flight log (a frame with no track point within 1 s is skipped, never guessed), and sends the folder through the live API, labelled "real flight, real detector, fleet simulated"; so far tested on synthetic files only, no real footage yet [17].

## How we built it

Every language and vision model call goes through **Nebius Token Factory** at run time, through one OpenAI-compatible client (`sightline/agent/llm.py:224`). Every model is an NVIDIA open model:

| Job | NVIDIA model | Runs on | Code |
|---|---|---|---|
| Second look at uncertain detections (crop + OpenCV re-look images → JSON verdict) | `nvidia/Nemotron-3.5-Super-VL` | Token Factory | `sightline/agent/verify.py` |
| Briefings for teams; reading conditions pages with quotes | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | Token Factory | `agent/loop.py:155`, `geo/conditions.py:338` |
| Radio turns with tool calls | `nvidia/nemotron-3-super-120b-a12b` | Token Factory | `radio/turn.py:219` |
| Speech to text | Parakeet TDT 0.6B v2 | RTX 4080 SUPER (NeMo) | `radio/asr.py` |
| Text to speech | Magpie TTS multilingual 357M | RTX 4080 SUPER (NeMo) | `radio/tts.py` |

- **Measured on Token Factory:** the VL verdict takes 1.35 s p50, costs about $0.00033 per detection at catalog prices, and 461 of 461 replies were valid JSON [5]. A radio turn's first sound comes in 2.5 s p50 with the reply spoken by Magpie (team lines typed) [6].
- **Nebius Serverless Job:** the simulated fleet's 711 photos detected on CPU with OpenCV 5 `cv2.dnn` in 483 s on 16 vCPUs, about $0.10 [7].
- **Nebius Serverless Endpoint:** the same detector on demand, one photo over HTTPS on a CPU endpoint (8 vCPU): 5.68 s p50 for a 4000×3000 photo, $0.38 per 1,000 full photos, cold start 291.5 s; it gave the batch job's one candidate, box for box. The worker switches to it with `SIGHTLINE_DETECT_URL` [15].
- **Tavily** brings the forecast, warnings and park alerts; they decide whether drones may fly.
- **Tavily as the model's own tool:** for a mission with no subject, Nemotron Nano decides whether to call `search_public_bulletin`, writes the query, and Tavily searches trusted domains then extracts; a profile field is kept only with a verbatim quote, names are redacted, and approval sets the lost-person prior. Three live runs: two abstained (no quote named a category), one proposed "hiker, 20" [16].
- **AWS** runs the live API and the photo worker.

**What is simulated.** The drones, their flight and battery, and their photos (crops of HERIDAL validation photos at simulated poses) are simulated, as are the ground teams' positions and the search-map evaluations. In the recorded traces the human steps are scripted, and the trace says so; on the site, the fixture's scripted decisions read "The scenario's search manager" and its stand-in model calls "Replayed", and the guided simulation's find comes from seeded draws at the sector's POD (0.60), printed on its end screen. Real: detection, the map math, every Nemotron call on Token Factory, Tavily, the radio's speech models, the AWS deployment and the Serverless Job [8].

**Physical AI fit.** Sightline is the decision layer of an embodied team: drones sense, the agent decides, drones and people act, and each action changes what is sensed next. A clue from a team re-tasks the nearest drone; that drone's photo shows the person [9]. The FAQ allows simulation, and our fleet flies through the same photo API a real drone would use. The edge is roadmap only: Ultralytics measures YOLO26n with TensorRT FP16 at 4.57 ms per image on a Jetson Orin Nano Super [10], so a field kit without internet is plausible, but we have not run Sightline on a Jetson.

## Challenges

- **Small people:** below 60 px Nemotron VL mostly answers "unclear". We kept that abstention rather than prompt it away [3].
- **Keeping a voice model honest:** with thinking off, Nemotron 3 Super sometimes put its reasoning in the reply, and our radio spoke it; it once invented weather without calling the tool. Both are now enforced in code [11].
- **Never letting software rule an area out.** Tests check every proposal, briefing and screen string.

## Accomplishments

- Five NVIDIA models in one loop, each doing one job, each call traced.
- 6 of 6 radio clue reports read back and confirmed before they were logged [6].
- A clue-to-re-task chain on a live mission with the real planner [9].

## What we learned

Tool calling with thinking off needs code-side guards for anything safety-relevant. Thinking tokens count against `max_tokens`, silently. A Serverless Endpoint needs no TLS or auth code of ours, but its CLI prints the token in plain text and it has no scale to zero, so a stopped endpoint takes 272.9 s to answer again [18]. NVIDIA's hosted catalogue lists Cosmos Reason, but every call to it returns 404 and nothing marks it retired; the stand-in second verifier (Nemotron 3 Nano Omni) was slower and less precise than Nemotron-3.5-Super-VL, which stays (`docs/report/COSMOS_VERIFIER.md`). Details, per tool: `docs/feedback/nebius.md`, `docs/feedback/radio.md`.

## What's next

A Jetson field kit without internet; thermal for night searches; real drone photos through DJI FlightHub 2; a field trial with a search-and-rescue team.

**What changed during the submission period:** `docs/submission/NEBIUS_WHAT_CHANGED.md`.

---

### Sources for every number

1. `docs/report/OPENCV_REPORT.md:34-35`, `:294-296`; `README.md:39`, `:89`
2. `docs/report/FLEET_V2.md` (results table); `docs/report/OPENCV_REPORT.md:712-723`
3. `docs/report/OPENCV_REPORT.md:537-544`; `docs/LANE_A_ML.md:314`
4. `docs/report/OPENCV_REPORT.md:662-672`
5. `docs/feedback/nebius.md:72-75`
6. `docs/feedback/radio.md:84`, `:101`
7. `docs/feedback/nebius.md:174-177`; `README.md:103`
8. `docs/report/OPENCV_REPORT.md:884-886`, `:999-1002`
9. `README.md:78`; `docs/architecture/agent.md` ("A second chain"); `scripts/creek_run.py`, `scripts/retask_chain.py`
10. Ultralytics, "NVIDIA Jetson" guide, Orin Nano Super benchmark table, YOLO26n, TensorRT FP16 (https://docs.ultralytics.com/guides/nvidia-jetson/, read 2026-10-22)
11. `docs/feedback/radio.md:76-79`, `:115-120`
12. `docs/report/AGENT_EVAL.md` (failure handling, correct target, approval gate); `docs/report/OPENCV_REPORT.md:547-562`, `:577`, `:583-587`
13. `docs/submission/WHAT_BREAKS_FIRST.md`; `docs/report/OPENCV_REPORT.md:853-855`, `:537-538`, `:884-886`; `docs/DETECTOR_LIMITS.md:39`, `:54`
14. `docs/report/OPENCV_REPORT.md` §4.1 (inputs: `:374`, `:377`, `:381`; `docs/feedback/nebius.md:75`, `:175-178`; `docs/report/TAVILY.md:15`; `docs/report/CV2_CUDA.md:143`)
15. `deploy/nebius/ENDPOINT.md:59-70`; `docs/feedback/nebius.md:224-230`; `docs/evidence/nebius_endpoint/20261022-1747/`
16. `docs/report/TAVILY.md:134-147`, `:230-232`; `docs/evidence/subject/`
17. `docs/REAL_FLIGHT.md:1-11`, `:73`; `scripts/real_flight.py:52`
18. `docs/feedback/nebius.md:232-248`
