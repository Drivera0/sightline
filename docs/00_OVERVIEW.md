# 00 · Sightline: Project Overview

> **Everyone reads this first.** Then read `01_CONTRACT.md`, then your own lane file.
> Event: **BCS Hackathon 2026**, 36 hours, team of 4.

---

## 1. The project in one minute

**Sightline finds the hiker in hundreds of search-and-rescue drone photos, then shows the rescue team where to look next.**

North Shore Rescue already flies drones over the mountains. The bottleneck is a person staring at hundreds of 12-megapixel photos for a hiker who is about 60 pixels wide. The published human baseline is **33 seconds per photo, 59% precision, 68% recall**: slow, and about a third of people missed.

Sightline does three things, in one loop:

1. **Rank.** A detector trained on real aerial search photos (HERIDAL) scores every photo and puts the likeliest crops at the top of a review queue.
2. **Pin.** Each detection becomes a GPS position on a map.
3. **Search next.** A probability map, using Bayesian search theory, updates after every photo. Open ground the drone saw clearly fades; forest the camera can't see into stays bright. That's where the ground team goes next.

It assists searchers. **It never decides on its own that an area is clear.**

---

## 2. Team and lanes

| Lane | Who | Owns | Lane file |
|---|---|---|---|
| **A. ML** | Dan | Person detector: data, tiled training, hard negatives, evaluation, detection on the demo survey | `LANE_A_ML.md` |
| **B. Geo** | Teammate | Photo pose, pixel → GPS, footprints, simulated flight path, map base layer | `LANE_B_GEO.md` |
| **C. Search** | Teammate | Search grid, prior, canopy estimate, probability updates, simulated evaluation, heatmap | `LANE_C_SEARCH.md` |
| **D. Pipeline** | Teammate | Repo, contract code, survey builder, pipeline runner, ranking, app shell, review queue | `LANE_D_PIPELINE.md` |
| **Everyone** | All 4 | One screen each from hour 18; the pitch together from hour 26 | `05_FRONTEND_SHARED.md` |

---

## 3. How the pieces fit

```
                       ┌──────────── on Dan's GPU desktop (offline) ────────────┐
 HERIDAL test images ─► D: cut into frames ─► B: place on simulated flight path
                                │
                                ▼
                       A: detect people in every frame (YOLO, tiled-trained)
                                │
                                ▼
                       B: detections → GPS     D: score + rank frames
                                │                      │
                                ▼                      │
                       C: canopy, POD, probability map │
                                │                      │
                                ▼                      ▼
                       D: validate + write the CACHE (JSON + JPEGs)  ◄── the contract
                       └─────────────────────────────────────────────────────────┘
                                │  copied to web/public/cache/
                                ▼
            Website (React): Review queue · Search map · Metrics   (reads only)
```

- Heavy work runs once, offline, on the GPU desktop. The website plays back the results, so **the demo needs no GPU, no backend and no Wi-Fi** (except map tiles; see `LANE_B_GEO.md` for the offline fallback).
- Lanes A, B and C write **Python functions**. D's pipeline calls them and is the only thing that writes the cache.
- The website replays the search map in the browser, so a searcher's "not a person" answer updates the map live.

---

## 4. Key decisions (already made, don't reopen without the team)

