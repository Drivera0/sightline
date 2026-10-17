# Lane C · Search: the probability map

> **Owner:** Teammate C · **Folders:** `sightline/search/`, `tests/search/`, `web/src/search/`, `web/src/map/heat/`
> **Read first:** `00_OVERVIEW.md`, `01_CONTRACT.md` (§8 `map.json`, §9 `metrics.search_sim`)

---

## 1. Mission

Keep a running answer to **"where could the missing person still be?"** Start from a prior around the last known point. After every photo that didn't find anyone, lower the probability where the camera could see well, barely touch it where trees hide the ground, and raise it everywhere else. This is **Bayesian search theory**, the method real search planners use. It's the part judges won't have seen, and the demo's reveal.

### Definition of done

- [ ] `build_map(...)` returns a contract `MapFile` (`map.json`): grid, prior, canopy, one step per frame, final, top cells.
- [ ] The three-cell worked example (§3.4) is a passing unit test.
- [ ] `simulate(...)` returns `metrics.search_sim`: three methods, 1,000 trials, seeded.
- [ ] A TypeScript mirror of the update (`web/src/search/update.ts`) reproduces Python's results within 1e-9 on shared test vectors.
- [ ] The heatmap layer, step slider and "search next" panel work in the web app.

---

## 2. Inputs and outputs

| Direction | What | From / to |
|---|---|---|
| In | LKP | Agreed with B before the event (`sightline/geo/constants.py`) |
| In | Frame poses, footprints, `latlon_to_pixel` | B |
| In | Frame images | `data/survey/frames/` (D) |
| In | Candidate detections with lat/lon/radius | A + B, via D's pipeline |
| In | Detector recall | A, from `data/work/detect/detector_metrics.json` (`recall`); placeholder **0.80** until it exists |
| Out | `MapFile` (contract §8) | to D's pipeline → `map.json` |
| Out | `SearchSim` (contract §9) | to D's pipeline → `metrics.json` |
| Out | `update.ts` + test vectors | used by the website |
| Out | Heat layer, slider, panel | `web/src/map/heat/` |

---

## 3. Background you need

### 3.1 The grid (contract §8, repeated because it matters)

- 1,000 m × 1,000 m, centred on the LKP, **20 m** cells → **50 × 50 = 2,500 cells**.
- `origin_nw` = north-west corner. **Row 0 = north, column 0 = west.** `idx = row · 50 + col`.
- Cell centre: `lat = origin.lat − (row + 0.5)·20/111320`, `lon = origin.lon + (col + 0.5)·20/(111320·cos(origin.lat))`.
- Plus one **outside** bucket: the chance the person is outside the grid. `sum(p) + outside = 1` always.
- The survey sector B flies covers about 303 m × 324 m, roughly a tenth of the grid. The map therefore shows a clear "searched" patch and an untouched remainder. That's realistic: one flight covers a small part of a search area.

### 3.2 The prior

Lost-person behaviour research gives, per subject category, the distances from the LKP within which 25%, 50%, 75% and 95% of subjects were found. Use the **hiker** category from Koester's *Lost Person Behavior* (the source HERIDAL's authors used). **Look the numbers up before the event; don't guess them.**

Turn rings into cells:

- Rings `[(r₁, c₁), (r₂, c₂), …]`, radius in metres and cumulative fraction found within it.
- Ring k holds mass `c_k − c_{k−1}` spread uniformly over its annulus area.
- A cell belongs to the ring containing its **centre**. In-grid cell mass = ring mass × (cell area / annulus area).
- Ring mass that falls outside the grid, plus `1 − c_last`, goes to `outside`.

**Until the real numbers are in:** uniform over the grid with `outside = 0.5`, and the `map.json` notes say "placeholder prior". Never ship invented ring numbers.

### 3.3 Visibility, canopy and POD

For each frame and each grid cell it overlaps:

