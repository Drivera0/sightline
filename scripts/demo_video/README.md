# Demo video pipeline

One command records the whole story as a 4K master (the 1920×1080 viewport at device scale 2, captured frame by frame), renders the camera moves and speed-ups from it down to a 1080p program, burns in short captions in the site's type, cuts the OpenCV (≤ 4:30) and Nebius (≤ 2:50) videos from it with their slots and the disclosure card, and makes the README GIF (≤ 16 s, ≤ 3 MB); `narrate.py` then voices both cuts with whichever narrator is chosen. Shot list v2 follows the seven-beat story of PR #200 ("Follow the search", t0–t6: the call, photos land, confirm, where next, the run, the find, the debrief) told in three acts. The selectors are roles and labels, and a shot whose element isn't there is skipped (or failed) with the reason in `shots.json`.

```bash
uv sync --extra video                 # playwright==1.64.0 + pyyaml (not in the default deps)
uv run --extra video playwright install chromium   # once per machine
bash scripts/demo_video/run.sh --publish   # -> runs/video/<timestamp>/ (+ docs/report/figures/demo.gif)
~/radio-env/bin/python scripts/demo_video/narrate.py runs/video/<timestamp>   # -> <run>/narrated/ (Magpie)
```

Needs `web/node_modules` (`pnpm install` in `web/`), the demo cache in `web/public/cache/demo` (README, "The demo cache"), and `ffmpeg` with libass. In a git worktree, link the main checkout's cache: `ln -s <main>/web/public/cache/demo web/public/cache/demo`.

## What runs

