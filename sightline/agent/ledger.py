""" "Did the observation help": expected vs realised value of every second look and every leg.

Active perception asks a system to compare the value it predicted for an observation with the
improvement the observation actually brought (arXiv 2512.03687, §3.3.2). The agent writes one
``ledger`` record per observation into the trace (a ``note`` entry whose ``output.type`` is
``"ledger"``: the contract's trace kinds are a closed list, so no new kind is added):

    {"type": "ledger", "chain_id", "kind": "second_look" | "leg",
     "expected": {..., "gain"}, "realised": {..., "gain"}, "delta": realised.gain - expected.gain}

Both sides carry the cell probability under the spot (``cell_p``) and the sector's share and
``expected_clearance`` (``sector``), read before and after. ``gain`` is the one number compared:

- **second look**: ``expected.gain`` is the share of second looks that gave a decisive verdict
  (yes or no) on val for a box of that size (``DECISIVE_SHARE``, prompt verify-v2); ``realised.gain``
  is 1 for a decisive verdict, 0 for ``unclear``. A verdict moves no probability by itself (the map
  changes on photos and reviews), so ``cell_p`` before and after are normally equal: a second look's
  value is in the decision it allows.
- **leg**: ``expected.gain`` is the leg's ``expected_clearance`` (Σ p_i · POD_i, the planner's
  prediction, with unknown canopy at 0.5); ``realised.gain`` is the same sum on the map as it was when
  the leg was proposed, with the POD the leg's photos actually gave each cell (their frame steps
  in the map log: coverage, measured canopy, visibility, cells held for a candidate):
  Σ p_i · (1 − Π_photos (1 − pod_i)). Same units, same prior, so the difference is the prediction's
  error, not other drones' evidence. Written when the leg is done; the expected side is taken when
  it is proposed and kept on the proposal's trace entry (``ledger_expected``).
"""

from __future__ import annotations

import contextlib
import io
import math
from typing import Any

import numpy as np

from sightline.agent.trace import trace_call
from sightline.contract import LatLon, Leg

SMALL_PX = 60  # long side of the box in original-photo pixels (OPENCV_REPORT §5.4, §10)
# Decisive verdicts (yes or no) among second looks on val, prompt verify-v2, by the box's long side
# in original pixels: runs/verifier/val-verify-v2-20261020-165932.csv (37/75 and 68/95).
DECISIVE_SHARE = {"under_60px": 37 / 75, "60px_up": 68 / 95}
SOURCE = "val verify-v2 (runs/verifier/val-verify-v2-20261020-165932)"


def _r(x: float | None, nd: int = 6) -> float | None:
    return None if x is None else round(float(x), nd)


def decisive_share(long_px: float) -> float:
    return DECISIVE_SHARE["under_60px" if long_px < SMALL_PX else "60px_up"]


def box_long_px(store: Any, mission_id: str, det: Any, frame: Any) -> int:
    """The box's long side in original-photo pixels (the size the 60 px finding is in): the frame
    box scaled by the original's size over the frame's (D-P1 keeps it at ``frames/orig/``), else in
    frame pixels."""
    x1, y1, x2, y2 = det.box_px
    from PIL import Image

    sx = sy = 1.0
    # no original (demo frames are native cuts): frame pixels
    with contextlib.suppress(KeyError, FileNotFoundError, OSError, ValueError):
        data = store.read_file(mission_id, f"frames/orig/{frame.id}.jpg")
        with Image.open(io.BytesIO(data)) as im:
            sx, sy = im.width / frame.width_px, im.height / frame.height_px
    return round(max((x2 - x1) * sx, (y2 - y1) * sy))


def _layout(store: Any, mission_id: str) -> tuple[Any, Any]:
    from sightline.search.sectors import lattice_sectors

    live = store.live(mission_id)
    return live, lattice_sectors(live.base.grid)