1. **Overlap** `a` = area(cell ∩ footprint) / area(cell). Compute with Shapely in a local metric frame (equirectangular around `origin_nw`). A frame (20×15 m) covers at most 75% of a 20 m cell, so `a ≤ 0.75`.
2. **Canopy** `c` = fraction of the frame's pixels **inside that cell** that are tree canopy or deep shadow. Project the cell's corners into the frame with B's `latlon_to_pixel`, rasterise that polygon as a mask, and average the canopy classifier over the mask.
3. **Canopy classifier per pixel** (starting thresholds, tune them in §6.2):
   - Normalised colour: `r = R/(R+G+B)` etc.; excess green `ExG = 2g − r − b`.
   - `green = ExG > 0.04`
   - `textured = local std of greyscale (7×7 window) > 12` on a 0–255 scale. Grass is green but smooth; tree crowns are green **and** textured.
   - `shadow = max(R, G, B) < 60`
   - `canopy_pixel = (green AND textured) OR shadow`
4. **POD** (probability the photo would have shown a person there):
   `pod = min(pod_cap, recall × (1 − c) × a)` with `pod_cap = 0.95`.
5. **Held for review:** in a frame with a candidate detection (`conf ≥ candidate_threshold`), every cell **within `radius_m` of the detection** gets `pod = 0`. "Within" means the shortest distance from the point to the cell's square is ≤ `radius_m`, measured in local metres. That always includes the cell containing the point. (Testing cell *centres* against a 10 m radius on 20 m cells would miss every cell for about a fifth of positions.) We don't count "found nobody" where the detector actually fired; the searcher's answer decides (§3.5).

### 3.4 The update

When a photo found nobody:

```
D = 1 − Σ_{i in step} p_i · pod_i
p_i ← p_i · (1 − pod_i) / D        for cells in the step
p_j ← p_j / D                      for every other cell
outside ← outside / D
```

**Worked example (a required unit test):** three cells and no outside mass. `D = 1 − (0.50·0.80 + 0.30·0.20) = 0.54`.

| Cell | Before | POD | After |
|---|---|---|---|
| Open meadow, photographed | 0.50 | 0.80 | 0.1852 |
| Dense forest, photographed | 0.30 | 0.20 | 0.4444 |
| Not photographed | 0.20 | 0 | 0.3704 |

The forest becomes the most likely cell even though the drone flew over it.

### 3.5 Searcher answers (applied live in the browser)

| Answer on a crop | Effect on the map |
|---|---|
| **Not a person** | Cells within the detection's `radius_m` (same rule as §3.3 step 5) get `pod = review_pod` (0.90, capped by `pod_cap`), then run the update. |
| **Unsure** | No change. |
| **Person** | Map shows **found**: pin highlighted and a "Person confirmed" banner. The slider and later answers still work (the demo scrubs the map after the first "Person"), but the banner stays until undone. |

---

## 4. Before the event (setup and data prep only)

- [ ] Look up the **hiker distance rings** in *Lost Person Behavior* (or an authoritative summary of it) and write them down with the page or source.
- [ ] Agree the **LKP** with B.
- [ ] Work the three-cell example by hand.
- [ ] Get the test split from Dan. Pick **20 frames** (1000×750 crops) with a mix of meadow, forest, rock and shadow, and score each by eye: canopy 0, 0.25, 0.5, 0.75 or 1. Save as `tests/search/fixtures/canopy_labels.json`. This is how you'll tune §3.3.

---

## 5. Code to build (signatures)

