"""Build the terrain affinity raster for a mission grid (sightline/geo/terrain_affinity.py).

    uv run python scripts/build_terrain_affinity.py                      # the demo map's grid
    uv run python scripts/build_terrain_affinity.py --lkp 49.375,-122.9375 --size 1000 --cell 5
    uv run python scripts/build_terrain_affinity.py --figures            # + before/after PNGs

Reads the offline basemap (``web/public/basemap/northshore.pmtiles``, Protomaps v4 vector tiles:
roads with kind "path" are trails, water lines are streams, water polygons, earth cliff lines and
landuse bare rock) in the grid's bounding box plus 150 m. If the archive has none of the linear
layers there, it falls back to an OSM Overpass query, cached to disk next to the output with the
query saved (``overpass_query.txt``, ``overpass.json``); ``--overpass`` forces that path.

Writes ``web/public/cache/demo/terrain_affinity.json`` by default (gitignored, like the rest of the
demo cache). With ``--figures``, also renders the demo prior without and with the affinity
(``docs/report/figures/v3/prior_rings.png``, ``prior_rings_terrain.png``) and prints the 4 × 4
sector POA table before and after.
"""

from __future__ import annotations

import argparse
import json
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
PMTILES = ROOT / "web/public/basemap/northshore.pmtiles"
DEMO = ROOT / "web/public/cache/demo"
FIGURES = ROOT / "docs/report/figures/v3"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"


def _grid(args: argparse.Namespace):
    from sightline.contract import Grid, LatLon
    from sightline.search.grid import make_grid

    if args.lkp:
        lat, lon = (float(x) for x in args.lkp.split(","))
        lkp = LatLon(lat=lat, lon=lon)
        return make_grid(lkp, args.size, args.cell), lkp
    m = json.loads(Path(args.map).read_text())
    return Grid.model_validate(m["grid"]), LatLon.model_validate(m["lkp"])


def _overpass(bbox: tuple[float, float, float, float], cache: Path) -> dict:
    from sightline.geo.terrain_affinity import OVERPASS_QUERY

    w, s, e, n = bbox
    query = OVERPASS_QUERY.format(w=w, s=s, e=e, n=n)
    cache.mkdir(parents=True, exist_ok=True)
    (cache / "overpass_query.txt").write_text(query)
    hit = cache / "overpass.json"
    if hit.is_file():
        doc = json.loads(hit.read_text())
        if doc.get("query") == query:
            return doc["answer"]
    req = urllib.request.Request(
        OVERPASS_URL,
        data=urllib.parse.urlencode({"data": query}).encode(),
        headers={"User-Agent": "sightline-terrain-affinity"},
    )
    with urllib.request.urlopen(req, timeout=90) as r:  # a fixed https URL
        answer = json.loads(r.read())
    hit.write_text(json.dumps({"query": query, "answer": answer}))
    return answer


def build(args: argparse.Namespace):
    from sightline.geo.terrain_affinity import (
        affinity_raster,
        features_from_overpass,
        features_from_pmtiles,
        grid_bbox,
    )

    grid, lkp = _grid(args)
    bbox = grid_bbox(grid)
    out = Path(args.out)
    feats = None
    source = ""
    if not args.overpass:
        feats = features_from_pmtiles(args.pmtiles, bbox)
        source = f"{Path(args.pmtiles).name} (Protomaps v4, OSM), z15 tiles over the grid + 150 m"
        if not (feats.trails or feats.roads or feats.streams):
            print("the basemap has no trails, roads or streams here: falling back to Overpass")
            feats = None
    if feats is None:
        feats = features_from_overpass(_overpass(bbox, out.parent))
        source = f"OSM Overpass ({OVERPASS_URL}), query in {out.parent / 'overpass_query.txt'}"
    aff = affinity_raster(grid, feats, source)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(aff.to_json()))
    m = aff.multiplier
    print(f"features: {feats.counts()}")
    print(
        f"wrote {out}: {grid.rows}×{grid.cols} cells of {grid.cell_m:g} m, multiplier "
        f"min {m.min():.2f} median {np.median(m):.2f} max {m.max():.2f} (mean {m.mean():.3f})"
    )
    return grid, lkp, aff


