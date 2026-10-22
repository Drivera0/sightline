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
| cuts | `captions.py --only cuts` | `cut_opencv.mp4` (≤ 5:00), `cut_nebius.mp4` (≤ 3:00), `cut_<name>.json` (every segment: source in/out, output time) |
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
| `fleet` | **guarded**: approve a drone re-task proposal on the console | 12 s |
| `trace` | **guarded**: `#m/demo/trace`, scroll the trace | 14 s |
| `feed` | `#m/demo/feed`, scroll | 8 s |

Guarded shots look for their screen first and are skipped, with the reason in `shots.json`, when it isn't there: `fleet` needs a pending proposal mentioning a re-task on the demo console, `trace` needs a "Trace" button in the mission's view tabs. Both are written for the fleet and Trace work in flight, so the same script picks them up once those merge.

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

`--serve-local` runs `python -m sightline.pipeline serve --radio text` with the agent and Tavily faked (`SIGHTLINE_FAKE_LLM=1`, `SIGHTLINE_FAKE_TAVILY=1`), its missions under `<run>/api/`, the cv2 detector from `web/public/models/sightline-detector-v2.onnx`. Tested here: 12 photos processed (about 3 s each), 4 candidates with verdicts, the live heat on the console, the radio desk. Without the `conditions` extra the server logs that it can't fetch conditions (`astral` missing); `run.sh` passes `--extra conditions`. Never point it at AWS for a rehearsal: start AWS only for the real recording (and run `scripts/remote_check.py` first).

## Captions and cuts (`captions.py`, `captions.yaml`)

`captions.yaml` holds the burned-in labels: one short step name per shot ("3 · A person answers each candidate"), not narration. Numbers are counted over the shots that actually ran, so a skipped shot leaves no gap. A label never calls an area done (`captions.py` refuses one that does); a searched sector is "searched at POD x". The style is libass `force_style` (Inter, small, dark box, bottom centre).

The cuts are made from `master_captioned.mp4`, silent, with 12 s of black at the start and 10 s at the end for the on-camera clips:

- **OpenCV (≤ 5:00)**: front → survey → live upload/photos → rank → review → live review → search → trace → approvals → fleet → console → clue → live console → radio → feed, then black slots for the architecture (35 s), numbers (35 s) and limits (20 s) slides.
- **Nebius (≤ 3:00)**: front and upload at 2× → detection (rank, review, live photos and review) → re-look (trace) → re-task (clue, fleet, approvals) → card/radio (console, radio) → black slots for Tavily (15 s), architecture (15 s) and limits (10 s).

A shot that didn't run is left out. When the shots don't fit, each is trimmed from its tail by the same factor (`"trimmed"` in `cut_<name>.json`). Edit the `cuts:` section to reorder, change a speed or resize a slot.

The GIF takes the first candidate shot (`gif.candidates`, in order of preference) with enough movement in its window, ends it on the frame within 20 ± 2 s closest to its first frame, and fades the last half second back into the first frame so the loop has no jump. Larger than 10 MB, it retries at lower fps and width.

## Last run (demo-only, this machine, 2026-10-22)

`runs/video/20261022-015735/`: 126.8 s master; shot times from the sync mark:

| Shot | Start | End | Length | Target |
|---|---|---|---|---|
| front | 0.9 | 7.2 | 6.3 | 7 |
| survey | 8.2 | 15.3 | 7.1 | 9 |
| rank | 16.4 | 32.5 | 16.1 | 12 |
| review | 33.2 | 47.0 | 13.8 | 14 |
| search | 47.5 | 59.9 | 12.4 | 12 |
| operate | 61.4 | 68.8 | 7.4 | 7 |
| console | 69.1 | 79.2 | 10.1 | 12 |
| approvals | 79.8 | 94.4 | 14.6 | 14 |
| clue | 95.0 | 114.2 | 19.2 | 18 |
| fleet | skipped: no re-task proposal on the demo console yet | | | 12 |
| trace | skipped: no Trace tab on the demo mission yet | | | 14 |
| feed | 115.5 | 123.5 | 8.0 | 8 |

Cuts: OpenCV 3:40 (9 shots, nothing trimmed), Nebius 2:19 (6 shots). GIF: 5.7 MB, 21.9 s from `review`. Wall time: about 2.5 min to record, about 5 min for the encodes. A live run with `--serve-local` added the five live shots (about 70 s), none skipped.
