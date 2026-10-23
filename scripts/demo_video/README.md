# Demo video pipeline

One command records the whole demo flow as a 4K master (the 1920×1080 viewport at device scale 2, captured frame by frame), renders the camera moves and speed-ups from it down to a 1080p program, burns in short step labels, cuts the OpenCV (≤ 5:00) and Nebius (≤ 3:00) videos from it, and makes the README GIF (≤ 16 s, ≤ 3 MB). The shot lists follow WIN_RESEARCH §8, on the one console of PR #171: the landing at t0, the mission-time story's coach marks t1–t5, the Trace, Conditions, the simulated fleet, the radio desk and the Debrief. The selectors are roles and labels, and a shot whose element isn't there is skipped (or failed) with the reason in `shots.json`.

```bash
uv sync --extra video                 # playwright==1.64.0 + pyyaml (not in the default deps)
uv run --extra video playwright install chromium   # once per machine
bash scripts/demo_video/run.sh --live --serve-local --publish   # -> runs/video/<timestamp>/ (+ docs/report/figures/demo.gif)
```

Needs `web/node_modules` (`pnpm install` in `web/`), the demo cache in `web/public/cache/demo` (README, "The demo cache"), and `ffmpeg` with libass. In a git worktree, link the main checkout's cache: `ln -s <main>/web/public/cache/demo web/public/cache/demo`.

## What runs