```python
# sightline/search/grid.py
@dataclass(frozen=True)
class Grid:
    origin_nw: LatLon
    cell_m: float = 20.0
    rows: int = 50
    cols: int = 50

def make_grid(lkp: LatLon, size_m: float = 1000.0, cell_m: float = 20.0) -> Grid
def cell_center(grid: Grid, idx: int) -> LatLon
def cell_polygon(grid: Grid, idx: int) -> list[tuple[float, float]]          # [[lon, lat] × 4]
def cells_within_radius(grid: Grid, p: LatLon, radius_m: float) -> list[int]
    """Cells whose square lies within radius_m of p (point-to-square distance); always includes the cell containing p."""

# sightline/search/prior.py
def ring_prior(grid: Grid, lkp: LatLon, rings: list[tuple[float, float]]) -> tuple[np.ndarray, float]
def placeholder_prior(grid: Grid) -> tuple[np.ndarray, float]                 # uniform, outside = 0.5

# sightline/search/canopy.py
def canopy_mask(rgb: np.ndarray, exg_thr=0.04, std_thr=12.0, shadow_thr=60) -> np.ndarray   # bool H×W
def canopy_fraction(rgb: np.ndarray, mask: np.ndarray | None = None, **thr) -> float

# sightline/search/pod.py
@dataclass
class FrameInput:
    frame_id: str
    pose: Pose
    width_px: int
    height_px: int
    image: Path
    candidates: list[tuple[LatLon, float]]     # (position, radius_m) of detections ≥ candidate_threshold

def frame_step(grid: Grid, f: FrameInput, recall: float, pod_cap: float = 0.95
               ) -> tuple[list[tuple[int, float]], dict[int, tuple[float, float]]]:
    """Returns ([(idx, pod)...] with pod ≥ 0.001, {idx: (canopy, overlap)}) for one frame."""

# sightline/search/update.py
def apply_step(p: np.ndarray, outside: float, cells: list[tuple[int, float]]) -> tuple[np.ndarray, float]
def apply_review_not_person(p, outside, grid, at: LatLon, radius_m: float,
                            review_pod: float = 0.9, pod_cap: float = 0.95) -> tuple[np.ndarray, float]

# sightline/search/build.py
FrameCells = dict[int, tuple[float, float]]          # idx -> (canopy, overlap) for one frame
def build_map(grid: Grid, lkp: LatLon, prior: tuple[np.ndarray, float], frames: list[FrameInput],
              recall: float, recall_source: str) -> tuple[MapFile, list[FrameCells]]
    """MapFile (contract) + the per-frame (canopy, overlap) lists in flight order, which simulate() needs."""

# sightline/search/sim.py
def simulate(map_file: MapFile, frame_cells: list[FrameCells], trials: int = 1000, seed: int = 7,
             vis_noise: float = 0.15) -> SearchSim

# sightline/search/vectors.py   (CLI: python -m sightline.search.vectors)
def write_test_vectors(out: Path = Path("web/src/search/__fixtures__/update_vectors.json")) -> None
```

---

## 6. Step by step

### 6.1 Grid, prior, update (hours 0–3)

Write tests first (§7), then `grid.py`, `prior.py` (placeholder first), `update.py`. These need only NumPy and work on fake data. Give D a `build_map` that works with fake frames so the sample cache has a real-looking `map.json` by hour 3.

### 6.2 Canopy + POD (hours 3–10)

1. Implement `canopy_mask` / `canopy_fraction`.
2. **Tune** the three thresholds against your 20 hand-labelled frames: grid-search a few values each and minimise mean absolute error. Write the final MAE into `tests/search/fixtures/canopy_report.md`; it's an honest caveat for the pitch.
3. Implement `frame_step` using B's `footprint` and `latlon_to_pixel`. Until B's code lands, use your own straight-down projection with the same signature and swap it in later.

### 6.3 `build_map` on real data (hours 10–18)

- Steps in **flight order**, one per frame, even if `cells` is empty.
- `canopy` per cell = overlap-weighted mean over the frames that covered it; `null` if none.
- `final` = prior with every step applied; `top_cells` = top 5 by `final.p`.
- Compute in float64. When writing, round step `pod`, `canopy` and `top_cells.p` to 4 decimals; **write `prior` and `final` unrounded** (cell values are around 1e-4, so rounding them would break the sum checks).
- Compute `final` by replaying the **rounded** pods on the unrounded prior, so a replay of the file matches exactly. D's validator checks this within 1e-9.

### 6.4 Simulated evaluation (hours 10–18)

