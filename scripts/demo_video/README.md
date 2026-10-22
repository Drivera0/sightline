# Demo video pipeline

One command records the whole demo flow as a 1080p master, burns in short step labels, cuts the OpenCV (≤ 5:00) and Nebius (≤ 3:00) videos from it, and makes the 20-s README GIF. The shot lists follow WIN_RESEARCH §8. Re-run it after the redesign lands: the selectors are roles and labels, and a shot whose screen isn't there yet is skipped, not failed.

```bash
uv sync --extra video                 # playwright==1.64.0 + pyyaml (not in the default deps)
uv run --extra video playwright install chromium   # once per machine
bash scripts/demo_video/run.sh        # -> runs/video/<timestamp>/
```

Needs `web/node_modules` (`pnpm install` in `web/`), the demo cache in `web/public/cache/demo` (README, "The demo cache"), and `ffmpeg` with libass. In a git worktree, link the main checkout's cache: `ln -s <main>/web/public/cache/demo web/public/cache/demo`.

## What runs

| Step | Script | Output in the run folder |
|---|---|---|
| record | `record.py` | `master.webm` (Playwright `recordVideo`, 1920×1080), `shots.json`, `snaps/NN_<shot>.png` (last frame of each shot) |
| captions | `captions.py --only srt,mp4,burn` | `captions.srt`, `master.mp4` (H.264, CRF 18, 30 fps), `master_captioned.mp4` |
| cuts | `captions.py --only cuts` | `cut_opencv.mp4` (≤ 5:00), `cut_nebius.mp4` (≤ 3:00), `cut_<name>.srt` (the cut's own labels), `cut_<name>.json` (every segment: source in/out, output time) |
| gif | `captions.py --only gif` | `demo.gif` (fps 10, 800 px, one palette, < 10 MB, loops), `gif.json` |

`run.sh` runs them in that order. It is idempotent: a run folder with `master.webm` and `shots.json` is not recorded again (`--out <folder>` to finish or redo one), and each later step is skipped while its output is newer than its inputs (`FORCE=1` redoes them). `--publish` also copies the GIF to `docs/report/figures/demo.gif` if it is under 10 MB; without it nothing outside `runs/` (gitignored) is written. Other flags go to `record.py`.

## Recording (`record.py`)

Builds the site with `VITE_CACHE_DIR=demo` into the run folder, serves it with `vite preview` on port 5202 (`--server dev` for the dev server), and stops it by PID at the end (it never kills a process it didn't start; if 5202 is taken it stops and says so). Chromium then plays these shots, each a named step with a target length from the §8 outline (an action that finishes early holds its last frame up to the target):

| Shot | What happens | Target |
|---|---|---|
| `front` | front door, "Watch a demo search" | 7 s |
| `survey` | the survey intro, pointer over the photos | 9 s |
| `rank` | "Start: rank 500 photos", the scan plays | 12 s |
| `review` | "Start review", three candidates answered with P, N, P | 14 s |
| `search` | Search next, the flight replay plays | 12 s |
| `operate` | the guided demo's Command step | 7 s |
| `console` | `#m/demo/command`: hover task cards, select a team | 12 s |
| `approvals` | Approvals tab, expand a proposal's reason, Approve, open Decided | 14 s |
| `clue` | back on the console, + Add clue, type it, Pick on map, click the map, Add | 18 s |
| `fleet` | **guarded**: approve a pending drone re-task card on the console; with none (the demo fixture's re-task is already approved), zoom out and pan to the simulated fleet and Drone 1's re-tasked route, point at its legend key | 12 s |
| `trace` | **guarded**: `#m/demo/trace`, scroll the trace | 14 s |
| `feed` | `#m/demo/feed`, scroll | 8 s |

Guarded shots look for their screen first and are skipped, with the reason in `shots.json`, when it isn't there: `fleet` needs a pending re-task card or the simulated fleet on the console's map (its "Drones (simulated)" map description and the "Re-tasked" legend key), `trace` needs a "Trace" button in the mission's view tabs.

Determinism: fixed 1920×1080 viewport and video at scale 1, dark scheme, `prefers-reduced-motion: no-preference`, time zone America/Vancouver, locale en-US, and the page clock started at the demo mission fixture's `now` (2026-10-24T22:00Z; `--no-clock` turns it off). Eased mouse moves take a fixed wall time however slow the renderer is, with pauses between actions. Headless Chromium records no cursor, so the recorder draws one (and a ring on each click) on top of the page; the site is untouched.

**Shot times are read off the video.** Under load the recording's clock drifts from wall time (10–15 % on this machine), so wall-clock timestamps don't line up with the video. The recorder shows a 12-px mark near the bottom-right corner, magenta or green during a shot and black between shots, reads it back from `master.webm` after recording and writes those video times into `shots.json` (`"sync": "mark"`; the wall times are kept under `extra`). `captions.py` paints the mark out (`delogo`) when it makes `master.mp4`. If the mark can't be read, the wall times are scaled to the video's length and `"sync"` says `"scaled"`.

`shots.json`:

```json
{"video": "master.webm", "total_s": 122.7, "sync": "mark", "page_clock": "2026-10-24T22:00:00Z",
 "shots": [{"id": "review", "target_s": 14, "start_s": 32.4, "end_s": 46.1, "status": "ok", "note": "", "mode": "demo"},
           {"id": "trace", "status": "skipped", "note": "no Trace tab on the demo mission yet (#m/demo/trace not merged)", ...}]}
```

### Live flow

```bash
bash scripts/demo_video/run.sh --live --serve-local                  # a local API started (and stopped) for the run
bash scripts/demo_video/run.sh --live --api http://127.0.0.1:8000    # an API you started
bash scripts/demo_video/run.sh --live --api <url> --mission <id>     # resume that mission instead of a new one
```

After the demo shots, `--live` records a live mission: `live_upload` (the Photos tab with the watch command), `live_photos` (the counters ticking while `python -m sightline.client replay` sends real-GPS HERIDAL **val** photos at drone pace in a subprocess: `--replay-limit 12 --replay-pace 2`), `live_review` (candidates with their second-look verdicts), `live_console` (the console on the live map) and `live_radio` (the radio desk). The site is built with `VITE_API_URL` set to the API. If the API doesn't answer `/health`, those shots are skipped and `shots.json` says why. The page clock isn't pinned in live mode, since a live mission's events carry real times.

Then `recall` (25 s, **guarded**: it runs only when the API has `POST /missions/{id}/conditions/override` in its `/openapi.json` and the HERIDAL val photos are there for the fleet sim): off camera, a fresh mission gets the creek scenario's three simulated drones in the air (`scripts/recall_demo.py`'s steps, a calm demo override first if the real conditions say no flying); on camera, the console's **Fleet controls** set gusts of 50 km/h (a demo override, labelled so on screen), the agent's recall cards arrive quoting the fact and the DJI Mavic 3E's 43 km/h limit, each is approved, and the drones turn home on the map. `shots.json` keeps the mission id and the fleet's last lines under the shot's `extra`.

`--serve-local` runs `python -m sightline.pipeline serve --radio text` with the agent and Tavily faked (`SIGHTLINE_FAKE_LLM=1`, `SIGHTLINE_FAKE_TAVILY=1`), its missions under `<run>/api/`, the cv2 detector from `web/public/models/sightline-detector-v2.onnx`. Tested here: 12 photos processed (about 3 s each), 4 candidates with verdicts, the live heat on the console, the radio desk. Without the `conditions` extra the server logs that it can't fetch conditions (`astral` missing); `run.sh` passes `--extra conditions`. Never point it at AWS for a rehearsal: start AWS only for the real recording (and run `scripts/remote_check.py` first).

## Captions and cuts (`captions.py`, `captions.yaml`)

`captions.yaml` holds the burned-in labels: one short step name per shot ("3 · A person answers each candidate"), not narration. Numbers are counted over the shots that actually ran, so a skipped shot leaves no gap. A label never calls an area done (`captions.py` refuses one that does); a searched sector is "searched at POD x". The style is libass `force_style` (Inter, small, dark box, bottom centre).

The cuts are made from `master.mp4` with their own labels burned in (`cut_<name>.srt`: numbered in the cut's order and timed to its sped-up segments, so a step number never runs backwards), silent, with 12 s of black at the start and 10 s at the end for the on-camera clips:

- **OpenCV (≤ 5:00)**: front → survey → live upload/photos → rank → review → live review → search → trace → approvals → fleet → console → clue → live console → radio → feed, then black slots for the architecture (35 s), numbers (35 s) and limits (20 s) slides.
- **Nebius (≤ 3:00)**: front, upload, rank and live photos at 2×, the rest at 1.5× (trace at 1×, the recall at 1.25×) → detection (rank, review, live photos and review) → re-look (trace) → re-task (clue, fleet, approvals) → card/radio (console, radio) → the recall (gusts → no-fly → recall, live) → black slots for Tavily (15 s), architecture (15 s) and limits (10 s).

A shot that didn't run is left out. When the shots don't fit, each is trimmed from its tail by the same factor (`"trimmed"` in `cut_<name>.json`). Edit the `cuts:` section to reorder, change a speed or resize a slot.

The GIF takes the first candidate shot (`gif.candidates`, in order of preference) with enough movement in its window (a candidate's own `min_motion` overrides the default), ends it on the frame within 20 ± 2 s closest to its first frame, and fades its first half second in over its end, playing on from the frame after: the last frame is the frame before the first, so the loop has no jump. `end_aligned: true` takes the window that ends with the shot: `fleet` (the first choice) is 12 s, so its 20 s start on the same console while the clue lands, and never run into the Trace page. Larger than 10 MB, it retries at lower fps and width.

## Last run (live, `--serve-local`, this machine, 2026-10-22)

`runs/video/20261022-030506/`: 259.2 s master; shot times from the sync mark, nothing skipped:

| Shot | Start | End | Length | Target |
|---|---|---|---|---|
| front | 0.6 | 7.1 | 6.5 | 7 |
| survey | 7.7 | 14.7 | 7.0 | 9 |
| rank | 15.3 | 31.2 | 15.9 | 12 |
| review | 31.6 | 45.2 | 13.6 | 14 |
| search | 45.6 | 57.6 | 12.1 | 12 |
| operate | 58.3 | 64.5 | 6.2 | 7 |
| console | 64.5 | 75.8 | 11.3 | 12 |
| approvals | 76.2 | 90.2 | 14.1 | 14 |
| clue | 90.6 | 109.3 | 18.7 | 18 |
| fleet | 109.8 | 122.3 | 12.6 | 12 |
| trace | 123.8 | 137.4 | 13.7 | 14 |
| feed | 137.8 | 145.8 | 8.0 | 8 |
| live_upload | 147.2 | 157.4 | 10.1 | 12 |
| live_photos | 157.8 | 176.6 | 18.8 | 20 |
| live_review | 176.6 | 192.2 | 15.6 | 16 |
| live_console | 192.6 | 204.6 | 12.1 | 14 |
| live_radio | 205.0 | 215.0 | 10.0 | 10 |
| recall | 224.8 | 256.3 | 31.5 | 25 |

Cuts: OpenCV 4:59.5 (16 shots, each trimmed to 0.937 of its length), Nebius 2:59.5 (13 shots, trimmed to 0.915 after the speed-ups). GIF: 2.4 MB, 18.0 s from `fleet` (the console: the clue lands, then the fleet with Drone 1 re-tasked). The demo-only run (`runs/video/20261022-030114/`) has the same 12 demo shots, none skipped. Wall time: about 4.5 min to record the live run, about 2 min for the encodes.
