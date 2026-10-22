# Devpost gallery images

1920×1080 PNGs (all under 500 KB). Most come from the demo site with no server. The two diagram and card
images are repo images composed on the dark background. Captions are the gallery lists in
`../DEVPOST_OPENCV.md` (O1–O6) and `../DEVPOST_NEBIUS.md` (N1–N6).

| File | Devpost caption | Source |
|---|---|---|
| `command-view-detections-task-board-approval-inbox.png` | O1, N1: the command view (map, task board, approval inbox) | `#m/demo/command`, first-visit hint dismissed |
| `trace-which-model-did-what-second-look.png` | O2, N2: the crop and native zoom Nemotron VL answered from, with its trace line | `#m/demo/trace`, the model step opened (the recorded av-chain run) |
| `approval-inbox-every-proposal-carries-its-reason.png` | O3: every proposal carries its reason; nothing happens until a person approves | `#m/demo/approvals` |
| `assignment-card-gpx-kml-opened-in-caltopo.png` | O4: assignment card with GPX/KML, opened in CalTopo | `docs/architecture/screens/assignment-card.png` + `caltopo-import.png` |
| `architecture-photos-cv2dnn-map-agent-approval-on-aws.png` | O5 (and N5, partly): architecture | `docs/architecture/live.png` |
| `results-detector-vs-human-baseline.png` | O6, N6 (partly): detector vs the human baseline | the guided demo's Results step, `#results` |
| `conditions-tavily-quotes-sources-flyability.png` | extra (Tavily): each condition with its quote and page, the model, the flyability gate | `#m/demo/command`, then `W` |
| `front-door-the-product-first.png` | extra (cover candidate): the front door | `#` |

## Before using a caption, check these

- **O1 says "on a live mission".** The image is the demo mission, and its DEMO chip is visible. Say "on the demo mission", or retake against a live server.
- **O4 pairs two older screenshots of different sectors:** the card is B2 and the CalTopo import is B3. Retake both from one live mission before using this image, or change the caption.
- **N5 asks for the GPU speech models and the Serverless Job to be marked.** `live.png` shows AWS, Token Factory and Tavily but not those two, so N5 needs a new diagram.
- **O6 and N6** also ask for the cv2.dnn vs PyTorch parity table, the fleet simulation and radio latency. Those come from the report, not the app.

## Not made

- **N3, the radio desk:** `serve --radio text` runs locally, but with fake models (`SIGHTLINE_FAKE_LLM=1`) every reply is the canned `{}`. That would misstate what the caption claims (Parakeet, Nemotron 3 Super, Magpie). It needs a capture with the real models: the Token Factory key, and the NeMo environment for voices.
- **N4, a clue re-tasks the nearest drone:** the demo fixtures have no re-task proposal. This waits for the planner branch.

## Retake

```bash
ln -s /path/to/web/public/cache/demo web/public/cache/demo   # the demo cache (not committed)
cd web && VITE_CACHE_DIR=demo npx vite --port 5201 --strictPort &   # note the PID; kill it by PID after
python docs/submission/figures/render_gallery.py . docs/submission/figures   # a Python with playwright + Chromium
```