`simulate` takes the `MapFile` plus the per-frame `(canopy, overlap)` lists returned by `build_map`, because the drone's find probability and the naive method both need each cell's overlap, which `map.json` doesn't store. For each of 1,000 trials (seed 7):

1. Draw the true cell from `prior.p` renormalised over the grid (the person is assumed inside the grid).
2. Draw the person's **true visibility** in each covered cell: `clip((1 − canopy) + N(0, vis_noise), 0, 1)`. The noise stops the test from flattering our own canopy estimate.
3. Fly the survey in order. Whenever a step covers the true cell, the drone **finds** the person with probability `recall × true_visibility × overlap`. If found, the trial counts toward `found_by_drone_rate` and stops.
4. If never found, rank all cells by each method's final probability and record the true cell's 1-based rank ("cells checked before reaching the person"):
   | Method | POD used |
   |---|---|
   | Prior only | no updates |
   | Naive: photographed = cleared | `pod = pod_cap × overlap` |
   | Sightline: canopy-aware | `pod` from §3.3 |
5. Report median and 90th percentile per method over the not-found trials, and `found_by_drone_rate`.

Label the result **Simulated** everywhere.

### 6.5 TypeScript mirror (hours 10–18)

`web/src/search/update.ts`:

```ts
import type { MapFile } from "../contract";
type Grid = MapFile["grid"];            // the grid object from map.json; never redefine it

export interface MapState { p: Float64Array; outside: number }
export function applyStep(s: MapState, cells: [number, number][]): MapState
export function replay(prior: MapState, steps: { cells: [number, number][] }[], upTo: number): MapState
export function cellsWithinRadius(grid: Grid, lat: number, lon: number, radiusM: number): number[]
export function applyReviewNotPerson(s: MapState, grid: Grid, lat: number, lon: number,
                                     radiusM: number, reviewPod: number, podCap: number): MapState
```

- Pure functions; never mutate the input arrays. `cellsWithinRadius` uses exactly the same point-to-square rule as Python's `cells_within_radius`.
- `python -m sightline.search.vectors` writes cases (small 5×5 grids, random steps, one review case, the three-cell example) with expected outputs. `update.test.ts` (vitest) asserts every value within **1e-9**.
- A second vitest test loads `public/cache/sample/map.json`, replays all steps, and matches `final` within 1e-6.

### 6.6 Screen work (hours 18–26)

See §9.

---

## 7. Tests and acceptance checks

`tests/search/`, CPU only:

1. **Three-cell example** gives the numbers in §3.4 (±1e-4).
2. **Conservation:** after any step or review, `sum(p) + outside == 1` (±1e-9).
3. **No zeros:** a cell with POD at the cap still has p > 0.
4. **Untouched cells rise** by exactly the factor 1/D.
5. **Grid geometry:** cell 0's centre is 10 m south and 10 m east of `origin_nw`; cell 2,499 is in the south-east corner. `cells_within_radius`: at the LKP (the corner shared by 4 cells), r = 1 m returns those 4 cells; at a cell's centre, r = 9 m returns 1 cell, r = 12 m returns 5 (the 4 edge neighbours are 10 m away), r = 15 m returns 9 (diagonal neighbours are 14.1 m away).
6. **Prior:** ring prior sums to 1 with `outside`; mass decreases with distance on average.
7. **Canopy:** a solid-green flat image → low canopy (no texture); a black image → canopy 1 (shadow); a noisy green image → high canopy.
8. **Held for review:** cells within a candidate's radius get pod 0 in `frame_step`.
9. **Simulation:** with seed 7 the result is identical across two runs; canopy-aware ≤ naive on median cells for a fixture where half the covered cells are forest.

---

## 8. Fallbacks

| Problem | Fallback |
|---|---|
| Ring numbers not found | Placeholder prior, labelled "placeholder prior" in the UI. |
| Canopy classifier poor (MAE > 0.3) | Report the MAE; still use it. Mention it in the pitch as a known limitation. |
| Step animation too slow or buggy | Show `final` only; hide the slider. (Third on the team cut list.) |
| B's projection late | Your own straight-down projection with the same signature, swapped in later. |

