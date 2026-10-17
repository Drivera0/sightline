# Sightline

Sightline finds the hiker in hundreds of search-and-rescue drone photos, then shows the rescue team where to look next. A detector ranks the photos, each detection becomes a pin on a map, and a Bayesian probability map updates after every photo. It assists searchers; it never decides that an area is clear. Built for BCS Hackathon 2026.

## Quick start

```bash
uv sync                                      # Python dependencies
uv run pytest                                # all tests
uv run python -m sightline.pipeline sample   # regenerate the fake sample cache
cd web && pnpm install && pnpm dev           # the website (reads web/public/cache/sample)
```

## Build the demo cache

```bash
uv run python -m sightline.pipeline run --stages all --out cache/demo
uv run python -m sightline.pipeline validate cache/demo
cd web && VITE_CACHE_DIR=demo pnpm dev
```

`run` has eight stages: frames, place, detect, georef, rank, map, metrics, export. Each stage reads
and writes `data/`, so you can run one alone (`python -m sightline.pipeline place`) or skip one
(`--skip detect` after copying `data/work/detect/` from the GPU desktop).

If a lane's function does not exist yet, its stage writes a labelled **placeholder** and says so in
the command output and in `manifest.json`. See `docs/LANE_INTERFACES.md` for what the pipeline
expects from lanes A, B and C.

## Upload API (optional)

```bash
uv run python -m sightline.pipeline serve --weights data/weights/best.pt
curl -F file=@photos.zip http://127.0.0.1:8000/survey      # returns an id; check GET /survey/<id>
```

A zip of JPEGs becomes `cache/upload-<id>/` (frames are resized to 1000×750). The API has no login:
keep it on `127.0.0.1` or a trusted network.

## Docs

- `docs/00_OVERVIEW.md`: the project, lanes and timeline. Read this first.
- `docs/01_CONTRACT.md`: the exact shape of every file the lanes exchange.
- `docs/LANE_INTERFACES.md`: the functions the pipeline calls in other lanes (draft).
- `docs/05_FRONTEND_SHARED.md`: the shared website rules and look.
- `CLAUDE.md`: rules for Claude Code in this repo.

Every number on screen comes from `metrics.json` or a cited source. Anything simulated (the flight
path, the search-map evaluation, the 10 m position uncertainty) is labelled simulated.

## Attribution

Imagery from the HERIDAL dataset (Božić-Štulić, Marušić & Gotovac, 2019), VOC-format copy by Pyrrö (2021), CC BY 3.0.
