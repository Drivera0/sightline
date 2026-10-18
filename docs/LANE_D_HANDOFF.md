# Lane D handoff

Written 2026-10-17 ~19:00 when lane D passed to lane A. Branch `lane-d`. Read with
`LANE_D_PIPELINE.md` (the plan), `LANE_INTERFACES.md` (what the pipeline calls in other lanes)
and `01_CONTRACT.md`.

## 1. State

### Done (tested, pushed)

- **Contract** `sightline/contract.py`: every model in `01_CONTRACT.md`, rounding on write
  (`dump_json`), JSON Schema for `web/src/contract.ts` (`pnpm gen:contract`). A test fails if the
  committed schema is out of date.
- **Sample cache** `write_sample` → `cache/sample` and `web/public/cache/sample` (20 synthetic
  frames, marked SAMPLE). **Validation** `validate_cache` (contract §11). **Export** `export_cache`
  (builds in a staging folder, validates, then replaces; never writes a failing cache).
- **Survey builder** `cut_frames`, `build_survey`, `write_survey` (`sightline/pipeline/survey.py`).
- **All 8 stages** `frames place detect georef rank map metrics export` (`stages.py`), `run`
  with timings, `--skip`, manifest notes (`runner.py`), CLI (`__main__.py`, one command per stage
  plus `run`, `validate`, `sample`, `serve`).
- **Lane seam** `lanes.py`: finds each lane function, adapts what it returns, else uses a labelled
  placeholder and records it in the manifest. Intermediate files: `formats.py`.
- **Map rules** `mapmath.py`: pods rounded to 4 d.p., pods < 0.001 dropped, `final` and
  `top_cells` recomputed by replaying the steps, so the §11 replay check always holds.
- **Lane C requests 1–3**: `MapFrame.candidates`, frame cells `(idx, canopy, overlap)`,
  `recall_source` as 4th `build_map` argument. Lane C's **native** signatures from
  `LANE_C_SEARCH.md` are also supported (see §3).
- **Real run** with `weights-v1`, threshold 0.21, on this machine (MPS, 61 s for 500 frames):
  39 detections, 15 candidates, all 6 true-person frames in the queue. First hit ranked 1 vs 73 in
  flight order (71.6 random); all hits in the top 7 vs 420. `cache/demo` validates.
- **Web** (lane D parts): shell (tabs, header badges, `?` overlay, `ScreenBoundary`,
  `CacheContext`), review queue (`review/`: store with history/undo/localStorage, keys
  J/K/P/N/U/Z/Enter/M, map sync through `useSelection`), Caveat font, MapLibre worker bundling,
  `pnpm check:offline`.
- **Stretch upload API** (`sightline/api/app.py`, `serve`): zip of JPEGs → `cache/upload-<id>/`.
  Streams frames to disk, size/count/pixel limits, 400 on bad input. No login: localhost only.
- **Merged into lane-d**: lane A up to `7343fa5`, lane B up to `9beeec7`. **Not** lane C (see §2).

### Half done / next

1. **Lane C's `build_map` has not landed.** As of `5b08ffe` lane C has `make_grid`,
   `placeholder_prior`, `ring_prior`, `FrameInput`, `simulate`, but no `build.py`. Until it lands,
   `map.json` is a uniform prior with empty steps and `search_sim` is zeros (both labelled).
   When it lands: merge `origin/lane-c` (only `.gitignore` conflicts; keep both sets, adding
   `.pnpm-store/`), run `pytest`, then `run`. A test merge at `6cfaafd` passed 501 tests, and
   lane C's `make_grid` gives exactly the pipeline's grid.
2. **weights-v2** (~20:30, same file names, new tag):
   `gh release download weights-v2 -R Drivera0/sightline -D data/weights -p yolo11s_tiles_run1_best.pt`
   (check the real name in the release) and `-D data/work/detect -p detector_metrics.json`, check
   the MD5s in the release notes, then `run` again. Recall reaches `map.json` only through
   `detector_metrics.json`.
3. **Lane C requests 4–5 are open**: a contract field for the placeholder prior (needs the team,
   §10 of the contract says bump the version) and 24 vs 36 hours (team decision).
4. **No pull request** `lane-d` → `main` yet. The branch is very large (~9,500 lines);
   suggested split: contract+sample, survey+rank, stages+CLI, API, shell, review queue.

## 2. How to run

```bash
uv sync --extra ml                       # ML extra needed for real detection
uv run pytest                            # all lanes (447 tests at hand-off)
cd web && pnpm install && pnpm test && pnpm build && pnpm check:offline   # 149 web tests

# data (git-ignored)
gh release download data-v1 -R Drivera0/sightline -p heridal_test_split.zip   # unzip into data/heridal/yolo_full/
gh release download weights-v1 -R Drivera0/sightline -D data/weights -p yolo11s_tiles_run1_best.pt
gh release download weights-v1 -R Drivera0/sightline -D data/work/detect -p detector_metrics.json

# the demo cache
uv run python -m sightline.pipeline run --weights data/weights/yolo11s_tiles_run1_best.pt \
  --candidate-threshold 0.21 --model-name yolo11s-heridal-tiled --out cache/demo
uv run python -m sightline.pipeline validate cache/demo
cd web && VITE_CACHE_DIR=demo pnpm dev
```