def _visibility(store: Any, mission_id: str) -> float:
    c = store.state(mission_id)["conditions"]
    return c.visibility_factor if c is not None else 1.0


def _map_seq(store: Any, mission_id: str) -> int:
    updates = store.map_updates(mission_id)
    return updates[-1].seq if updates else 0


def _cell_index(grid: Any, at: LatLon) -> int | None:
    from sightline.search.grid import cell_containing

    rc = cell_containing(grid, at)
    return None if rc is None else rc[0] * grid.cols + rc[1]


def snapshot(
    store: Any, mission_id: str, at: LatLon | None = None, sector_id: str | None = None
) -> dict:
    """The map around a spot (or a sector) now: ``cell_p`` of the cell under ``at``, the sector's
    share (``poa``) and ``expected_clearance`` (Σ p · POD over it), and the map log's last ``seq``."""
    from sightline.search.planner import expected_on_cells

    live, layout = _layout(store, mission_id)
    grid = live.base.grid
    p = live.p()[0]
    idx = _cell_index(grid, at) if at is not None else None
    if sector_id is None and idx is not None:
        sector_id = layout.sectors[int(layout.cell_sector[idx])].id
    out: dict[str, Any] = {"cell_p": _r(p[idx], 8) if idx is not None else None}
    if sector_id is not None:
        cells = layout.cells_of(sector_id)
        out["sector"] = {
            "id": sector_id,
            "poa": _r(p[cells].sum()),
            "expected_clearance": _r(
                expected_on_cells(cells, live, _visibility(store, mission_id))
            ),
        }
    out["map_seq"] = _map_seq(store, mission_id)
    return out


def _write(
    store: Any, mission_id: str, chain_id: str, kind: str, expected: dict, realised: dict, refs
) -> dict:
    delta = _r(realised["gain"] - expected["gain"])
    record = {
        "type": "ledger",
        "chain_id": chain_id,
        "kind": kind,
        "expected": expected,
        "realised": realised,
        "delta": delta,
    }
    trace_call(
        store,
        mission_id,
        actor="agent",
        kind="note",
        summary=(
            f"ledger {kind} ({chain_id}): expected gain {expected['gain']:.4f}, "
            f"realised {realised['gain']:.4f} (delta {delta:+.4f})"
        ),
        output=record,
        refs=[chain_id, *refs],
    )
    return record


def record_second_look(
    store: Any,
    mission_id: str,
    chain_id: str,
    det: Any,
    verdict: Any,
    long_px: int,
    before: dict,
    after: dict,
) -> dict:
    """The ledger record of one second look (``before``/``after``: ``snapshot`` either side)."""
    expected = {
        **before,
        "gain": _r(decisive_share(long_px), 4),
        "gain_is": f"P(decisive verdict) for a {long_px} px box, {SOURCE}",
        "box_long_px": long_px,
    }
    realised = {
        **after,
        "gain": 1.0 if verdict.person in ("yes", "no") else 0.0,
        "gain_is": "1 if the verdict was yes or no, 0 if unclear",
        "verdict": verdict.person,
    }
    return _write(
        store, mission_id, chain_id, "second_look", expected, realised, [det.id, verdict.id]
    )


def leg_expected(store: Any, mission_id: str, leg: Leg, region: dict | None = None) -> dict:
    """What a leg is expected to bring, when it is proposed: kept on its proposal's trace entry.
    ``region``: ``{"lat", "lon", "radius_m"}`` for a leg over one spot (a re-look); else the
    leg's sector."""
    at = LatLon(lat=region["lat"], lon=region["lon"]) if region else None
    snap = snapshot(store, mission_id, at, leg.sector_id)
    return {**snap, "region": region, "gain": _r(leg.expected_clearance)}