| Step | Script | Output in the run folder |
|---|---|---|
| record | `record.py` (+ `capture.py`) | `master_4k.mp4` (3840×2160, H.264 CRF 16, BT.709, 60 or 30 fps), `shots.json`, `frame_times.json`, `snaps/NN_<shot>.png` (last frame of each shot) |
| program, captions | `captions.py --only mp4,srt,burn` (+ `moves.py`) | `master.mp4` (1920×1080 program: moves and speed-ups, uncaptioned), `captions.srt` / `.ass`, `fonts/` (the site's Geist for libass), `master_captioned.mp4` (export profile) |
| cuts | `captions.py --only cuts` | `cut_opencv.mp4` (≤ 4:30), `cut_nebius.mp4` (≤ 2:50), `cut_<name>.srt` / `.ass` (the cut's own captions and card), `cut_<name>.json` (every segment: source in/out, output time) |
| gif | `captions.py --only gif` | `demo.gif` (12 fps, 960 px, one palette, ≤ 3 MB, ≤ 16 s, loops), `gif.json` |

`run.sh` runs them in that order (`--1440` adds `master_1440p.mp4` and `master_1440p_captioned.mp4` for the upload). It is idempotent: a run folder whose `shots.json` names a recording that is there is not recorded again (`--out <folder>` to finish or redo one), and each later step is skipped while its output is newer than its inputs (`FORCE=1` redoes them). `--publish` also copies the GIF to `docs/report/figures/demo.gif` if it is at most 3 MB; without it nothing outside `runs/` (gitignored) is written. Other flags go to `record.py`.

## Recording (`record.py`)

Builds the site with `VITE_CACHE_DIR=demo` into the run folder, serves it with `vite preview` on port 5202 (`--server dev` for the dev server), and stops it by PID at the end (it never kills a process it didn't start; if 5202 is taken it stops and says so). Chromium then plays these shots (shot list v2), each a named step with a target length (an action that finishes early holds its last frame up to the target), with 400 ms of settle before each. They are one continuous walk through the story's coach marks, so each shot starts where the one before left the console (`--shots` is for debugging one stretch, not for re-taking one shot):

| Shot | Beat | What happens | Target |
|---|---|---|---|
| `call` | t0 | `/`: the pitch bar, **Follow the search**; the first coach mark; the pointer over the status line (elapsed, daylight, flyable, out, subject) and the teams at base camp | 14 s |
| `photos` | t1 | **Next**: the clock runs 6 s over drone one's survey, 500 photos land and the map changes under its legs; **Next**: the candidates waiting in Needs you | 22 s |
| `confirm` | t2 | **Person** on #1 (f0336-d01) and #2 (f0127-d01); the grey bag (f0452-d01): **Not a person**; the 0.17 card from this flight (f0273-d02, "Second look · this flight"): its model chips, **Show the second look's images**, **Person**; the pin on the map | 34 s |
| `trace` | | **Trace** in the view switch: the f0273-d02 chain, the pointer down its steps, the model call opened | 10 s |
| `next` | t3 | `#m/demo?t=3`: Team One's radio call and the clue it became on the timeline, the map's move toward it; **Next**: the proposal (Team One to C2) in Needs you, its reason; **Approve** | 22 s |
| `run` | t4 | the clock runs 6 s: teams out, drones fly their legs; Drone 2's card (link lost), Drone 3's (link degraded), Team Two on the map | 18 s |
| `fleet` | t4 | (the Nebius cut) the D2, D3 and Team Two markers' tooltips, "Team Two heard via D3" on the timeline | 14 s |
| `walk` | t4 | **Next**: Team One walks C2 | 9 s |
| `radio` | t5 | the timeline on **Radio**; **Next**: the clock runs 2.5 s, Team One's call ("Subject located in Charlie Two …") and the desk's reply land | 15 s |
| `find` | t5 | **Found · C2** in the status line, then Team One on the map, held 4.5 s | 12 s |
| `debrief` | t6 | **Next**: the after-action report ("Found by Team One in C2", key events); the Debrief scrolled to "What breaks first", the three lines one by one | 26 s |
| `live_link`, `recall` | | **`--live` only**, not in the v2 cuts: the Fleet controls cut a link; gusts → no flying → recall (below) | 18 s, 32 s |

None of the v2 shots needs an API: the demo mission is fixtures plus the demo cache, and it already holds drone two's lost link and drone three's relay of Team Two. The two live shots need one (below).

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

## Captions, the card and the cuts (`captions.py`, `captions.yaml`)

`captions.yaml` holds one short caption per shot (a lower third, not narration), in the site's type: Geist, copied from `web/node_modules/@fontsource-variable/geist` into the run's `fonts/` for libass (Inter when it isn't there), rendered from an `.ass` file with three styles (Label, Card, Credit) on a 1920×1080 canvas. A caption is at most two lines of 42 characters (`captions.py` wraps a long line at a space and refuses one that would need a third) and stays on screen at least 1.2 s. A model's name appears when it acts. Inside the story no caption says demo, recorded, scripted or simulated, and none calls an area clear or ruled out: `captions.py` refuses them (storyCopy.ts's `STORY_BANNED`). The disclosure card is the one place those words go: "A simulated search on real aerial photographs", 3 s, centred, faded in and out, rendered by the pipeline on black.

Each cut is cut from `master.mp4` with its own captions and card burned in (`cut_<name>.srt` and `.ass`, timed to its sped-up, trimmed segments). Segments are shots, black slots (footage, the owner on camera, a slide or animation made elsewhere; a slot can carry placeholder captions, spread evenly over it, and `on_camera` slots are never narrated) and cards:

- **OpenCV (≤ 4:30)**. Act 1: cold open (8 s, real footage) → disclosure card (3 s) → owner on camera (10 s) → `call`. Act 2: `photos` → `confirm` → `trace` → `next` → `run` → `walk` → `radio` → `find`. Act 3: `debrief` (the three "what breaks first" lines read over it) → architecture slot (20 s, for the Figma/Canva animation; captions name OpenCV 5, Nemotron 3.5 Super VL, Nemotron 3 Nano, Parakeet, Magpie, Nebius Token Factory and Tavily) → proof slide slot (15 s) → close (10 s).
- **Nebius (≤ 2:50)**. The same act 1 (the owner says "it runs on Nebius Token Factory") → `call` at 1.5× → `photos`, `confirm`, `next` at 1.25× with Nebius Serverless Job / Token Factory captions → `run` → `fleet` (the longer fleet beat) → `walk` → `radio` → `find` → architecture slot (10 s) → close (10 s).

A shot that didn't run is left out. When the shots don't fit, each is trimmed from its tail by the same factor, except that none goes below its `min_s` (`find` is never trimmed, for its 4 s hold, `debrief` 22 s for the three lines); `"trimmed"` in `cut_<name>.json` says by how much. Edit the `cuts:` section to reorder, change a speed or resize a slot. Camera moves (`moves:`) are slow push-ins on the panel being used; `speed` is only for waits inside a shot.

The GIF takes the first candidate shot (`gif.candidates`, in order of preference) with enough movement in its window (a candidate's own `min_motion` overrides the default), ends it on the frame within 16 s − 2 s .. 16.5 s closest to its first frame (never over 16 s after the fade), and fades its first half second in over its end, playing on from the frame after: the last frame is the frame before the first, so the loop has no jump. `offset_s` starts the window that far into the shot: `next` (the first choice) from 7.3 s, on Team One's clue card, then the proposal for C2, its approval and the drones flying. `end_aligned: true` takes the window that ends with the shot. It is cut from the 4K recording (`gif.sources`: `capture` first), not the captioned program: the program's push-ins change every pixel of every frame, and the same 16 s at 960 px came to about 25 MB from it against 1.9 MB from the recording. Larger than 3 MB, it keeps 12 fps and 960 px and tries a window 3 s and 6 s shorter, then 128 and 64 colours, then the next source; `run.sh --publish` remakes an older over-limit GIF that way before it gives up.

## Narration (`narrate.py`, `narration.yaml`)

The narrator isn't chosen yet, so the narration is voice-agnostic: `--engine magpie` (default; NVIDIA Magpie TTS through the radio desk's wrapper, in the NeMo env), `--engine elevenlabs` (the API; the key from `ELEVENLABS_API_KEY`, never printed; `--voice` eric, daniel, matilda or river; `eleven_multilingual_v2`, stability 0.55, similarity 0.8, style 0.15, 44.1 kHz mp3 decoded to wav) or `--engine kokoro` (Kokoro-82M through `/home/driver/voices-env/kokoro/bin/python`, `am_michael`). Every voice is decoded to 48 kHz mono. Run after `run.sh` has made the cuts:

```bash
~/radio-env/bin/python scripts/demo_video/narrate.py runs/video/<ts>                                   # Magpie -> <run>/narrated/
~/radio-env/bin/python scripts/demo_video/narrate.py runs/video/<ts> --engine elevenlabs --voice daniel # -> <run>/narrated-elevenlabs-daniel/
~/radio-env/bin/python scripts/demo_video/narrate.py runs/video/<ts> --engine kokoro                    # -> <run>/narrated-kokoro-am_michael/
uv run --extra video python scripts/demo_video/narrate.py runs/video/<ts> --dry-run                     # no voices: tones at 150 wpm, checks the fit
```

`narration.yaml` holds the search manager's lines, present tense, one or two sentences a shot, sized at 150 words a minute to the shot's time in the cut; act 3 drops into the builder's voice. Inside the story nothing says demo, recorded, scripted or simulated and nothing says clear or rule out (`narrate.py` refuses them); the one exception is the `verbatim` "what breaks first" lines, read word for word over `debrief` (the third begins "The fleet is a simulation"). On-camera slots stay silent. Each engine has its own respelling table: `respell.magpie` ("OpenCV 5" came out as "OpenZvy"; "Open CV five" is heard right) and `respell.plain` for ElevenLabs and Kokoro; a line's `say` / `say_plain` replaces it entirely.

The radio exchange stays in-world: Team One's call (Magpie speaker 3) and the desk's reply (speaker 0, Sightline's voice) are always Magpie, whichever engine narrates, placed `at_s` into the `radio` shot with no narrator over them; with another narrator the credit adds "Radio: NVIDIA Magpie TTS".

For each line the engine speaks each sentence (250 ms apart), up to `takes` samples (Magpie 3, ElevenLabs and Kokoro 1), and keeps the one Parakeet hears best; a line over its shot by more than 0.5 s loses its second sentence and is listed to rewrite (a verbatim, in-world or one-sentence line is listed, not cut). The lines start 250 ms into their shots (never on top of the line before), the track is normalised to −16 LUFS (ffmpeg `loudnorm`, two passes) and muxed as AAC into `cut_<name>_narrated.mp4`, with the engine's credit burned in over the first narrated shot just above its caption. Each line's time comes from `cut_<name>.json` checked against `shots.json`'s program times; a cut older than those is refused with "rerun captions.py --only cuts". Also `narration_<name>.srt`, `clips/`, and `narration_report.md` / `narration.json` (per line the text, seconds available and used, whether it fits, and the listen-check: Parakeet on each line cut back out of the finished mp4's audio, as word error rate with numbers spelled out on both sides; skipped, and said so, where NeMo isn't importable).

## Scenes for Synthesia (`scenes.py`)

Clean footage, one file per scene, for the Synthesia cuts: no narration, no captions, no music, no camera moves. It drives the current UI (the guided simulation's decisions, the review frame, Needs you, the Conditions panel, the Trace and the end screen) by role and label, and replaces `record.py`'s shot list for this purpose (that list follows the old pitch bar and coach marks).

```bash
uv run --extra video python scripts/demo_video/scenes.py                            # all ten scenes + architecture_4k.png
uv run --extra video python scripts/demo_video/scenes.py --scenes s3,n2             # just those (name prefixes)
uv run --extra video python scripts/demo_video/scenes.py --publish /mnt/c/Users/<you>/Desktop/sightline-video/final
uv run --extra video python scripts/demo_video/scenes.py --url http://127.0.0.1:5301 --dist <build> --scale 1   # a quick dry run
```

It builds the site with `VITE_CACHE_DIR=demo`, serves it with `vite preview` on port 5301 (stopped by PID), and records every scene in a fresh context of one Chromium: the tour marked seen, dark scheme, America/Vancouver, the page clock at the demo fixture's `now`. Whatever comes before a scene (the guided run's earlier decisions, taken the AI's way; the clock run to the scene's decision) happens with the screencast stopped; then the capture starts on a held frame, the pointer (record.py's, without the sync mark) moves on eased curves and rests 0.6 s before each click, and the capture stops on a held frame. Frames are `capture.py`'s (3840×2160 at device scale 2); each clip is encoded at 30 fps, CRF 16, BT.709, no audio, `+faststart`, with a lanczos 1920×1080 copy in `1080p/` and a start/middle/end contact sheet in `contact/`.

| File | Scenario | What it shows | Target |
|---|---|---|---|
| `s1_home_start` | home | the hero and Built with, a slow scroll past the stats and Agentic vision, Try the guided simulation, Overdue hiker's Start the simulation, the subject strip | 30 s |
| `s2_photos_land` | Overdue hiker, guided | Survey: the AI's flight lines; the time-lapse at 1× (photos placed, the map lowering where it looked, the decision bar's lines) | 35 s |
| `s3_second_look` | Overdue hiker, guided | Review photos: 336 The subject, the grey bag Not a person, 273 at 0.17 enlarged, Run AI re-check (crop, OpenCV 5 zoom, Nemotron VL, Nebius Token Factory), The subject; the sighting proposal, Approve | 45 s |
| `s4_false_alarm` | Dementia walk-away, console | the backpack (photo 502, 0.15): Run AI re-check (no person, a backpack), Object… backpack, the possible clue it becomes | 25 s |
| `s5_teams_find` | Overdue hiker, guided | Clue: the read-back, Confirm clue; Assign: send the free teams to the AI's picks; 4× and Skip ahead; Link; Team Four's report, Record find; Found · C2 | 30 s |
| `s6_you_vs_ai` | Overdue hiker, end screen | Without Sightline vs with Sightline: the headline, the table, the bars, How this is worked out | 20 s |
| `n1_photos_land` | Overdue hiker, guided | the fleet: drones on their flight lines, drone two's lost link, the drone rows, the teams moving | 25 s |
| `n2_radio` | Overdue hiker, guided | the timeline on Radio: Team One's call and the desk's read-back with their voices, the read-back card, Confirm clue (`n2_radio_with_audio.mp4`: the clips the page played, laid back in at their times) | 25 s |
| `n3_wind_recall` | Dementia walk-away, guided | the Conditions panel: the gust limit, the recorded Tavily lookup and its quote; the wind step's recall card, Approve | 25 s |
| `n4_find_summary` | Overdue hiker, after the find | the Trace's "N Nemotron calls on Nebius Token Factory in this mission", one chain, a model call; the end screen's headline | 20 s |

The overdue hiker is the demo mission itself, which has no distractor photos and no wind step, so `s4` and `n3` use Dementia walk-away (its flight has the backpack with a recorded re-check, and like Missing child and Despondent it reaches the wind step 87 mission minutes after the call). `n2`'s audio: headless Chromium plays the voice clips to no device, so an init script reports each `play`, `pause` and `ended` with the recorder's clock and ffmpeg mixes those files under the take. `architecture_4k.png` is figure 1 of `docs/architecture/sightline-architecture.html` (the SVG behind `system.png`) screenshotted at 3840 px wide. On this machine (WSL2, no GPU) the 4K takes run longer than the targets where a scene has many pointer moves or the clock's beats (s3 65 s, s5 51 s; the others within about 8 s of theirs), and `s6` is recorded at `--scale 1` and upscaled: at scale 2 the end screen's blurred backdrop drops the screencast to about 1 frame a second. Pass `--scale` for one scene to do the same; a 4K file recorded smaller says so in `scenes.json` (`upscaled_from`) and `README.txt`. `scenes.json` has each clip's probe, capture rate, page errors and (n2) the clips placed; `README.txt` lists the files for the editor.

## Capture test (this machine, 2026-10-22, the new capture)

```bash
uv run --extra video python scripts/demo_video/record.py --out runs/video/capture-test --shots call,photos --landing '/#m/demo?t=0'
uv run --extra video python scripts/demo_video/captions.py runs/video/capture-test --only mp4,srt,burn --sample call
uv run --extra video python scripts/demo_video/captions.py runs/video/capture-test --only mp4,burn --size 2560x1440
```

`runs/video/capture-test/`: `call` and `photos` (t0, **Follow the search**, t1), 27.3 s recorded. Capture: 177 frames at 3840×2160, 15 fps median while the page moved (20 at p90), so the master is 30 fps. `master_4k.mp4` is 4.6 MB (1.3 Mbit/s at CRF 16) and took 71 s to encode. The program (`call` pushes 1.0 → 1.12 towards Follow the search; `photos` pushes 1.08 and plays the clock's run at 1.5×) is 25.7 s and rendered in 13 s. `master_captioned.mp4` is 21.8 MB (6.8 Mbit/s), `sample_call.mp4` (10 s) is 8.7 MB (7.0 Mbit/s) and `master_1440p_captioned.mp4` is 41.8 MB (13.0 Mbit/s). Frames for comparing sharpness: `frame_4k.png`, `frame_1080p.png` (the program, with its move and label), `frame_1080p_nomove.png` and `old_frame_1080p_recordVideo.png` (the same moment of `final5-20261022-140255`).

## Last run (shot list v2, this machine, 2026-10-22, main at 01c3342 after #199 and #201)

`runs/video/v2-20261022-195041/` (copied to `C:\Users\drive\Desktop\sightline-video\v2\`): the story only (no API, no `--live`), 4K capture at 15 fps median while moving, a 30 fps master of 210.9 s; shot times from the sync mark, 11 shots ok, none skipped or failed:

| Shot | Program | Length | Target |
|---|---|---|---|
| call | 1.0–14.5 | 13.5 | 14 |
| photos | 15.5–37.5 | 22.0 | 22 |
| confirm | 38.5–69.9 | 31.4 | 34 |
| trace | 70.9–82.5 | 11.6 | 10 |
| next | 83.3–104.9 | 21.6 | 22 |
| run | 106.3–124.9 | 18.6 | 18 |
| fleet | 126.5–139.3 | 12.8 | 14 |
| walk | 141.0–149.8 | 8.8 | 9 |
| radio | 151.9–168.4 | 16.5 | 15 |
| find | 169.7–182.1 | 12.4 | 12 |
| debrief | 183.2–209.0 | 25.8 | 26 |

Cuts: OpenCV 4:08.1 (10 shots, act 1 ends at 0:34.5, none trimmed), Nebius 2:49.5 (9 shots, trimmed to 0.92 except `find` and `radio`). Narration with Magpie (the placeholder voice): every line fits (the dry run at 150 wpm flagged only the architecture line, 0.4 s over; Magpie's first take ran 0.7 s over and lost its second sentence, so the line was cut to two shorter sentences); listen-check WER 0.035 (OpenCV) and 0.028 (Nebius). A Kokoro take of the Nebius cut fits too. The GIF from `run` comes out at 4.8 MB after the four retries (the heat of #199 is busier), so it is not published; `docs/report/figures/demo.gif` stays as it is.