- **Frames**: `python -m sightline.pipeline frames` → `data/survey/frames/f0001…f0500.jpg`,
  seed 7, 500 frames, 6 with people, from `data/heridal/yolo_full/test`. Selection and ids are
  fixed by the seed and the split; JPEG bytes can differ between Pillow versions.
  `frames.json` SHA-256 at hand-off starts `96d6560b72e3ab3a`.
- **Tests use** `cache/sample` and temporary folders only. `run` also copies to
  `web/public/cache/demo` unless you pass `--web-out` (see §4).
- `--skip detect` reuses a copied `data/work/detect/`.

## 3. Promises to other lanes

- **Lane C**: the adapter accepts both `build_map(frames, lkp, recall, recall_source)` and the
  native `build_map(grid, lkp, prior, frames, recall, recall_source)` (recognised by a first
  parameter named `grid`), and both `simulate(map_file, frame_cells)` and the native one (has
  `trials` or `vis_noise`). The pipeline builds `grid` with lane C's `make_grid`, the prior with
  `placeholder_prior` (noted as a placeholder in the manifest), and `FrameInput` by keyword. Cells
  go to `simulate` in flight order, unknown canopy as 0.0. `recall_source` is
  `"metrics.detector.recall"` or `"placeholder"`. Details: `LANE_INTERFACES.md`.
- **Lane B**: nothing open. Its `simulate_flight`, `footprint`, `georef_detection` are used as is;
  footprints and georef match the pipeline's fallback math exactly.
- **Lane A**: re-run with weights-v2; nothing to send back.
- **Vercel / hosting**: not set up. The demo runs offline from `pnpm build && pnpm preview`.

## 4. Fragile or surprising

- **8 web tests use `demo` as a folder that does not exist** (`lib/cache.test.ts`, `App.test.tsx`).
  They fail while `web/public/cache/demo/` exists. Fixing them means changing tests, which needs
  the team's OK. Until then: `run --web-out <elsewhere>` while testing, or remove the folder.
- **The adapter decides by parameter names** (`grid`, `trials`/`vis_noise`, `root` for
  `load_split`, a 4th positional for `recall_source`). Renaming a parameter in another lane changes
  which path is taken. The tests in `tests/pipeline/test_lane_c_native*.py` show each shape.
- **`normalise_map` replaces lane C's `final` and `top_cells`** with a replay of the rounded steps.
  That is on purpose (contract §8, §11).
- **Every merge conflicts on `.gitignore`** because every lane edits it. Keep both sets of lines.
- **Format only lane D paths** (`ruff format sightline/pipeline sightline/api sightline/contract.py
  tests/pipeline`); `ruff format .` reformats other lanes' files.
- **The upload API has no login.** Keep `serve` on `127.0.0.1`.
- **Personal rules** live in `CLAUDE.local.md` (git-ignored); `CLAUDE.md` is the team version.

## 5. Non-code list (from `LANE_D_PIPELINE.md` §6.5 and §10)

- [ ] Backup video of the 60-second demo (screen + voice) by hour 28.
- [ ] Devpost write-up: problem, what it does, how we built it, honest limits (simulated flight
      path, simulated search evaluation, any placeholders left), HERIDAL attribution, team.
- [ ] Three timed rehearsals of the click path in `05_FRONTEND_SHARED.md` §7.
- [ ] Pitch opener: ask the team for a personal origin story (not received yet).
- [ ] Run the full click path on the presenting laptop with Wi-Fi **off**, at 1440×900 and on a
      1080p projector.
- [ ] Check the event's prize tracks.

## 6. The public website (added after hand-off)

- **Live:** https://sightline-iota-sandy.vercel.app (Vercel project `sightline`, team "Driver0's projects").
- **Auto-deploy:** every push to `lane-d` builds and publishes it (switch the production branch to
  `main` in Vercel → Settings → Environments → Production once lane-d is merged). Pushes to other
  branches make preview builds behind Vercel login.
- **How the build gets data:** `web/vercel.json` downloads `demo-cache.tar.gz` from the `demo-cache`
  GitHub release into `web/public/cache/`, then runs `VITE_CACHE_DIR=demo pnpm build`. The cache is
  git-ignored, so **new demo data needs a re-upload**, then any push (or "Redeploy" in Vercel):
  `tar -czf data/demo-cache.tar.gz -C cache demo && gh release upload demo-cache data/demo-cache.tar.gz -R Drivera0/sightline --clobber`
- `web/scripts/vercel.test.ts` checks the build command keeps the download and the demo build.
