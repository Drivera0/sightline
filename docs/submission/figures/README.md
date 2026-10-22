# Devpost gallery images

1920×1080 PNGs (all under 1 MB). The captions are in the gallery lists of `../DEVPOST_OPENCV.md` (O1–O6) and
`../DEVPOST_NEBIUS.md` (N1–N6), and they describe these files. Both galleries are the same six images, the demo
mission's story on the one-console site; the captions differ in what they point at (OpenCV 5, or the NVIDIA
models on Token Factory).

| File | Devpost caption | Source (`render_gallery.py`) |
|---|---|---|
| `console-t0-the-call-pitch-bar.png` | O1, N1: the console at 13:35 PDT (20:35 UTC), the call, with the pitch bar | `#m/demo?t=0` (the landing; t0 has no coach mark) |
| `photos-land-t1-each-photo-ranked-and-placed.png` | O2, N2: 14:18 PDT, the 500 photos land and are placed; 14 candidates | `#m/demo?t=1`, then Esc (the coach mark away; the Photos rail stays) |
| `second-look-t2-a-018-candidate-opencv5-zoom-nemotron-vl.png` | O3, N3: 14:31 PDT, the 0.18 candidate's card with its OpenCV 5 and Nemotron VL chips, the zoom open | `#m/demo?t=2`, Esc, then "Show the second look's images" |
| `trace-which-model-did-what-second-look.png` | O4, N4: the Trace view on that chain (the recorded av-chain run, below the demo mission's own trace), the model step open | `#m/demo/trace?t=2`, then the Model step opened |
| `run-t4-fleet-flying-b4-pod-60-conditions.png` | O5, N5: 15:00 PDT, the fleet flying, B4 at POD 60 %, the Conditions panel open | `#m/demo?t=4`, Esc, then `W` |
| `debrief-t5-three-numbers-what-breaks-first.png` | O6, N6: the Debrief's three numbers and what breaks first | `#m/demo?t=5`, Esc; "How much looking it saves" (between the two in the app) is left out of this frame so both fit |

Extras, not in either gallery now (taken before the one console, #171):

| File | What | Source |
|---|---|---|
| `radio-desk-clue-read-back-before-it-is-logged.png` | the radio desk on a live local mission (a clue, its readback, the clue on the map) | a live local mission, below |
| `clue-retasks-the-nearest-drone.png` | a team's clue re-tasks a drone (Drone 1's cancelled leg L001 over B2 fading out, its new leg L004 over C3) | `#m/demo/command` (now `#m/demo/map`), 100 ms after the map first draws (`render_retask.py`) |
| `assignment-card-gpx-kml-opened-in-caltopo.png` | the assignment card for B3, and the same sector's GPX in CalTopo | lane B's B3 card fixture + `docs/architecture/screens/caltopo-import.png` (`git show 1fc62da:docs/submission/figures/render_gallery.py`) |
| `architecture-photos-cv2dnn-map-agent-approval-on-aws.png` | the live architecture | `docs/architecture/live.png`, framed at 1920×1080 (same script as above) |

## The radio desk capture (extra)

Taken on 22 Oct 2026 against a local server: `serve --radio text --backend fake`, with the Token Factory and
Tavily keys loaded from `.env` into the server's environment only. Team Two had a position, and its turn was
typed in the desk. Nemotron 3 Super parsed it (2.2 s); Sightline read the clue back, and logged it after
"Affirmative, over". The clue then appears on the map and in the clue log ("by radio, confirmed").

The turn was typed, so Parakeet didn't run, and in `text` mode the replies are silent, so Magpie didn't
either. The caption says so. Voice mode needs the project's API dependencies in the NeMo environment
(`~/radio-env` has NeMo but not FastAPI).

To retake it:
1. Start the server with `--radio text`, with the keys in its environment.
2. `POST /missions`, then put a team in a sector with a position (`POST /tasks/<sector>`, `PATCH /teams/T2`).
3. Run the web app with `VITE_API_URL` set to the server, open `#m/<id>/map`, and type the two turns as Team Two.

The desk's log lives in the page, so take the screenshot before reloading.

## Retake the gallery

```bash
ln -s /path/to/web/public/cache/demo web/public/cache/demo   # the demo cache (not committed)
cd web && VITE_CACHE_DIR=demo npx vite --port 5191 --strictPort &   # note the PID; kill it by PID after
python docs/submission/figures/render_gallery.py docs/submission/figures   # a Python with playwright, Pillow + Chromium
```

Each frame waits for the map and 4 s more, does its one step, settles 400 ms and is saved with the cursor hidden;
a PNG over 1.5 MB is squeezed (pngquant if installed, else Pillow's 256-colour palette). Look at each one before
committing it.

`render_retask.py` (the re-task extra) opens `#m/demo/map` but still points at the old port 5201; edit the URL
to the current dev server's port before rerunning it.
