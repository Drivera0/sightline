# Sightline

Sightline finds the hiker in hundreds of search-and-rescue drone photos, then shows the rescue team where to look next. A detector ranks the photos, each detection becomes a pin on a map, and a Bayesian probability map updates after every photo. It assists searchers; it never decides that an area is clear. Built for BCS Hackathon 2026, then extended into live missions (an agent that proposes, people who approve, a radio desk and a simulated drone fleet) for the OpenCV and Nebius hackathons.

**Live demo: https://sightline-iota-sandy.vercel.app**

![Sightline walkthrough: survey, rank, review, search next, results](docs/media/sightline-demo.gif)

*The five steps on the demo survey, 29 s, sped up in places (recorded from the local build; the flight path and the search evaluation are simulated).*

![Sightline system architecture](docs/architecture/system.png)

## What the demo shows

The site walks through one survey in five steps (keys 1 to 5):

1. **Survey**: 500 drone photos from a search over Mount Seymour.
2. **Rank**: the detector scans every photo, draws its boxes, and builds a queue with the likeliest people first. A side panel shows the network it runs and each photo's score against the flag threshold.
3. **Review**: a searcher answers each candidate (Person, Not a person, Unsure) while confirmed people are pinned on the map.
4. **Search next**: a probability map of where the person could still be. Photographed ground fades as the drone sees it; ground never photographed stays marked as not yet searched.
5. **Results**: the numbers below, with their sources.

A second survey, real HERIDAL photos at their recorded EXIF positions, is in the survey menu. The Mount Seymour flight path and the search evaluation are simulated, and the site labels them that way.

## Live missions

A live mission runs the same detector and map while the search happens, through a mission API (`python -m sightline.pipeline serve --mission-root missions`):

