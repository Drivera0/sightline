# Lane D · Pipeline: the glue, the survey and the app shell

> **Owner:** Teammate D · **Folders:** `sightline/contract.py`, `sightline/pipeline/`, `sightline/api/`, `tests/pipeline/`, repo config, `web/` shell (`web/src/shell/`, `web/src/lib/`), `web/src/review/`
> **Read first:** `00_OVERVIEW.md`, **all of** `01_CONTRACT.md` (you implement it)

---

## 1. Mission

You make four people's work into one product. You own:

- the **repo** and tooling,
- the **contract as code** (Pydantic models + generated TypeScript types),
- the **sample cache** everyone builds against from hour 1,
- the **demo survey builder** (500 frames, about 6 with people),
- the **pipeline** that runs every lane's functions in order and is the **only writer of the cache**,
- **ranking** and the ranking metrics,
- the **web app shell** and the **review queue** screen,
- the end game: backup video, Devpost, rehearsals.

### Definition of done

- [ ] `sightline/contract.py` matches `01_CONTRACT.md` exactly; `web/src/contract.ts` is generated from it.
- [ ] `cache/sample/` committed by hour 3 and valid.
- [ ] `python -m sightline.pipeline run --stages all --out cache/demo` builds the demo cache from raw inputs, and `validate` passes every check in contract §11.
- [ ] `metrics.ranking` computed honestly (seeded shuffle, no hand-placed positives).
- [ ] The web shell loads any cache by `VITE_CACHE_DIR`; the review queue works with the keyboard and drives the map.
- [ ] A recorded backup video of the full demo by hour 28.

---

## 2. Inputs and outputs

| Direction | What | From / to |
|---|---|---|
| In | HERIDAL test split (101 images + labels) | Dan, before the event |
| In | Lane functions | A `sightline.ml`, B `sightline.geo`, C `sightline.search` |
| In | `data/work/detect/` from the GPU desktop | A |
| Out | Every cache file | `cache/<name>/`, copied to `web/public/cache/<name>/` |
| Out | `web/src/contract.ts` | generated |
| Out | Shell, shared stores, review queue | `web/src/` |

---

## 3. Background you need

- **Why you're the only writer:** if four people write JSON by hand, the shapes drift and the website breaks at 3 a.m. With one writer validating against Pydantic models, a bad shape fails loudly in the pipeline instead of silently on stage.
- **Why stages write intermediate files:** detection needs the GPU desktop; everything else runs on laptops. Each stage reads and writes `data/work/<stage>/`, so Dan can run `detect` at home, share the folder, and the rest of the pipeline runs anywhere.
- **Why frames, not full photos:** every HERIDAL photo contains at least one person, so ranking full photos is meaningless. 1000×750 frames from test images give a realistic survey: mostly empty, a handful with people.

---

## 4. Before the event (setup only, no app code)