---

## 9. Your screen: heatmap and "search next" (hours 18–26)

You own `web/src/map/heat/` and `web/src/search/`. B owns the map itself; you add layers through `useMap()`. D's review queue calls your store. Shell and look: `05_FRONTEND_SHARED.md`.

- **Store** (`web/src/search/store.ts`, Zustand, hook `useSearch`): holds only `stepIndex` and the derived map state. Review answers are **not** stored here: derive them from D's `useReview` ordered answer history, so undo, reset and page reloads keep the pins and the heatmap in agreement. Derived state = `replay(prior, steps, stepIndex)`, then each "not a person" answer in history order; `found` = any "person" answer. Subscribe to `useReview` and recompute when its history changes. Until D's store exists, code against this interface and stub it:
  ```ts
  interface ReviewHistoryEntry { detectionId: string; answer: "person" | "not_person" | "unsure"; at: string }
  interface ReviewState { history: ReviewHistoryEntry[] }   // useReview.getState().history
  ```
- **Heat layer** (`HeatLayer.tsx`): GeoJSON of all 2,500 cell polygons, built once, with layer ids prefixed `heat-`. Fill colour = accent orange; opacity ∝ `p / max(p)` from 0 to 0.75; cells below 2% of the max fully transparent. Re-colour via feature state when the state changes; don't rebuild the GeoJSON.
- **Surveyed area:** a thin outline of the union of footprints, labelled "Surveyed".
- **Step slider** (`StepSlider.tsx`): 0…N frames, with play/pause. Shows "After frame 212 of 500".
- **Search next panel** (`NextSearch.tsx`): the top 5 cells now, each with its probability as a percentage, canopy ("dense forest" / "open"), and distance from the LKP. Plus three shares: inside the surveyed area, rest of grid, outside the grid. Clicking a cell flies the map there.
- **Legend:** "Less likely → More likely" with the colour ramp, plus "Placeholder prior" if applicable.
- **Found state:** when a "Person" answer exists in the history, show a "Person confirmed: dispatch ground team" banner with coordinates and highlight that pin. Don't freeze the slider or block later answers; the demo scrubs the map after the first confirmation.

---

## 10. Your part of the pitch

About 20 seconds, the reveal: "Finding nobody still tells you something." Scrub the slider so open ground fades and forest stays bright. Then the simulated result: cells to search with our map vs. the naive map, clearly labelled simulated.

---

## 11. For Claude (instructions when this file is given to Claude Code)

- You are working on **lane C** only. Edit `sightline/search/`, `tests/search/`, `web/src/search/`, `web/src/map/heat/`. Don't touch other lanes' folders, `sightline/contract.py` or `web/src/contract.ts`.
- **Tests first** for every formula in §3; the three-cell example is mandatory.
- Compute in float64. Serialise per §6.3: pods, canopy and top-cell p rounded to 4 decimals; prior and final unrounded. Never let a probability reach exactly 0 (use `pod_cap`).
- The search map's review state comes from D's `useReview` history; don't keep a second copy of review answers.
- Grid conventions (row 0 = north, col 0 = west, `[lon, lat]` polygons) are in contract §8. Don't change them.
- Python and TypeScript updates must stay identical: if you change one, regenerate the vectors and run both test suites.
- Don't invent prior ring numbers. Use the placeholder until real, cited numbers are provided.
- Before finishing: `uv run pytest tests/search`, `uv run ruff check sightline/search`; for web work, `pnpm test` and `pnpm build`.
- Good first prompts:
  1. "Read docs/LANE_C_SEARCH.md §3 and §7. Write tests 1–6, then implement `grid.py`, `prior.py` (placeholder) and `update.py`."
  2. "Implement `canopy.py` per §3.3 and a tuning script per §6.2 using `tests/search/fixtures/canopy_labels.json`."
  3. "Implement `update.ts` per §6.5 and the vector generator; make vitest pass."