- **Photos in** after each landing (drag the SD card's photos in, or `python -m sightline.client watch FOLDER`), or replayed at drone pace (`... client replay`). Each one is detected with OpenCV 5 `cv2.dnn`, placed on the map from its GPS and camera pose, and steps the probability map.
- **An agent proposes; a person decides.** Uncertain detections get a second look (OpenCV 5 re-look tools, then Nemotron VL). The agent turns verdicts, clues, conditions and the planner's legs into proposals: promote a detection, fly a drone leg, re-task a flying drone, assign a sector to a team, alert the teams. Nothing happens until the search manager approves it in the **command view** (task board, team roster, approval inbox, clue log, live heat map, printable assignment cards with GPX/KML). Every model and tool call is in the mission's trace.
- **The radio desk** puts Sightline on a secondary voice channel: teams ask questions and report clues by voice; a clue is logged only after Sightline reads it back and the team confirms; it transmits only briefings the search manager approved, when the operator presses Transmit.
- **Conditions from the web** (Tavily, below) gate the drones and shape the briefings.
- **A simulated drone fleet** (labelled so everywhere) flies approved legs and sends its photos through the same API (`python -m sightline.search.fleet run`); `scripts/creek_run.py` runs the whole story: a team's clue → the agent re-tasks a drone → its photo shows the person → review → alert.
- **A debrief** from the log: every proposal and who decided it, each sector's coverage and POD (`GET /missions/{id}/debrief.md`).

Try the command view without a server: **`#m/demo/command`** on the live site (a demo mission, simulated data). The API runs on AWS between demos (`deploy/aws/`). The OpenCV report, with the measured numbers: [docs/report/OPENCV_REPORT.md](docs/report/OPENCV_REPORT.md).

![The command view on a live mission](docs/architecture/screens/command-view.png)

## Results

From `metrics.json` (the HERIDAL test set: 101 photos, 337 people, never used for training or threshold tuning; see the disclosure below). The human study scored people with the paper's loose search-and-rescue matching (SAR-APD), so the comparison uses the same scoring for us:

| SAR-APD scoring, as in the human study | Sightline detector | Human baseline |
|---|---|---|
| Recall | **0.896** | 0.68 |
| Precision | **0.898** | 0.59 |
| Time per full 4000×3000 photo | 0.25 s (GPU) | 33 s |

Under the strict VOC scoring (one box per person, IoU ≥ 0.5) the same detector scores recall **0.864**, precision **0.802**, AP50 0.868; those are the numbers used everywhere else (threshold choice, ablations, the search map's detection probability).

Human baseline: Pyrrö, Naseri & Jung 2021, arXiv:2111.09406.

**Mirror-image experiment (not in the demo).** Running each photo and its mirror image and fusing the boxes passed our validation rule (val F2 0.857 vs 0.831, 95% CI of the gain [+0.004, +0.048]). Scored once on test it gave recall 0.858, precision 0.835, AP50 0.872 at 0.50 s per photo: within noise of the single view, with 2 fewer people found and twice the time. The demo's photos were detected single-view and there was no time to rebuild the demo and every number around it, so the single-view model stays the reported one. That last decision was made after the mirror test score was seen, so both are reported here. Details: [docs/LANE_A_ML.md](docs/LANE_A_ML.md) §6.3a.

**Disclosure:** the threshold and every inference setting were chosen on the validation split, but two earlier model choices were made with test scores in view: keeping training run 2 over run 1, and dropping the hard-negative fine-tune (test F2 0.840 vs 0.850). The test numbers above are therefore slightly optimistic. Since then every choice is made on validation only ([scripts/README.md](scripts/README.md)).

- **Ranking (demo survey):** all 6 photos with a person were in the first 7 photos of the review queue; the first one is photo 1.
- **Search map (simulated, 1,341 trials with the person in a photographed cell, 5 m cells):** a ground team checks a median of 1,213 cells with Sightline's map, against 1,743 for a naive "photographed = cleared" map (seed 7, the best of the three seeds tried). In the robustness check on the same 5 m map it was better in all 15 runs (3 seeds × 5 noise levels): 28–30% fewer cells at the default noise, 19–23% with noise matching the canopy estimate's measured error (docs/LANE_C_SEARCH.md).
- **Where it fails:** groups of people, clothing that matches pale or dark rock, people sitting or lying down. While analysing the misses we found 42 test labels squashed by a size bug in four photos; fixing it moved recall from 0.769 to 0.864. Details: [docs/DETECTOR_LIMITS.md](docs/DETECTOR_LIMITS.md).

## How the detector works

![Sightline ML pipeline](docs/architecture/ml-pipeline.png)

A person is about 70 px wide in a 4000×3000 photo, so shrinking the photo to the model's input loses them. YOLO11s (9.43 M parameters) is fine-tuned for 80 epochs on overlapping 1024 px tiles from 890 labelled HERIDAL photos, and runs the same way: SAHI slices each photo into 1024 px tiles and merges the boxes. The merge settings and the 0.29 threshold were chosen on validation (the threshold by maximising F2), because a missed person costs more than a false alarm a searcher dismisses in seconds. What pays off is working at native resolution. Trained the same way on whole photos shrunk to 1920 px, the model's test recall is 0.804 against 0.864 (AP50 0.776 against 0.868). At inference, slicing is not the only way to keep that scale: the same weights run on the whole 4000 px photo in one pass score as well as tiling (test recall 0.905, AP50 0.887, precision 0.723 against 0.802) in about a third of the time, but need 5.7 GB of GPU memory against 0.28 GB for tiles. Shrinking the photo to 1024 px is what fails (test recall 0.234). The reported detector still uses tiled inference (the demo's 1000×750 frames fit in one pass either way). Every threshold was chosen on validation; full table in [scripts/README.md](scripts/README.md).

Both diagrams, with notes: [docs/architecture/sightline-architecture.html](docs/architecture/sightline-architecture.html). They are drawn to the [Diagram Design](https://github.com/cathrynlavery/diagram-design) rules by `docs/architecture/build_architecture.py`.

## Built with NVIDIA + Nebius

Every language and vision model call goes through **Nebius Token Factory** at run time (OpenAI-compatible API, key on the server only, never in the browser), and every model is an NVIDIA open model. All calls go through one client, `sightline/agent/llm.py`.

| What Sightline does | NVIDIA model | Runs on | Code |
|---|---|---|---|
| Second look at uncertain detections: the crop plus OpenCV 5 re-look images in, a JSON verdict out (person, posture, group size, clothing, reason) | Nemotron-3.5-Super-VL (`nvidia/Nemotron-3.5-Super-VL`) | Token Factory | `sightline/agent/verify.py` |
| Radio-style briefings for ground teams, written only from given facts and post-checked (≤ 60 words, never "clear", no invented numbers) | Nemotron 3 Nano (`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`) | Token Factory | `sightline/agent/loop.py` |
| Planning text and tool calls | Nemotron 3 Super (`nvidia/nemotron-3-super-120b-a12b`) | Token Factory | `sightline/agent/llm.py` (`MODEL_REASON`) |
| The radio desk: speech in, an answer from tools (sector boundary, assignment, conditions, clue drafts), speech out | Parakeet TDT 0.6B v2 (speech to text), Nemotron 3 Super with tool calls, Magpie TTS | speech on the GPU desktop (NeMo); the model on Token Factory | `sightline/radio/` |
| Batch detection of the simulated fleet's photos: 711 photos in 483 s on 16 vCPUs, about $0.10 (2026-10-22) | the Sightline detector on OpenCV 5 `cv2.dnn` | Nebius Serverless Job (CPU, us-north1) | `deploy/nebius/run_job.sh`, `scripts/nebius_batch_detect.py` |

![Agent workflow: perception, decision, action, human approval, effect](docs/architecture/agent.png)

How the models fit together, and a real trace of one decision: [docs/architecture/agent.md](docs/architecture/agent.md). The radio desk, measured ([docs/feedback/radio.md](docs/feedback/radio.md)):

| Stage | p50 | p90 |
|---|---|---|
| Speech to text (Parakeet, RTX 4080 SUPER) | 45–130 ms per phrase | 153 ms (max) |
| Reasoning and tool calls (Nemotron 3 Super, Token Factory) | 2.3 s | 3.2 s |
| First sound heard, end to end with real voices (18 turns) | 2.5 s | 3.0 s |

6 / 6 clue reports were read back and confirmed before they were logged. Safety frame (on the desk's screen): it runs on a secondary channel under the comms operator, never initiates orders, and transmits only what the search manager approved, when the operator presses Transmit. Measured on 461 live verifier calls: p50 1.35 s and p90 1.65 s per call, about 890 tokens in and 67 out, every reply valid JSON. What worked and what didn't: [docs/feedback/nebius.md](docs/feedback/nebius.md).

Setup:

```bash
export NEBIUS_API_KEY=...                                        # from the Token Factory console; or put it in .env
export NEBIUS_BASE_URL=https://api.tokenfactory.nebius.com/v1/   # the default
# optional: SIGHTLINE_MODEL_VISION / _FAST / _REASON to change model ids
uv run python -c "from sightline.agent.llm import MODEL_FAST, token_factory_client; print(token_factory_client().chat([{'role': 'user', 'content': 'Reply with: ready'}], model=MODEL_FAST).text)"
SIGHTLINE_FAKE_LLM=1 ...                                         # run anything without a key (scripted replies)
```

The Nemotron models think before they answer, and the thinking counts against `max_tokens`; our client defaults to 2048 and can turn thinking off with `extra_body={"chat_template_kwargs": {"enable_thinking": False}}` (`NO_THINKING` in `llm.py`).

## Conditions with Tavily

Each mission's conditions come from live web search at run time (`sightline/geo/conditions.py`): three Tavily searches (forecast, weather warnings, park and trail alerts for the area) and one Tavily extract, cached per hour. Nemotron reads the pages and returns each value **with the sentence it came from**; a value is kept only if that quote is found verbatim in the page, contains the number and names the field, and is in a sane range. Everything else stays empty rather than guessed. Sunset and civil twilight are computed locally.

What it changes during a search:

- **Flying:** the planner proposes no drone leg when gusts exceed the drones' limit, it's raining, or it's after civil twilight, and the agent proposes recalling drones that are in the air.
- **The map:** fog or haze in a warning lowers the visibility factor, which lowers what each photo is worth (its POD) on the map.
- **People:** the exposure band shifts probability toward shelter; briefings to teams carry daylight left, wind and alerts.

Live, Mount Seymour on the evening of Oct 22: wind NW 20 km/h gusting 40 (quoted "NW 20", "gusts 40"), a fog advisory (visibility factor 0.6), not flyable ("after civil twilight"); the same values on two runs. Every Tavily call and every extracted value with its quote and source URL is in the mission trace (`actor="conditions"`). The full write-up, with a live run's trace: [docs/report/TAVILY.md](docs/report/TAVILY.md). The key lives on the server only (AWS Secrets Manager); `SIGHTLINE_FAKE_TAVILY=1` runs without it.

## Team and lanes

| Lane | Owns | Code |
|---|---|---|
| A · Detector | data prep, training, evaluation, metrics screen | `sightline/ml/`, `scripts/` |
| B · Geo | camera poses, footprints, pins, base map, real-GPS survey | `sightline/geo/`, `web/src/map/` |
| C · Search | probability map, simulation, Search next | `sightline/search/`, `web/src/map/heat/` |
| D · Pipeline | contract, pipeline, mission store and API, website shell, review queue, AWS | `sightline/pipeline/`, `sightline/mission/`, `sightline/api/`, `web/src/shell/`, `deploy/aws/` |
| E · Ops & Voice | front door, command view, radio desk | `web/src/front/`, `web/src/command/`, `web/src/radio/`, `sightline/radio/` |

In the live-missions sprint lane A also owns the second look and the agent (`sightline/agent/`), the Nebius Serverless Job (`deploy/nebius/`) and the reports.

The lanes meet at one contract (`docs/01_CONTRACT.md`): only the pipeline writes the cache, every cache file is validated against it, and the website only reads the cache.

## Quick start

```bash
uv sync --extra conditions                   # Python dependencies (add --extra ml on a GPU machine)
uv run pytest                                # all tests
uv run python -m sightline.pipeline sample   # regenerate the fake sample cache
cd web && pnpm install && pnpm dev           # the website (reads web/public/cache/sample)
```

## Reproduce the results

The data, weights and caches are GitHub releases, not git files:

```bash
gh release download data-v1    -R Drivera0/sightline -p heridal_test_split.zip   # unzip into data/heridal/yolo_full/
gh release download weights-v2 -R Drivera0/sightline -D data/weights/release_v2
uv sync --extra ml                                                               # torch, ultralytics, sahi (GPU)
uv run python scripts/evaluate_model.py --weights <weights-v2 .pt> --final tiled   # the detector numbers
uv run python scripts/analysis/detector_errors.py                                # the error analysis
```

`demo-cache` and `real-gps-cache` hold the two surveys the site shows; the Vercel build downloads both (`web/scripts/fetch-caches.sh`). `scripts/README.md` has the training runs and every ablation.

## Build the demo cache

```bash
uv run python -m sightline.pipeline run --stages all --layout blocks --out cache/demo
uv run python -m sightline.pipeline validate cache/demo
cd web && VITE_CACHE_DIR=demo pnpm dev
```

`run` has eight stages: frames, place, detect, georef, rank, map, metrics, export. Each stage reads
and writes `data/`, so you can run one alone (`python -m sightline.pipeline place`) or skip one
(`--skip detect` after copying `data/work/detect/` from the GPU desktop). The real-GPS survey is
built with `python -m sightline.pipeline real` (see `docs/LANE_B_GEO.md`).

If a lane's function is missing, its stage writes a labelled **placeholder** and says so in the
command output and in `manifest.json`. See `docs/LANE_INTERFACES.md` for what the pipeline calls in
lanes A, B and C.

## Mission API

```bash
uv run python -m sightline.pipeline serve --mission-root missions [--radio text]   # http://127.0.0.1:8000
cd web && VITE_API_URL=http://127.0.0.1:8000 pnpm dev                              # then "Start a new search"
SIGHTLINE_FAKE_LLM=1 SIGHTLINE_FAKE_TAVILY=1 bash scripts/smoke.sh                 # the whole loop, no network, no keys
```

The routes are in `docs/01_CONTRACT.md` §13. The API has no login: keep it on `127.0.0.1` or a trusted network
(the AWS deployment is for demos and is stopped between them). The older single-survey upload (`POST /survey`,
a zip of JPEGs → `cache/upload-<id>/`) still works.

## Docs

- `docs/00_OVERVIEW.md`: the project, lanes and timeline. Read this first.
- `docs/01_CONTRACT.md`: the exact shape of every file the lanes exchange.
- `docs/LANE_A_ML.md`, `docs/LANE_B_GEO.md`, `docs/LANE_C_SEARCH.md`, `docs/LANE_D_PIPELINE.md`: one per lane.
- `docs/DETECTOR_LIMITS.md`: where the detector fails, with figures.
- `docs/LANE_INTERFACES.md`: the functions the pipeline calls in other lanes.
- `docs/05_FRONTEND_SHARED.md`: the shared website rules and look.
- `docs/report/OPENCV_REPORT.md`: the OpenCV report (live missions, agentic vision chains, measurements).
- `docs/feedback/nebius.md`, `docs/feedback/radio.md`: what worked and what didn't with Token Factory, Serverless Jobs, Parakeet and Magpie.
- `sightline/mission/README.md`, `sightline/search/README_LIVE.md`, `sightline/geo/README.md`, `web/src/command/README.md`: the live-mission pieces, with what was checked and how.

Every number on screen comes from `metrics.json` or a cited source. Anything simulated (the flight
path, the search-map evaluation, the 10 m position uncertainty, the drone fleet, the demo mission) is labelled simulated.

## Attribution

Imagery from the HERIDAL dataset (Božić-Štulić, Marušić & Gotovac, 2019), VOC-format copy by Pyrrö (2021), CC BY 3.0.

## License

Code is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-or-later), matching Ultralytics YOLO, which the detector is trained with. The HERIDAL imagery keeps its own CC BY 3.0 license (see Attribution).
