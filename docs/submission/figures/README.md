# Devpost gallery images

1920×1080 PNGs (all under 500 KB). The captions are in the gallery lists of `../DEVPOST_OPENCV.md` (O1–O6) and
`../DEVPOST_NEBIUS.md` (N1–N6), and they describe these files.

| File | Devpost caption | Source |
|---|---|---|
| `command-view-detections-task-board-approval-inbox.png` | O1, N1: the command view on the demo mission | `#m/demo/command`, first-visit hint dismissed |
| `trace-which-model-did-what-second-look.png` | O2, N2: the crop and native zoom Nemotron VL answered from, with its trace line | `#m/demo/trace`, model step opened (the recorded av-chain run) |
| `approval-inbox-every-proposal-carries-its-reason.png` | O3: every proposal carries its reason | `#m/demo/approvals` |
| `radio-desk-clue-read-back-before-it-is-logged.png` | N3: the radio desk (a clue, its readback, the clue on the map) | a live local mission, below |
| `assignment-card-gpx-kml-opened-in-caltopo.png` | O4: assignment card for B3, and the same sector's GPX in CalTopo | lane B's real B3 card fixture (`web/command.html?card=B3`) + `docs/architecture/screens/caltopo-import.png` (B3) |
| `architecture-photos-cv2dnn-map-agent-approval-on-aws.png` | O5, N5: the live architecture | `docs/architecture/live.png` |
| `results-detector-vs-human-baseline.png` | O6, N6: detector vs people by eye; the other numbers are in the report's tables | the guided demo's Results step, `#results` |
| `conditions-tavily-quotes-sources-flyability.png` | extra (Tavily): each condition with its quote and page, the model, the flyability gate | `#m/demo/command`, then `W` |
| `front-door-the-product-first.png` | extra (cover candidate): the front door | `#` |

## Still open

- **N4:** a clue re-tasks the nearest drone. The demo fixtures have no re-task proposal, so this waits for the planner branch.
- **N5:** `live.png` doesn't draw the speech models or the Serverless Job. The caption says where they run instead.

## The radio desk capture (N3)

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
3. Run the web app with `VITE_API_URL` set to the server, open `#m/<id>/command`, and type the two turns as Team Two.

The desk's log lives in the page, so take the screenshot before reloading.

## Retake the rest

```bash
ln -s /path/to/web/public/cache/demo web/public/cache/demo   # the demo cache (not committed)
cd web && VITE_CACHE_DIR=demo npx vite --port 5201 --strictPort &   # note the PID; kill it by PID after
python docs/submission/figures/render_gallery.py . docs/submission/figures   # a Python with playwright + Chromium
```