- [ ] Create the GitHub repo (Dan's account or a team org); add all four as collaborators; protect `main` (no force-push).
- [ ] `pyproject.toml` with `uv`, Python 3.11. Dependencies:
  - core: `numpy`, `pillow`, `opencv-python-headless`, `shapely`, `pydantic>=2`, `typer`, `fastapi`, `uvicorn`
  - extra `ml`: `torch`, `torchvision`, `ultralytics`, `sahi` (A installs the CUDA build of torch per PyTorch's install guide)
  - dev: `pytest`, `ruff`, `matplotlib`
- [ ] `.gitignore`: `data/`, `cache/demo/`, `web/public/cache/demo/`, `*.pt`, `.env*`, `node_modules/`, `__pycache__/`, `data/runs/`.
- [ ] Folder skeleton from `00_OVERVIEW.md` §5 with empty `__init__.py` files, plus `CLAUDE.md` at the root and these docs in `docs/`. **No application code yet, including `contract.py`:** that's hour 0.
- [ ] `README.md`: one paragraph on the project, the three commands from `CLAUDE.md`, and this attribution line: "Imagery from the HERIDAL dataset (Božić-Štulić, Marušić & Gotovac, 2019), VOC-format copy by Pyrrö (2021), CC BY 3.0."
- [ ] Scaffold `web/` with `pnpm create vite` (React + TypeScript), add `maplibre-gl`, `pmtiles`, `zustand`, `tailwindcss`, `vitest`, `json-schema-to-typescript`. Confirm `pnpm dev` shows the default page. Nothing else yet.
- [ ] Read the event rules on prep and on prize tracks; note the tracks we qualify for.
- [ ] Get the test split from Dan into `data/heridal/yolo_full/test/`.
- [ ] Ask the team for a **personal origin story** for the pitch opener.

---

## 5. Code to build (signatures)

```python
# sightline/contract.py: every model in 01_CONTRACT.md, extra="forbid"
class LatLon(BaseModel): lat: float; lon: float
class Pose(BaseModel): lat: float; lon: float; alt_agl_m: float | None; heading_deg: float; gsd_m: float
class Frame(BaseModel): ...            # survey.frames[]
class Survey(BaseModel): ...           # survey.json
class Detection(BaseModel): ...        # detections.frames[*][]
class Detections(BaseModel): ...       # detections.json
class MapFile(BaseModel): ...          # map.json
class Metrics(BaseModel): ...          # metrics.json (+ VocScores, SarScores, DetectorMetrics, Ablation,
                                       #   Ranking, SearchSim; A imports these by these exact names)
class Manifest(BaseModel): ...         # manifest.json
CONTRACT_VERSION = "1.0"
def export_json_schema(out: Path) -> None   # CLI: python -m sightline.contract schema <out>

# sightline/pipeline/survey.py
@dataclass
class FrameSpec:
    id: str; flight_index: int; source_image: str; x0: int; y0: int; path: Path

@dataclass(frozen=True)
class FrameCandidate:
    source_image: str; x0: int; y0: int; w: int; h: int

def cut_frames(images: list[LabeledImage], w: int = 1000, h: int = 750
               ) -> list[tuple[FrameCandidate, Literal["positive", "negative", "ambiguous"], list[Box]]]
def build_survey(images: list[LabeledImage], n_frames: int = 500, n_positive: int = 6,
                 seed: int = 7) -> tuple[list[FrameSpec], dict[str, list[Box]]]   # frames, truth

# sightline/pipeline/rank.py
def rank_frames(dets: dict[str, list[RawDetection]], flight_index: dict[str, int],
                candidate_threshold: float) -> dict[str, tuple[float, int, int]]  # id -> (score, rank, n_candidates)
def ranking_metrics(ranks: dict[str, int], flight_index: dict[str, int],
                    truth: dict[str, list[Box]]) -> Ranking                        # contract model

# sightline/pipeline/export.py
def export_cache(work: Path, out: Path, survey_id: str = "seymour-demo") -> None
def validate_cache(path: Path) -> list[str]          # empty list = valid; each string = a failed check

# sightline/pipeline/sample.py
def write_sample(out: Path = Path("cache/sample")) -> None   # also copies to web/public/cache/sample/

# sightline/pipeline/__main__.py: Typer CLI
#   frames | place | detect | georef | rank | map | metrics | export | validate | sample | run
```

---

## 6. Step by step

### 6.1 Hours 0–3: contract, sample cache, shell

1. **`contract.py`** from `01_CONTRACT.md`, field for field. Add validators for the rules in contract §11 that fit on a model (lengths, unique ids, probabilities in range).
2. **`pnpm gen:contract`** script: `uv run python -m sightline.contract schema web/src/contract.schema.json && json2ts web/src/contract.schema.json web/src/contract.ts`.
3. **`write_sample`:** 20 real frames cut from 2–3 test images (CC BY 3.0, attribution in README), fake detections (`model: "SAMPLE"`), C's `build_map` with the placeholder prior once it exists (until then a uniform prior and **one step per frame with `cells: []`**, so `len(steps) == n_frames` holds), plausible fake metrics clearly marked SAMPLE. Validate, run the same copy step as `export` into `web/public/cache/sample/`, commit both folders, announce in the channel.
4. **Shell boots:** loads `public/cache/sample/`, shows the three tabs with placeholder content (§9).

### 6.2 Hours 3–10: survey builder + pipeline skeleton

**`cut_frames`:** split each test image into non-overlapping 1000×750 frames (4×4 for 4000×3000, 4×3 for 4000×2250).
- **positive:** fully contains at least one person box, and no box crosses its edge.
- **ambiguous:** any box crosses its edge. Excluded from the survey (a half-person is neither a fair hit nor a fair miss).
- **negative:** no box touches it.

**`build_survey`** (seed 7):
- Pick `n_positive` positives, preferring different source images.
- Pick `n_frames − n_positive` negatives at random.
- `n_frames` must equal B's `lines × frames_per_line` (20 × 25 = 500): frame `k` in the shuffled order gets `flight_index = k` and B's pose `k`.
- **Flight order = a seeded random shuffle of all frames. Don't place positives by hand.** Report what that shuffle gives, plus the random-order expectation `(N + 1)/(k + 1)` (contract §9), so a lucky shuffle can't mislead anyone.
- Write `data/survey/frames/<id>.jpg` (JPEG q85), `data/survey/frames.json` (the FrameSpecs) and `data/survey/truth.json` (frame id → boxes). **Truth never enters the cache.**
- Hand the frames to A as soon as they exist (around hour 8).

**Pipeline stages** (each reads/writes `data/work/<stage>/`, each skippable and re-runnable):

| Stage | Calls | Writes |
|---|---|---|
| `frames` | `build_survey` | `data/survey/` |
| `place` | B `simulate_flight`, `footprint` | `work/place/poses.json` |
| `detect` | A `sightline.ml.run_survey` (GPU; Dan runs it on the desktop) | `work/detect/detections_raw.json`, `crops/`, `config.json` |
| `georef` | B `georef_detection` | `work/georef/detections_geo.json` |
| `rank` | `rank_frames` (threshold from `work/detect/config.json`) | `work/rank/rank.json` |
| `map` | C `build_map` (recall from `work/detect/detector_metrics.json`, else 0.80) | `work/map/map.json`, `work/map/frame_cells.json` |
| `metrics` | copy A's `work/detect/detector_metrics.json` + `ranking_metrics` + C `simulate(map, frame_cells)` | `work/metrics/*.json` |
| `export` | `export_cache` → `validate_cache` → copy to `web/public/cache/<name>/` | `cache/<name>/` |

`run --stages all` runs them in order and writes `manifest.json` with timings and the git SHA (all 8 stages, including `export`). `detect` and A's detector metrics run on the desktop; `run --skip detect` picks up a copied `work/detect/`, and the manifest records `detect` as `{"ok": true, "seconds": 0.0}` with a note.

The search grid's cell size is `--cell-m` (default **5 m** since 2026-10-18: 200 × 200 = 40,000 cells over the 1 km grid; `DEFAULT_CELL_M` in `stages.py`, also used by single stages, the upload API and `real`). The website draws the cells as one canvas raster, so the cell count does not affect frame rate. The 5 m demo cache was rebuilt from `data/blocks` with `run --data data/blocks --skip frames,detect --layout blocks --seed 7 --out cache/demo` (map.json 2.9 MB raw, 119 KB gzip; map stage 24 s).

### 6.3 Hours 10–18: ranking + full run on real data

- **Score** = max `conf` in the frame (0 if none). **Rank** by score descending; ties: more candidates first, then lower `flight_index` first. `n_candidates` = detections with `conf ≥ candidate_threshold`.
- **`ranking_metrics`:** for flight order and ranked order, the 1-based position of the first truly positive frame and of the last one; minutes at the published 33 s/image. Include the contract's note that 33 s was measured on full 4000×3000 photos.
- **Full run** end to end on real data by **hour 18**. Fix every `validate` failure before anything else.

### 6.4 Hours 18–26: review queue

See §9.

### 6.5 Hours 26–36: ship

- **Hour 26:** feature freeze. Full demo click path works on the presenting laptop with **Wi-Fi off** (offline basemap).
- **By hour 28:** record the backup video (screen + voice, the 60-second demo).
- Devpost write-up: problem, what it does, how we built it, honest limitations (simulated path, simulated search evaluation, placeholder items), HERIDAL attribution, team.
- Lead three timed rehearsals.

### 6.6 Stretch: upload API (cut #2 on the list)

FastAPI in `sightline/api/`: `GET /health`; static mount of `cache/`; `POST /survey` (zip of JPEGs) runs `place → detect → … → export` into `cache/upload-<id>/` on the GPU desktop. Only if everything else is done.

---

## 7. Tests and acceptance checks

`tests/pipeline/`:

1. **Contract round trip:** the JSON examples in `01_CONTRACT.md` parse into the models (fill elided arrays with test data); unknown fields are rejected.
2. **`cut_frames`:** a synthetic 4000×3000 image with one box fully inside frame (row 1, col 2) and one box crossing a frame edge → 1 positive, the frames touched by the second box marked ambiguous, everything else negative.
3. **`build_survey`:** exactly 500 frames, exactly 6 positives, unique ids `f0001…f0500` in flight order, identical output for the same seed.
4. **Ranking:** hand-built detections → expected scores, ranks and tie-breaks; `ranking_metrics` positions correct for a known truth set.
5. **`validate_cache`** passes on `cache/sample/` and catches deliberately broken copies: a missing crop file, `sum(p) + outside ≠ 1`, a duplicate rank, a truth field present.
6. **Generated TS types** compile (`pnpm build`) after `pnpm gen:contract`.

---

## 8. Fallbacks

| Problem | Fallback |
|---|---|
| A lane's function isn't ready | Generate a placeholder output shaped to the **current** survey (e.g. `[]` detections for every frame id, one empty step per frame, a uniform prior) so downstream stages and validation still run. Don't reuse the sample cache: its 20 frame ids won't match the 500. Log it in `manifest.json` notes. |
| Desktop unreachable for `detect` | Dan runs it on Colab; copy `work/detect/` from there. |
| A validation check fails at hour 25 | Fix the data, never the validator. If it truly can't be fixed, hide that UI element and say so in the pitch. |
| Upload API | Cut it. The demo runs from the cache. |

---

## 9. Your screens: shell + review queue

You own the shell, the shared stores and the review queue. Look and shared components: `05_FRONTEND_SHARED.md`.

### 9.1 Shell (hours 0–10, early, so the others can build into it)

- `web/src/lib/cache.ts`: `loadCache(dir)` fetches the five JSON files from `/cache/${VITE_CACHE_DIR}/`, typed with `src/contract.ts`; loading and error states.
- `web/src/lib/selection.ts` (Zustand): `selectedDetectionId`, `selectedFrameId`. Shared by the queue (D), map (B) and heat (C).
- `web/src/shell/`: header ("Sightline · Mount Seymour survey", a "Simulated flight path" badge when true), three tabs **Review · Map · Metrics**, keyboard shortcut overlay (`?`), theme tokens from `05_FRONTEND_SHARED.md`.
- Empty mount points the other lanes fill: `<MapView/>` (B), `<HeatLayer/>` etc. (C), `<MetricsView/>` (A).

### 9.2 Review queue (hours 18–26)

`web/src/review/`:

- **Items:** detections with `conf ≥ candidate_threshold`, sorted by `conf` descending (ties by frame rank).
- **Layout:** a left list of crop thumbnails with confidence and status; a large centre crop (256 → 384 px) with frame id, rank and confidence; a small frame thumbnail with the box outlined; answer buttons with key hints.
- **Keys:** `J`/`↓` next, `K`/`↑` previous, `P` person, `N` not a person, `U` unsure, `Z` undo, `Enter` full frame view, `M` show on map.
- **Store** (`web/src/review/store.ts`, Zustand, hook `useReview`): `history: {detectionId, answer, at}[]` in order, with `answers` derived (latest answer per detection), `undo()`, `reset()`. Persist `history` to `localStorage` inside try/catch (works without it).
- **On answer:** append to the store's ordered answer history (the single source of truth for review state: C's `useSearch` derives the map from it, and B's pins read it); on "person", set the selection so B's map flies to the pin; auto-advance to the next unreviewed item. Undo and reset just edit the history, and the map follows.
- **Progress:** "12 of 38 reviewed · 1 person confirmed".

---

## 10. Your part of the pitch

You coordinate the pitch and own the opener: the origin story and the numbers (100+ North Shore rescues a year; 33 s per photo and a third of people missed). Hand off to A (detector), C (map reveal), then close on the ask.

---

## 11. For Claude (instructions when this file is given to Claude Code)

- You are working on **lane D**. Edit `sightline/contract.py`, `sightline/pipeline/`, `sightline/api/`, `tests/pipeline/`, repo config files, `web/src/shell/`, `web/src/lib/`, `web/src/review/`, `web/` config. Don't edit `sightline/ml/`, `sightline/geo/` or `sightline/search/`; call their public functions.
- `contract.py` must match `docs/01_CONTRACT.md` **exactly**: names, types, nesting, nullability. Use `extra="forbid"`. If the doc is ambiguous, stop and ask; don't guess.
- **The pipeline is the only cache writer.** Validate before writing; never write a cache that fails `validate_cache`.
- **Never let truth into the cache.** Truth lives in `data/survey/truth.json` and is only read by `ranking_metrics`.
- No hand-placed positives: the flight order is a seeded shuffle.
- Before finishing: `uv run pytest tests/pipeline`, `uv run ruff check .`, `uv run python -m sightline.pipeline validate cache/sample`, and for web work `pnpm test && pnpm build`.
- Good first prompts:
  1. "Read docs/01_CONTRACT.md fully and implement `sightline/contract.py` plus test 1 from LANE_D §7. Ask about anything ambiguous."
  2. "Implement `write_sample` and `validate_cache` per LANE_D §5–6.1 and test 5."
  3. "Implement `cut_frames` and `build_survey` per §6.2 with tests 2–3."
  4. "Build the web shell per §9.1 with the theme tokens in docs/05_FRONTEND_SHARED.md."