| Decision | What we chose | Why |
|---|---|---|
| Language | Python 3.11 for all backend lanes; TypeScript + React for the web | ML libraries are Python; one language means plain function calls between lanes. |
| Data | HERIDAL (CC BY 3.0), Zenodo copy in VOC format | Real labelled aerial search photos with a published human baseline. |
| Demo survey | 500 frames of 1000×750 px cut from **test** images, about 6 containing people | Every full HERIDAL photo contains a person, so full photos make ranking meaningless. Test images only, so the demo never uses training data. |
| Positions | Real photos on a **simulated** lawnmower flight path over **Mount Seymour** | HERIDAL photos come from many sites and cameras; most lack full flight data. Labelled "simulated" everywhere. |
| Live map update | Runs in the browser (TypeScript mirror of C's Python) | No server on stage. |
| Look | Matches the pitch deck: dark, glass panels, one orange accent, Geist fonts | Demo and slides feel like one product. |

---

## 5. Repo layout

```
sightline/
  CLAUDE.md                 # rules Claude Code loads automatically
  README.md
  pyproject.toml            # uv project; extras: [ml] for torch/ultralytics
  docs/                     # these files
  sightline/
    contract.py             # D: Pydantic models of 01_CONTRACT.md
    ml/                     # A
    geo/                    # B
    search/                 # C
    pipeline/               # D: CLI `python -m sightline.pipeline`
    api/                    # D: FastAPI (stretch goal)
  tests/
    ml/ geo/ search/ pipeline/
  scripts/                  # data prep scripts (allowed before the event)
  web/                      # React + Vite + TypeScript
    src/contract.ts         # generated from contract.py, never hand-edited
    src/search/update.ts    # C: TypeScript mirror of the update
    public/cache/<name>/    # copied from cache/ by the pipeline
  cache/
    sample/                 # fake data, committed
    demo/                   # real run, git-ignored
  data/                     # git-ignored: heridal/, survey/, work/, weights/
```

**Ownership rule:** you edit your own lane's folders. To change someone else's code, ask them, or ask in the channel.

---

## 6. Timeline and checkpoints (36 hours)

Each checkpoint = merge to `main`, then a 10-minute stand-up (done / blocked / cutting). `main` must run at every checkpoint.

| Checkpoint | A. ML | B. Geo | C. Search | D. Pipeline |
|---|---|---|---|---|
| **H3: contract frozen** | Training run 1 started on tiles | Camera math + tests on synthetic poses | Grid, prior, update function + tests | Repo, `contract.py`, sample cache, app shell boots |
| **H10: first real data** | First tiled model + test-set metrics; detections on survey frames | Real-pose reader on DJI photos; simulated flight path placed | Canopy estimate, POD per cell, `map.json` from sample data | Survey builder (500 frames), pipeline runs stages end to end on sample |
| **H18: data end to end** | Hard negatives, retrain; ablation table | Detection GPS; offline basemap fallback | Simulated evaluation; TS mirror passes test vectors | Full pipeline on real data → `cache/demo`; ranking metrics |
| **H26: feature freeze** | Metrics screen | Map base layer: footprints, path, pins | Heatmap, step slider, next-search panel | Review queue; full click path works |
| **H36: demo** | Pitch + rehearse | Pitch + rehearse | Pitch + rehearse | Backup video, Devpost, rehearse ×3 |

Hours 18–26 are shared frontend time, and hours 26–36 are freeze, pitch and rehearsal. Nothing new after hour 26.

**Cut order if behind:** (1) the re-check classifier (A's stretch), (2) the FastAPI upload endpoint, (3) the map step animation (show final map only), (4) charts on the metrics screen (plain table instead). **Never cut:** review queue, search map, honest numbers against the human baseline.

---

## 7. Before the event (setup and data prep only, no app code)

**Everyone**
- [ ] GitHub access to the repo; clone it.
- [ ] Install Python 3.11 + `uv`, Node 20 + `pnpm`, Git, and Claude Code.
- [ ] Read this file, `01_CONTRACT.md`, your lane file, `05_FRONTEND_SHARED.md`.
- [ ] Skim sections 2 and 5 of the AIR paper (arXiv 2111.09406), about 15 minutes.

Lane-specific prep is in each lane file under "Before the event".

---

## 8. Team rules

1. **The contract wins.** If your code needs a field that isn't in `01_CONTRACT.md`, propose it; don't invent it.
2. **`main` always runs.** Work on `lane-a`, `lane-b`, `lane-c`, `lane-d` branches; merge at checkpoints.
3. **Never commit** data, weights, `cache/demo/`, API keys or `.env` files.
4. **Blockers go in the channel immediately.**
5. **Training runs overnight** while people sleep in shifts.
6. **Honesty labels are not optional.** Anything simulated is labelled simulated in the app and the pitch: the flight path, the search-map evaluation, and the 10 m position uncertainty.
7. **Using Claude Code:** start each session by pointing Claude at your lane file and `01_CONTRACT.md`. Ask it to write tests first. Review what it writes before you merge.

---

## 9. The 60-second demo (what all of this builds toward)

1. Open the survey: "500 photos over Mount Seymour. At 33 seconds each, that's over four hours for one person."
2. **Review queue:** the likeliest crops come first. Press `P` on a real person.
3. **Map:** the pin drops. Press `N` on a backpack and the map updates live.
4. **Scrub the map** through the flight: open ground fades, forest stays bright. "This is where the team goes next."
5. **Metrics:** our detector vs. the human baseline, the ablation table, and frames reviewed before the first hit, ranked vs. flight order.

Details and timing are in `05_FRONTEND_SHARED.md`.

---

## 10. Numbers we will quote (each one must come from `metrics.json` or a cited source)

| Claim | Source |
|---|---|
| Human: 33 s per photo, 59% precision, 68% recall | Pyrrö et al. 2021 (fixed) |
| Our detector precision and recall on the HERIDAL test set | `metrics.detector` (A) |
| Stock model vs. our model | `metrics.ablations` (A) |
| Frames reviewed before the first hit, ranked vs. flight order | `metrics.ranking` (D) |
| Search map vs. naive map | `metrics.search_sim` (C), **labelled simulated** |
| 100+ North Shore rescues a year; Mount Seymour Dec 2024 rescue | DroneXL / CBC, 2025 |

No number goes on a slide or screen without one of these sources.

---

## 11. Glossary

| Term | Meaning |
|---|---|
| **Frame** | One 1000×750 px crop of a HERIDAL test photo. In the demo, each frame stands for one drone photo. |
| **GSD** | Ground sample distance: metres of ground per pixel. 0.02 m in the demo. |
| **Footprint** | The patch of ground a frame covers: a 20 m × 15 m rectangle. |
| **LKP** | Last known point: where the missing person was last seen. The centre of the search grid. |
| **Prior** | The probability map before any photo, based on distance from the LKP. |
| **POD** | Probability of detection: if the person were in this cell, the chance this photo would have found them. |
| **Canopy** | Fraction of a cell covered by trees or deep shadow. High canopy means low visibility, so low POD. |
| **Tiling / SAHI** | Cutting big images into overlapping tiles so small people aren't shrunk away. |
| **Hard negatives** | Things the detector wrongly calls people (rocks, bags); we train on them on purpose. |
| **Ablation** | Turning one technique off to measure how much it helps. |
| **Cache** | The folder of JSON and JPEG files that connects every lane. Defined in `01_CONTRACT.md`. |

---

## 12. Sources

- Pyrrö, Naseri & Jung (2021), *Rethinking Drone-Based Search and Rescue with Aerial Person Detection*: https://arxiv.org/abs/2111.09406
- HERIDAL in VOC format (CC BY 3.0), Zenodo: https://zenodo.org/records/5662351
- DroneXL, North Shore Rescue drones (2025): https://dronexl.co/2025/04/22/drones-ai-thermal-transform-search-and-rescue
- AIR detector code: https://github.com/Accenture/AIR
