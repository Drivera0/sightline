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
| `call` | `#`: the console at t0 with the pitch bar (one centred line and the button); pointer over the line and the LKP; click **Follow the search** | 10 s |
| `photos` | t1: the clock runs over the survey flight (6 s), photos land and the heat fills; the counter, then the photo tiles | 13 s |
| `confirm` | t2: **Next**; the three cards; the 0.18 recorded card's chips (OpenCV 5 zoom native, Nemotron-3.5-Super-VL); **Show the second look's images**; **Person** on it and on #1 (f0336-d01), whose sighting lands in the clue log and on the map | 20 s |
| `trace` | **Trace** in the view switch: the f0001-d01 chain, pointer down its steps (note → tool → model → verdict → proposal → approval), the model call opened | 17 s |
| `next` | `#m/demo?t=3`: the coach mark on p001; the reason, then **Approve** | 9 s |
| `run` | the approval runs the clock to t4 (3.5 s): teams out, drones fly, B4 searched at POD 60 % in the task board, Drone 1's tooltip | 12 s |
| `conditions` | Esc (the story steps aside, the console stays at t4), **Sources and quotes** (W): wind, gusts, the pages read | 13 s |
| `fleet` | zoom on the simulated fleet at t4: Drone 2 link lost, Drone 3 degraded, Team Two relayed through D1 (each marker's tooltip) | 15 s |
| `radio` | **Open Radio** under the approvals (else **Radio** in the view switch, key 6): the Radio view; play the recorded Magpie briefing, open its transcript | 11 s |
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

## Narration (`narrate.py`, `narration.yaml`)

Voices both cuts with NVIDIA Magpie TTS, the radio desk's model and speaker (`sightline/radio/tts.py`), and checks them by ear with Parakeet, the radio desk's ASR. It runs in the NeMo environment (`docs/feedback/radio.md`, "How to reproduce"), after `run.sh` has made the cuts:

```bash
~/radio-env/bin/python scripts/demo_video/narrate.py runs/video/<timestamp>   # -> runs/video/<timestamp>/narrated/
~/radio-env/bin/python scripts/demo_video/narrate.py runs/video/<timestamp> --dry-run   # no NeMo: tones sized at 150 wpm
```

`narration.yaml` holds one line per shot (keyed by the shot ids in `shots.json`, or `slot: <name>` for the OpenCV cut's three slides and the Nebius architecture slot), at most two sentences, sized at 150 words a minute, numbers as words, every model by name and everything simulated said so; the "what breaks first" lines are read word for word (`verbatim`). The on-camera open and close stay silent. `respell` is what Magpie is given for names it says wrong ("OpenCV 5" came out as "OpenZvy"; "Open CV five" is heard right).

For each line Magpie speaks each sentence (250 ms apart), up to `takes` samples, and keeps the one Parakeet hears best; a line over its shot by more than 0.5 s loses its second sentence and is listed in a warning to rewrite. The lines start 250 ms into their shots (never on top of the line before), the track is normalised to −16 LUFS (ffmpeg `loudnorm`, two passes) and muxed as AAC into `cut_<name>_narrated.mp4`, with "Narration: NVIDIA Magpie TTS" burned in over the first narrated shot just above its step label (one re-encode, CRF 18 as `captions.py`; `--no-credit` copies the video stream). Also `narration_<name>.srt` (the spoken lines), `clips/`, and `narration_report.md` / `narration.json`: per line the text, seconds available and used, and the listen-check, Parakeet on each line cut back out of the finished mp4's audio, as word error rate with numbers spelled out on both sides (the script says "sixty percent", Parakeet writes "60%").

## Last run (live, `--serve-local`, this machine, 2026-10-22, after #177)

`runs/video/final4-20261022-122829/`: 236.6 s master; shot times from the sync mark, nothing skipped or failed:

| Shot | Start | End | Length | Target |
|---|---|---|---|---|
| call | 1.1 | 11.1 | 10.0 | 10 |
| photos | 12.0 | 24.8 | 12.9 | 13 |
| confirm | 25.6 | 46.6 | 21.0 | 20 |
| trace | 47.3 | 65.1 | 17.8 | 17 |
| next | 65.8 | 75.0 | 9.1 | 9 |
| run | 75.8 | 87.3 | 11.4 | 12 |
| conditions | 88.1 | 101.2 | 13.0 | 13 |
| fleet | 102.0 | 117.8 | 15.8 | 15 |
| radio | 118.7 | 132.3 | 13.6 | 11 |
| results | 133.2 | 144.6 | 11.4 | 10 |
| breaks | 145.1 | 169.2 | 24.2 | 20 |
| live_link | 179.8 | 199.0 | 19.3 | 18 |
| recall | 200.4 | 233.6 | 33.2 | 32 |

Cuts: OpenCV 3:52.8 (9 shots), Nebius 2:41.1 (8 shots), none trimmed. GIF: 2.63 MB, 15.7 s at 10 fps, 800 px, from `run` (the t3 proposal approved, the clock runs on, teams out, the drones fly, B4 searched at POD 60 %). Wall time: about 4 min to record, about 3 min for the encodes.