| Step | Script | Output in the run folder |
|---|---|---|
| record | `record.py` (+ `capture.py`) | `master_4k.mp4` (3840×2160, H.264 CRF 16, BT.709, 60 or 30 fps), `shots.json`, `frame_times.json`, `snaps/NN_<shot>.png` (last frame of each shot) |
| program, captions | `captions.py --only mp4,srt,burn` (+ `moves.py`) | `master.mp4` (1920×1080 program: moves and speed-ups, uncaptioned), `captions.srt`, `master_captioned.mp4` (export profile) |
| cuts | `captions.py --only cuts` | `cut_opencv.mp4` (≤ 5:00), `cut_nebius.mp4` (≤ 3:00), `cut_<name>.srt` (the cut's own labels), `cut_<name>.json` (every segment: source in/out, output time) |
| gif | `captions.py --only gif` | `demo.gif` (12 fps, 960 px, one palette, ≤ 3 MB, ≤ 16 s, loops), `gif.json` |

`run.sh` runs them in that order (`--1440` adds `master_1440p.mp4` and `master_1440p_captioned.mp4` for the upload). It is idempotent: a run folder whose `shots.json` names a recording that is there is not recorded again (`--out <folder>` to finish or redo one), and each later step is skipped while its output is newer than its inputs (`FORCE=1` redoes them). `--publish` also copies the GIF to `docs/report/figures/demo.gif` if it is at most 3 MB; without it nothing outside `runs/` (gitignored) is written. Other flags go to `record.py`.

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

Determinism: fixed 1920×1080 viewport at device scale 2, dark scheme, `prefers-reduced-motion: no-preference`, time zone America/Vancouver, locale en-US, and the page clock started at the demo mission fixture's `now` (2026-10-24T22:00Z; `--no-clock` turns it off; not pinned with `--live`, whose mission carries real times). Mouse moves follow a slightly bowed cubic Bézier, eased in and out (cubic), and take a fixed wall time however slow the renderer is; every on-camera action is a click, with 300 ms of settle before and after it. Headless Chromium records no cursor, so the recorder draws one (an SVG arrow, and a ring on each click that eases out) on top of the page; both are vectors, so they are as sharp as the text at 2×. The site is untouched. Each click's place goes into its shot's `extra.clicks` (`push_in: {focus: click}` uses it).

`--shots call,photos` records just those shots; `--landing '/#m/demo?t=0'` opens the call there instead of `/`.

### Capture

Playwright's `recordVideo` encodes VP8 at a fixed ~1 Mbit/s and scales the viewport to fit 800×800 ([microsoft/playwright#31424](https://github.com/microsoft/playwright/issues/31424)); that was the soft, smeared look of the earlier runs. `record.py` no longer uses it. `capture.py` starts `page.screencast` (CDP `Page.startScreencast`) with JPEG frames at quality 95 and the frame size of the device pixels. Chromium is launched with `--force-device-scale-factor=2`; with the context's scale alone the screencast sends the 1920×1080 viewport, not 3840×2160. A writer thread puts each frame on disk with Chromium's own timestamp. After the recording, ffmpeg turns them into a constant-frame-rate master: the concat demuxer holds each frame until the next, then H.264 High at CRF 16, yuv420p, converted from the JPEGs' full-range BT.601 to BT.709 and tagged so. Encoding after the recording leaves every core to the renderer.

Chromium sends a frame only when the page changes, so the rate that matters is the rate while something moves. `record.py` prints it, as one over the median gap between frames less than 0.25 s apart, and keeps it in `shots.json` under `capture` with every frame's time in `frame_times.json`. `--fps auto` (the default) makes the master 60 fps when that rate is at least 45, else 30. Here Chromium has no GPU (WSL2: SwiftShader, llvmpipe), and the screencast's readback of a 4K surface is the limit. A probe that repaints every animation frame measured about 60 fps at scale 1, 40 at 1.33, 29 at 1.5 and 14 to 20 at 2. On the console itself it measured 15 to 20 fps at scale 2 (Node and Python clients alike), so the 4K master comes out at 30 fps. `--scale 1.5` (2880×1620, about 30 fps) or `--scale 1` (60 fps, no supersampling) trade sharpness for motion; a machine with a GPU should reach 60 at 2. The director waits with `page.wait_for_timeout`, never `time.sleep`, because the sync Playwright client only delivers (and acks) frames inside its own calls.

**Shot times are read off the video.** The recorder shows a 12 px mark near the bottom-right corner, magenta or green during a shot and black between shots. It reads the mark back from the master after recording (at the master's scale; a white frame before the first paint is not a shot) and writes those video times into `shots.json` (`"sync": "mark"`; the wall times are kept under `extra`). `captions.py` paints the mark out (`delogo`, scaled to the master) when it renders the program. If the mark can't be read, the shots' wall-clock times are placed against the frames' own capture times (`"clock"`), else the wall times are scaled to the video's length (`"scaled"`).

`shots.json`:

```json
{"video": "master_4k.mp4", "size": [3840, 2160], "scale": 2.0, "fps": 30, "total_s": 238.6, "sync": "mark",
 "capture": {"frames": 3100, "moving_fps": 18.0, "moving_p90_fps": 20.0, ...}, "page_clock": null,
 "program": {"video": "master.mp4", "size": [1920, 1080], "fps": 30, "total_s": 231.2, ...},
 "shots": [{"id": "confirm", "target_s": 20, "start_s": 26.0, "end_s": 47.0, "status": "ok", "note": "", "mode": "demo",
            "program_start_s": 24.9, "program_end_s": 45.9, "move": {"kind": "push_in", ...}, "speed": []},
           {"id": "recall", "status": "skipped", "note": "http://127.0.0.1:8000 is unreachable (...)", ...}]}
```

`start_s` / `end_s` are in the recorded master; `program_start_s` / `program_end_s` (written by `captions.py`) are in `master.mp4`, after the speed-ups, and are what the labels, the cuts and `narrate.py` use.

### Live flow

```bash
bash scripts/demo_video/run.sh --live --serve-local                  # a local API started (and stopped) for the run
bash scripts/demo_video/run.sh --live --api http://127.0.0.1:8000    # an API you started
bash scripts/demo_video/run.sh --live --api <url> --mission <id>     # put the fleet on that mission instead of a new one
```

After the demo shots, `--live` sets up a fresh mission off camera with the creek scenario's three simulated drones in the air (`scripts/recall_demo.py`'s steps: conditions, a calm demo override first if the real ones say no flying, the fleet and Team Two join, a scripted manager approves the opening legs) and records `live_link` and `recall` on it. Both are **guarded**: they run only when the API answers `/health`, has `POST /missions/{id}/conditions/override` in its `/openapi.json`, and the HERIDAL **val** photos are there for the fleet sim; otherwise they are skipped with the reason. The site is built with `VITE_API_URL` set to the API, so the live console shows its Fleet controls.

`recall_demo`'s sim runs in one loop without the event stream, so the recorder hands the console's link request to it (`sim.set_link`, as the per-process fleet's feed would) and gives Team Two the scenario's own `no_signal` early; the sim reports both back (`POST /fleet/link`, `/fleet/relay`) and the map shows them. `shots.json` keeps the mission id, the number of relays and the fleet's last lines under the shots' `extra`.

`--serve-local` runs `python -m sightline.pipeline serve --radio text` with the agent and Tavily faked (`SIGHTLINE_FAKE_LLM=1`, `SIGHTLINE_FAKE_TAVILY=1`), its missions under `<run>/api/`, the cv2 detector from `web/public/models/sightline-detector-v2.onnx`. With the fake Tavily the live mission's conditions start as "flyability unknown"; the gusts override is what says no flying. `run.sh` passes `--extra conditions`. Never point it at AWS for a rehearsal: start AWS only for the real recording (and run `scripts/remote_check.py` first).

## Camera moves and pacing (`captions.py --only mp4`, `moves.py`, `captions.yaml`)

The program, `master.mp4`, is rendered from the 4K master. Each shot, and the frames between two shots, is a piece rendered by its own ffmpeg (several at a time) and joined without re-encoding. Pieces are near-lossless (CRF 10), and the export encodes them once more. `captions.yaml`'s `moves` section sets, per shot (coordinates in the 1920×1080 viewport's CSS pixels, times in the shot's recorded seconds):

```yaml
moves:
  default: {push_in: {scale: 1.08}}                     # any shot without its own entry: a slow centred push over the shot
  call:    {push_in: {focus: click, scale: 1.12}}       # towards the shot's last click (Follow the search)
  photos:  {push_in: {x: 1560, y: 540, scale: 1.08}, speed: [{start: 2.0, end: 7.0, rate: 1.5}]}
  results: {hold: true}                                 # no move ({x, y, scale}: a still crop)
```

- `push_in: {x, y, scale, start, end}` zooms from 1 to `scale` about (x, y) between `start` and `end` (default the whole shot), eased in and out (cubic). The point stays where it is on screen while the rest grows, so the frame never leaves the picture. It is ffmpeg `zoompan` on the master scaled up `program.upscale` times (2: 7680×4320). zoompan rounds its crop to whole pixels and shakes on a slow move unless the input is upscaled first (ffmpeg trac #4298). zoompan scales the crop to 2× the output, then lanczos takes it to 1080p.
- `speed`: a number (the whole shot) or `[{start, end, rate}]` (a wait inside it), applied with `setpts` (then `fps`). It runs before the move, because ffmpeg's `fps` filter must not follow `zoompan`: zoompan ends its stream at a timestamp in the wrong time base and `fps` pads hundreds of seconds. The move's times are mapped through the speed-up, so the move still lands where the recording says.
- The labels are burned in after all this, on the 1080p program, so they stay sharp and still.

The shots' places in the program go back into `shots.json` (`program_start_s`, `program_end_s`, `move`, `speed`). The labels, the cuts, the GIF and `narrate.py` read those, so a speed-up never puts a narration line over the wrong shot. `--size 2560x1440` renders the same program at 1440p (`master_1440p.mp4`, `master_1440p_captioned.mp4`) for a sharper upload; `--sample <shot>` cuts 10 s of the captioned program from that shot (`sample_<shot>.mp4`) to judge a move.

**Export profile** (`master_captioned.mp4`, the cuts, the narrated cuts): H.264 High, yuv420p, BT.709 tags, YouTube's recommended SDR bitrates (1080p: 8 Mbit/s at 30 fps, 12 at 60; 1440p: 16 / 24), VBV cap 1.5×, `-movflags +faststart`; AAC 192 kbit/s, 48 kHz for the narration.

## Captions and cuts (`captions.py`, `captions.yaml`)

`captions.yaml` holds the burned-in labels: one short step name per shot, not narration. A label is at most two lines of 42 characters with its number (`captions.py` wraps a long line at a space and refuses a label that would need a third) and stays on screen at least 1.2 s. Numbers are counted over the shots that actually ran, so a skipped shot leaves no gap. A label never calls an area done (`captions.py` refuses one that does); a searched sector is "searched at POD x"; anything simulated or recorded says so. The style is libass `force_style` (Inter, small, dark box, bottom centre).

The cuts are made from `master.mp4` with their own labels burned in (`cut_<name>.srt`: numbered in the cut's order and timed to its sped-up segments, so a step number never runs backwards; a segment's `label` replaces the shot's for that cut), silent, with black at the start and end for the on-camera clips:

- **OpenCV (≤ 5:00)**: [black 12 s] → call → photos → confirm → trace → next → run → conditions → results → breaks → black slots for the evidence index (30 s), reproduce in 5 min (30 s) and limits (20 s) slides → [black 10 s].
- **Nebius (≤ 3:00)**: [black 10 s] → call at 2× → confirm at 1.5× (labelled "Nemotron 3.5 Super VL on Nebius Token Factory") → run at 1.5× → fleet → live_link → recall at 1.25× → radio → breaks → a 15 s architecture slot → [black 10 s].

A shot that didn't run is left out. When the shots don't fit, each is trimmed from its tail by the same factor, except that none goes below its `min_s` (`breaks` keeps 12 s, so the three lines stay up at least 6 s); `"trimmed"` in `cut_<name>.json` says by how much. Edit the `cuts:` section to reorder, change a speed or resize a slot.

The GIF takes the first candidate shot (`gif.candidates`, in order of preference) with enough movement in its window (a candidate's own `min_motion` overrides the default), ends it on the frame within 16 s − 2 s .. 16.5 s closest to its first frame (never over 16 s after the fade), and fades its first half second in over its end, playing on from the frame after: the last frame is the frame before the first, so the loop has no jump. `offset_s` starts the window that far into the shot: `next` (the first choice) from 7.3 s, on Team One's clue card, then the proposal for C2, its approval and the drones flying. `end_aligned: true` takes the window that ends with the shot. It is cut from the 4K recording (`gif.sources`: `capture` first), not the captioned program: the program's push-ins change every pixel of every frame, and the same 16 s at 960 px came to about 25 MB from it against 1.9 MB from the recording. Larger than 3 MB, it keeps 12 fps and 960 px and tries a window 3 s and 6 s shorter, then 128 and 64 colours, then the next source; `run.sh --publish` remakes an older over-limit GIF that way before it gives up.

## Narration (`narrate.py`, `narration.yaml`)

Voices both cuts with NVIDIA Magpie TTS, the radio desk's model and speaker (`sightline/radio/tts.py`), and checks them by ear with Parakeet, the radio desk's ASR. It runs in the NeMo environment (`docs/feedback/radio.md`, "How to reproduce"), after `run.sh` has made the cuts:

```bash
~/radio-env/bin/python scripts/demo_video/narrate.py runs/video/<timestamp>   # -> runs/video/<timestamp>/narrated/
~/radio-env/bin/python scripts/demo_video/narrate.py runs/video/<timestamp> --dry-run   # no NeMo: tones sized at 150 wpm
```

`narration.yaml` holds one line per shot (keyed by the shot ids in `shots.json`, or `slot: <name>` for the OpenCV cut's three slides and the Nebius architecture slot), at most two sentences, sized at 150 words a minute, numbers as words, every model by name and everything simulated said so; the "what breaks first" lines are read word for word (`verbatim`). The on-camera open and close stay silent. `respell` is what Magpie is given for names it says wrong ("OpenCV 5" came out as "OpenZvy"; "Open CV five" is heard right).

For each line Magpie speaks each sentence (250 ms apart), up to `takes` samples, and keeps the one Parakeet hears best; a line over its shot by more than 0.5 s loses its second sentence and is listed in a warning to rewrite. The lines start 250 ms into their shots (never on top of the line before), the track is normalised to −16 LUFS (ffmpeg `loudnorm`, two passes) and muxed as AAC into `cut_<name>_narrated.mp4`, with "Narration: NVIDIA Magpie TTS" burned in over the first narrated shot just above its step label (one re-encode in `captions.py`'s export profile; `--no-credit` copies the video stream). Each line's time comes from `cut_<name>.json` (its place in the cut) checked against `shots.json`'s program times (after the speed-ups); a cut older than those times is refused with "rerun captions.py --only cuts". Also `narration_<name>.srt` (the spoken lines), `clips/`, and `narration_report.md` / `narration.json`: per line the text, seconds available and used, and the listen-check, Parakeet on each line cut back out of the finished mp4's audio, as word error rate with numbers spelled out on both sides (the script says "sixty percent", Parakeet writes "60%").

## Capture test (this machine, 2026-10-22, the new capture)

```bash
uv run --extra video python scripts/demo_video/record.py --out runs/video/capture-test --shots call,photos --landing '/#m/demo?t=0'
uv run --extra video python scripts/demo_video/captions.py runs/video/capture-test --only mp4,srt,burn --sample call
uv run --extra video python scripts/demo_video/captions.py runs/video/capture-test --only mp4,burn --size 2560x1440
```

`runs/video/capture-test/`: `call` and `photos` (t0, **Follow the search**, t1), 27.3 s recorded. Capture: 177 frames at 3840×2160, 15 fps median while the page moved (20 at p90), so the master is 30 fps. `master_4k.mp4` is 4.6 MB (1.3 Mbit/s at CRF 16) and took 71 s to encode. The program (`call` pushes 1.0 → 1.12 towards Follow the search; `photos` pushes 1.08 and plays the clock's run at 1.5×) is 25.7 s and rendered in 13 s. `master_captioned.mp4` is 21.8 MB (6.8 Mbit/s), `sample_call.mp4` (10 s) is 8.7 MB (7.0 Mbit/s) and `master_1440p_captioned.mp4` is 41.8 MB (13.0 Mbit/s). Frames for comparing sharpness: `frame_4k.png`, `frame_1080p.png` (the program, with its move and label), `frame_1080p_nomove.png` and `old_frame_1080p_recordVideo.png` (the same moment of `final5-20261022-140255`).

## Last run (live, `--serve-local`, this machine, 2026-10-22, after #177, recorded with `recordVideo`)

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