def _render(grid, lkp, p: np.ndarray, title: str, path: Path, layout, vmax: float) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    from sightline.search.grid import latlon_to_local_m

    img = p.reshape(grid.rows, grid.cols)
    size = grid.cols * grid.cell_m
    fig, ax = plt.subplots(figsize=(4.6, 4.2), dpi=110)
    im = ax.imshow(
        img / grid.cell_m**2 * 1e4,  # per hectare
        extent=(0, size, grid.rows * grid.cell_m, 0),
        cmap="magma",
        vmin=0.0,
        vmax=vmax,
        interpolation="nearest",
    )
    for s in layout.sectors:
        r = s.rect
        ax.add_patch(
            plt.Rectangle(
                (r["east_min"], r["south_min"]), r["east_max"] - r["east_min"],
                r["south_max"] - r["south_min"], fill=False, lw=0.4, ec="white", alpha=0.5,
            )
        )  # fmt: skip
        ax.text(r["east_min"] + 12, r["south_min"] + 40, s.id, color="white", fontsize=6, alpha=0.8)
    e, sm = latlon_to_local_m(grid, lkp)
    ax.plot([e], [sm], marker="+", color="cyan", ms=9, mew=1.5)
    ax.set_title(title, fontsize=8)
    ax.set_xlabel("metres east", fontsize=7)
    ax.set_ylabel("metres south", fontsize=7)
    ax.tick_params(labelsize=6)
    cb = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.03)
    cb.set_label("probability per hectare", fontsize=7)
    cb.ax.tick_params(labelsize=6)
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, format="png", dpi=110)
    plt.close(fig)
    print(f"wrote {path} ({path.stat().st_size // 1024} KB)")


def figures(grid, lkp, aff, category: str) -> None:
    from sightline.search.prior import koester_prior
    from sightline.search.sectors import lattice_sectors

    layout = lattice_sectors(grid)
    before, out_b = koester_prior(grid, lkp, category)
    after, out_a = koester_prior(grid, lkp, category, affinity=aff)
    vmax = float(max(before.max(), after.max())) / grid.cell_m**2 * 1e4  # one scale for both
    _render(grid, lkp, before, f"Demo prior: {category} rings (no terrain)",
            FIGURES / "prior_rings.png", layout, vmax)  # fmt: skip
    _render(grid, lkp, after, f"Demo prior: {category} rings × terrain affinity",
            FIGURES / "prior_rings_terrain.png", layout, vmax)  # fmt: skip
    print(f"\noutside: {out_b:.4f} before, {out_a:.4f} after; in-grid {before.sum():.4f} both")
    print("\n| Sector | POA rings | POA rings × terrain | Change | Mean multiplier |")
    print("|---|---|---|---|---|")
    rows = []
    for s in layout.sectors:
        cells = layout.cells_of(s.id)
        b, a = float(before[cells].sum()), float(after[cells].sum())
        rows.append((s.id, b, a, float(aff.multiplier[cells].mean())))
    for sid, b, a, m in sorted(rows, key=lambda r: -r[2]):
        print(f"| {sid} | {b:.2%} | {a:.2%} | {(a - b) * 100:+.2f} pt | {m:.2f} |")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--map", default=str(DEMO / "map.json"), help="a map.json for the grid + LKP")
    ap.add_argument("--lkp", help="lat,lon: a new grid centred here instead of --map")
    ap.add_argument("--size", type=float, default=1000.0)
    ap.add_argument("--cell", type=float, default=5.0)
    ap.add_argument("--pmtiles", default=str(PMTILES))
    ap.add_argument("--out", default=str(DEMO / "terrain_affinity.json"))
    ap.add_argument("--overpass", action="store_true", help="use OSM Overpass, not the basemap")
    ap.add_argument("--figures", action="store_true", help="render the demo prior before/after")
    ap.add_argument("--category", default="hiker/temperate_mountainous")
    args = ap.parse_args(argv)
    grid, lkp, aff = build(args)
    if args.figures:
        figures(grid, lkp, aff, args.category)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
