# Demo video pipeline

One command records the whole demo flow as a 1080p master, burns in short step labels, cuts the OpenCV (≤ 5:00) and Nebius (≤ 3:00) videos from it, and makes the README GIF (≤ 20 s, ≤ 3 MB). The shot lists follow WIN_RESEARCH §8, on the one console of PR #171: the landing at t0, the mission-time story's coach marks t1–t5, the Trace, Conditions, the simulated fleet, the radio desk and the Debrief. The selectors are roles and labels, and a shot whose element isn't there is skipped (or failed) with the reason in `shots.json`.

```bash
uv sync --extra video                 # playwright==1.64.0 + pyyaml (not in the default deps)
uv run --extra video playwright install chromium   # once per machine
bash scripts/demo_video/run.sh --live --serve-local --publish   # -> runs/video/<timestamp>/ (+ docs/report/figures/demo.gif)
```

Needs `web/node_modules` (`pnpm install` in `web/`), the demo cache in `web/public/cache/demo` (README, "The demo cache"), and `ffmpeg` with libass. In a git worktree, link the main checkout's cache: `ln -s <main>/web/public/cache/demo web/public/cache/demo`.

## What runs

| Step | Script | Output in the run folder |
|---|---|---|
| record | `record.py` | `master.webm` (Playwright `recordVideo`, 1920×1080), `shots.json`, `snaps/NN_<shot>.png` (last frame of each shot) |
| captions | `captions.py --only srt,mp4,burn` | `captions.srt`, `master.mp4` (H.264, CRF 18, 30 fps), `master_captioned.mp4` |
| cuts | `captions.py --only cuts` | `cut_opencv.mp4` (≤ 5:00), `cut_nebius.mp4` (≤ 3:00), `cut_<name>.srt` (the cut's own labels), `cut_<name>.json` (every segment: source in/out, output time) |
| gif | `captions.py --only gif` | `demo.gif` (fps 10, 800 px, one palette, ≤ 3 MB, ≤ 20 s, loops), `gif.json` |

`run.sh` runs them in that order. It is idempotent: a run folder with `master.webm` and `shots.json` is not recorded again (`--out <folder>` to finish or redo one), and each later step is skipped while its output is newer than its inputs (`FORCE=1` redoes them). `--publish` also copies the GIF to `docs/report/figures/demo.gif` if it is at most 3 MB; without it nothing outside `runs/` (gitignored) is written. Other flags go to `record.py`.

## Recording (`record.py`)

Builds the site with `VITE_CACHE_DIR=demo` into the run folder, serves it with `vite preview` on port 5202 (`--server dev` for the dev server), and stops it by PID at the end (it never kills a process it didn't start; if 5202 is taken it stops and says so). Chromium then plays these shots, each a named step with a target length (an action that finishes early holds its last frame up to the target), with 400 ms of settle before each:

| Shot | What happens | Target |
|---|---|---|
| `call` | `#`: the console at t0 with the pitch bar; pointer over the pitch line and the LKP; click **Follow the search** | 10 s |
| `photos` | t1: the clock runs over the survey flight (6 s), photos land and the heat fills; the counter, then the photo tiles | 13 s |
| `confirm` | t2: **Next**; the three cards; the 0.18 recorded card's chips (OpenCV 5 zoom native, Nemotron-3.5-Super-VL); **Show the second look's images**; **Person** on it and on #1 (f0336-d01), whose sighting lands in the clue log and on the map | 20 s |
| `trace` | **Trace** in the view switch: the f0001-d01 chain, pointer down its steps (note → tool → model → verdict → proposal → approval), the model call opened | 17 s |
| `next` | `#m/demo?t=3`: the coach mark on p001; the reason, then **Approve** | 9 s |
| `run` | the approval runs the clock to t4 (3.5 s): teams out, drones fly, B4 searched at POD 60 % in the task board, Drone 1's tooltip | 12 s |
| `conditions` | Esc (the story steps aside, the console stays at t4), **Sources and quotes** (W): wind, gusts, the pages read | 13 s |
| `fleet` | zoom on the simulated fleet at t4: Drone 2 link lost, Drone 3 degraded, Team Two relayed through D1 (each marker's tooltip) | 15 s |
| `radio` | the rail's **Radio desk**: play the recorded Magpie briefing, open its transcript | 11 s |
| `results` | `#m/demo?t=5`: the Debrief beside the map; pointer over the three numbers | 10 s |
| `breaks` | scroll the Debrief to "What breaks first", the three lines one by one (on screen about 15 s) | 20 s |
| `live_link` | **live**: Fleet controls' **Degrade link D2** (the ring turns), Team Two loses its signal, a drone relays it (the dashed relay line) | 18 s |
| `recall` | **live**: **Set gusts 50 km/h (demo override)**, "Not flyable" with the Demo override chip, the recall cards quoting the gusts and the 43 km/h limit, each approved, the drones turn home | 32 s |

None of the demo shots needs an API: the demo mission is fixtures plus the demo cache, and it already holds the degraded links and Team Two's relay (`fleet`). The two live shots need one (below).

Determinism: fixed 1920×1080 viewport and video at scale 1, dark scheme, `prefers-reduced-motion: no-preference`, time zone America/Vancouver, locale en-US, and the page clock started at the demo mission fixture's `now` (2026-10-24T22:00Z; `--no-clock` turns it off; not pinned with `--live`, whose mission carries real times). Eased mouse moves take a fixed wall time however slow the renderer is, with pauses between actions; every on-camera action is a click. Headless Chromium records no cursor, so the recorder draws one (and a ring on each click) on top of the page; the site is untouched.

**Shot times are read off the video.** Under load the recording's clock drifts from wall time (10–15 % on this machine), so wall-clock timestamps don't line up with the video. The recorder shows a 12-px mark near the bottom-right corner, magenta or green during a shot and black between shots, reads it back from `master.webm` after recording and writes those video times into `shots.json` (`"sync": "mark"`; the wall times are kept under `extra`). `captions.py` paints the mark out (`delogo`) when it makes `master.mp4`. If the mark can't be read, the wall times are scaled to the video's length and `"sync"` says `"scaled"`.

`shots.json`:

```json
{"video": "master.webm", "total_s": 238.6, "sync": "mark", "page_clock": null,
 "shots": [{"id": "confirm", "target_s": 20, "start_s": 26.0, "end_s": 47.0, "status": "ok", "note": "", "mode": "demo"},
           {"id": "recall", "status": "skipped", "note": "http://127.0.0.1:8000 is unreachable (...)", ...}]}
```

### Live flow

```bash
bash scripts/demo_video/run.sh --live --serve-local                  # a local API started (and stopped) for the run
bash scripts/demo_video/run.sh --live --api http://127.0.0.1:8000    # an API you started
bash scripts/demo_video/run.sh --live --api <url> --mission <id>     # put the fleet on that mission instead of a new one
```

After the demo shots, `--live` sets up a fresh mission off camera with the creek scenario's three simulated drones in the air (`scripts/recall_demo.py`'s steps: conditions, a calm demo override first if the real ones say no flying, the fleet and Team Two join, a scripted manager approves the opening legs) and records `live_link` and `recall` on it. Both are **guarded**: they run only when the API answers `/health`, has `POST /missions/{id}/conditions/override` in its `/openapi.json`, and the HERIDAL **val** photos are there for the fleet sim; otherwise they are skipped with the reason. The site is built with `VITE_API_URL` set to the API, so the live console shows its Fleet controls.

`recall_demo`'s sim runs in one loop without the event stream, so the recorder hands the console's link request to it (`sim.set_link`, as the per-process fleet's feed would) and gives Team Two the scenario's own `no_signal` early; the sim reports both back (`POST /fleet/link`, `/fleet/relay`) and the map shows them. `shots.json` keeps the mission id, the number of relays and the fleet's last lines under the shots' `extra`.

`--serve-local` runs `python -m sightline.pipeline serve --radio text` with the agent and Tavily faked (`SIGHTLINE_FAKE_LLM=1`, `SIGHTLINE_FAKE_TAVILY=1`), its missions under `<run>/api/`, the cv2 detector from `web/public/models/sightline-detector-v2.onnx`. With the fake Tavily the live mission's conditions start as "flyability unknown"; the gusts override is what says no flying. `run.sh` passes `--extra conditions`. Never point it at AWS for a rehearsal: start AWS only for the real recording (and run `scripts/remote_check.py` first).

## Captions and cuts (`captions.py`, `captions.yaml`)

`captions.yaml` holds the burned-in labels: one short step name per shot, at most two lines, not narration. Numbers are counted over the shots that actually ran, so a skipped shot leaves no gap. A label never calls an area done (`captions.py` refuses one that does); a searched sector is "searched at POD x"; anything simulated or recorded says so. The style is libass `force_style` (Inter, small, dark box, bottom centre).

The cuts are made from `master.mp4` with their own labels burned in (`cut_<name>.srt`: numbered in the cut's order and timed to its sped-up segments, so a step number never runs backwards; a segment's `label` replaces the shot's for that cut), silent, with black at the start and end for the on-camera clips:

- **OpenCV (≤ 5:00)**: [black 12 s] → call → photos → confirm → trace → next → run → conditions → results → breaks → black slots for the evidence index (30 s), reproduce in 5 min (30 s) and limits (20 s) slides → [black 10 s].
- **Nebius (≤ 3:00)**: [black 10 s] → call at 2× → confirm at 1.5× (labelled "Nemotron 3.5 Super VL on Nebius Token Factory") → run at 1.5× → fleet → live_link → recall at 1.25× → radio → breaks → a 15 s architecture slot → [black 10 s].

A shot that didn't run is left out. When the shots don't fit, each is trimmed from its tail by the same factor, except that none goes below its `min_s` (`breaks` keeps 12 s, so the three lines stay up at least 6 s); `"trimmed"` in `cut_<name>.json` says by how much. Edit the `cuts:` section to reorder, change a speed or resize a slot.

The GIF takes the first candidate shot (`gif.candidates`, in order of preference) with enough movement in its window (a candidate's own `min_motion` overrides the default), ends it on the frame within 18 ± 2 s closest to its first frame (never over 20 s), and fades its first half second in over its end, playing on from the frame after: the last frame is the frame before the first, so the loop has no jump. `end_aligned: true` takes the window that ends with the shot: `run` (the first choice) is 12 s, so its window starts at t3 on the proposal, then the approval and the run. Larger than 3 MB, it retries at lower fps and width.

## Last run (live, `--serve-local`, this machine, 2026-10-22, after #173)

`runs/video/20261022-114907/`: 238.6 s master; shot times from the sync mark, nothing skipped or failed:

| Shot | Start | End | Length | Target |
|---|---|---|---|---|
| call | 1.6 | 11.5 | 9.9 | 10 |
| photos | 12.4 | 25.3 | 12.9 | 13 |
| confirm | 26.0 | 47.0 | 20.9 | 20 |
| trace | 47.7 | 65.6 | 17.9 | 17 |
| next | 66.3 | 75.4 | 9.1 | 9 |
| run | 76.2 | 88.3 | 12.0 | 12 |
| conditions | 89.1 | 103.5 | 14.4 | 13 |
| fleet | 104.4 | 120.6 | 16.3 | 15 |
| radio | 121.5 | 133.8 | 12.3 | 11 |
| results | 134.6 | 146.2 | 11.6 | 10 |
| breaks | 147.0 | 170.4 | 23.4 | 20 |
| live_link | 181.1 | 200.7 | 19.6 | 18 |
| recall | 201.8 | 235.8 | 34.0 | 32 |

Cuts: OpenCV 3:54.2 (9 shots, none trimmed: 2:12 of screen, 1:20 of slide slots, 22 s of black for the camera), Nebius 2:40.7 (8 shots, none trimmed). GIF: 2.16 MB, 16.0 s at 10 fps, 800 px, from `run` (Team One approved for A1, the clock runs on, teams out, the drones fly, B4 searched at POD 60 %). Live: Team Two relayed twice through D2, all three drones recalled and home. Wall time: about 4 min to record, about 2 min for the encodes.