def _region_cells(grid: Any, layout: Any, leg: Leg, region: dict | None) -> np.ndarray:
    from sightline.search.grid import cells_within_radius

    if region:
        at = LatLon(lat=region["lat"], lon=region["lon"])
        return np.asarray(cells_within_radius(grid, at, region["radius_m"]), dtype=np.int64)
    return np.asarray(layout.cells_of(leg.sector_id), dtype=np.int64)


def _proposal_entry(store: Any, mission_id: str, leg_id: str) -> Any:
    for e in reversed(store.trace_entries(mission_id)):
        out = e.output or {}
        if e.kind == "proposal" and (out.get("target") or {}).get("leg") == leg_id:
            return e
    return None


def _leg_frames(store: Any, mission_id: str, leg: Leg, cells: set[int], after_seq: int) -> list:
    """Frame steps in the map log after ``after_seq`` from this leg's photos: taken at the leg's
    altitude, centred on a cell of its region (the planner never puts two drones on one sector)."""
    grid = store.live(mission_id).base.grid
    frames = {f.id: f for f in store.survey(mission_id).frames}
    out = []
    for u in store.map_updates(mission_id, after_seq):
        f = frames.get(u.ref or "")
        if u.source != "frame" or f is None:
            continue
        alt = f.pose.alt_agl_m
        if alt is not None and abs(alt - leg.altitude_m) > 1.0:
            continue
        if _cell_index(grid, LatLon(lat=f.pose.lat, lon=f.pose.lon)) in cells:
            out.append(u)
    return out


def record_leg(store: Any, mission_id: str, leg: Leg, chain_id: str | None = None) -> dict | None:
    """The ledger record of a flown leg (called when it is done). ``None`` for a leg with no
    sector (a recall) or with no expected side on its proposal (a scripted leg)."""
    from sightline.search.live import LiveMap

    if leg.sector_id is None:
        return None
    entry = _proposal_entry(store, mission_id, leg.id)
    expected = (entry.output or {}).get("ledger_expected") if entry else None
    if not expected:
        return None
    live, layout = _layout(store, mission_id)
    region = expected.get("region")
    cells = _region_cells(live.base.grid, layout, leg, region)
    then = LiveMap.from_base(live.base)  # the map as it was when the leg was proposed
    for u in store.map_updates(mission_id):
        if u.seq > expected["map_seq"]:
            break
        then.apply(u)
    p0 = then.p()[0]
    miss = np.ones(len(p0))
    steps = _leg_frames(store, mission_id, leg, set(cells.tolist()), expected["map_seq"])
    for u in steps:
        for i, pod in u.cells:
            miss[i] *= 1.0 - pod
    gain = float(np.sum(p0[cells] * (1.0 - miss[cells])))
    at = LatLon(lat=region["lat"], lon=region["lon"]) if region else None
    realised = {
        **snapshot(store, mission_id, at, leg.sector_id),
        "gain": _r(gain),
        "gain_is": "sum of p (as proposed) x the POD the leg's photos gave each cell",
        "photos": len(steps),
        "cells_seen": int(np.count_nonzero(miss[cells] < 1.0)),
        "cells": int(cells.size),
    }
    return _write(
        store, mission_id, chain_id or f"leg-{leg.id}", "leg", expected, realised, [leg.id]
    )


def summarise(records: list[dict]) -> dict:
    """Mean expected and realised gain, and their Pearson correlation, per kind."""
    out = {}
    for kind in ("second_look", "leg"):
        rs = [r for r in records if r.get("kind") == kind]
        e = [r["expected"]["gain"] for r in rs]
        g = [r["realised"]["gain"] for r in rs]
        corr = None
        if len(rs) >= 3 and np.std(e) > 0 and np.std(g) > 0:
            corr = float(np.corrcoef(e, g)[0, 1])
        out[kind] = {
            "n": len(rs),
            "mean_expected": float(np.mean(e)) if rs else None,
            "mean_realised": float(np.mean(g)) if rs else None,
            "corr": None if corr is None or math.isnan(corr) else corr,
        }
    return out
