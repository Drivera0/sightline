# CLAUDE.md: Sightline

Sightline is a hackathon project (BCS Hackathon 2026, 24 hours, 4 people). It finds people in search-and-rescue drone photos, ranks the photos for human review, pins detections on a map, and keeps a Bayesian probability map of where the missing person could still be.

## Read before working

1. `docs/00_OVERVIEW.md`: the project, lanes, timeline, rules.
2. `docs/01_CONTRACT.md`: **the exact shapes of every file lanes exchange. Never deviate from it.**
3. The lane file for the work you're asked to do:
   - `docs/LANE_A_ML.md`: `sightline/ml/`, `scripts/` (data prep), `tests/ml/`, `web/src/metrics/`
   - `docs/LANE_B_GEO.md`: `sightline/geo/`, `tests/geo/`, `web/src/map/MapView.tsx`, `web/src/map/base/`
   - `docs/LANE_C_SEARCH.md`: `sightline/search/`, `tests/search/`, `web/src/search/`, `web/src/map/heat/`
   - `docs/LANE_D_PIPELINE.md`: `sightline/contract.py`, `sightline/pipeline/`, `sightline/api/`, `tests/pipeline/`, repo config files, `web/src/shell/`, `web/src/lib/`, `web/src/review/`, `web/` config
4. `docs/05_FRONTEND_SHARED.md` for any work under `web/`.

If the user hasn't said which lane they're on, ask before editing.

## Hard rules

- **Stay inside the lane's folders.** Don't edit another lane's code. If a change there is needed, stop and explain what's needed and why.
- **Never edit `sightline/contract.py` or `web/src/contract.ts`** unless working on lane D, either implementing contract v1.0 before the hour-3 freeze or making an agreed contract change (see `01_CONTRACT.md` §10). `web/src/contract.ts` is generated; never hand-edit it.
- **Only the pipeline writes to `cache/`.** Lane code returns contract objects (Pydantic models from `sightline.contract`); it doesn't write cache files itself.
- **Never put ground truth in the cache** (true person boxes, which frames contain people).
- **Never commit** anything under `data/`, `cache/demo/`, model weights (`*.pt`), `.env`, or API keys.
- **Labels for simulated things are required** in UI text: the flight path, the search-map evaluation and the 10 m position radius.
- Don't invent numbers for metrics, the UI or docs. Numbers come from `metrics.json` or a cited source.

## Commands

```bash
uv sync                          # core deps (all lanes)
uv sync --extra ml               # + torch/ultralytics/sahi (lane A, GPU desktop)
uv run pytest tests/<lane>       # run a lane's tests
uv run ruff check . && uv run ruff format .
uv run python -m sightline.pipeline sample           # regenerate cache/sample
uv run python -m sightline.pipeline run --stages all --out cache/demo
uv run python -m sightline.pipeline validate cache/demo

cd web && pnpm install && pnpm dev                   # website (VITE_CACHE_DIR=sample|demo)
cd web && pnpm test                                  # vitest
cd web && pnpm gen:contract                          # regenerate src/contract.ts (lane D)
```

## Conventions

- Python 3.11, type hints everywhere, `pathlib.Path` for paths. Contract models (`sightline.contract`, Pydantic v2) for anything that ends up in the cache; frozen dataclasses are fine for in-process arguments between lanes (e.g. `Box`, `RawDetection`, `Grid`, `FrameInput`).
- Pure functions where possible; file I/O at the edges (pipeline stages, CLI).
- Deterministic: every random choice takes a `seed` argument (default from config).
- Tests: `pytest`, no network, no GPU, small fixtures in `tests/<lane>/fixtures/`. Write the test first for any math.
- Units in names (`_m`, `_deg`, `_px`). Coordinates per `01_CONTRACT.md` §2: polygons are `[lon, lat]`.
- TypeScript: strict mode; React function components; state in Zustand; no `any` for contract data. Import types from `src/contract.ts`.

## How to finish a task

1. Run the lane's tests and `ruff`.
2. If you touched pipeline output, run `python -m sightline.pipeline validate` on the affected cache.
3. If you touched the web app, run `pnpm test` and `pnpm build`.
4. Summarise what changed, what you tested, and anything the lane owner must decide.
