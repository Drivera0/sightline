"""The uncertainty-driven re-look leg: an ``unclear`` second look on a small box sends a drone lower.

Under 60 px (the box's long side in original-photo pixels) the VL model mostly answers ``unclear``
(OPENCV_REPORT §5.4: 65 % of such crops on test; ``ledger.DECISIVE_SHARE`` on val). When that
happens on a near-miss (or on a second look a reviewer asked for by answering "unsure"), the agent
proposes a short ``drone_leg`` (``retask_drone`` when the drone it picks is flying) over the spot at
``RELOOK_ALT_M`` (25 m): from 50 m that is 2× the size, about 4× the pixels. It goes through the
normal approval path. The leg's photos come back through the normal pipeline: detector → second
look → verdict → promote. A photo taken at the re-look altitude is never re-looked again.

Every step is a trace ``note`` whose ``output.type`` is ``"relook"``, with the same ``chain_id``
(``relook-<detection id>``) in its output and refs, so the Trace tab can draw the chain:

    unclear  → the verdict, the box size, the altitude it was seen from, the spot
    leg      → the proposal, its leg, drone, altitude, pixel factor, minutes
    photo    → each photo of the leg over the spot (frame, altitude, detection near the spot)
    verdict  → the re-look photo's second look
    outcome  → resolved (yes / no), still unclear, or not seen again (no detection near the spot)
    skipped  → why no leg was proposed (not flyable, no drone)

The ledger (``ledger.py``) records the expected and realised value of each second look and leg.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from sightline.agent import ledger
from sightline.agent.trace import trace_call
from sightline.agent.verify import verify
from sightline.contract import EvidenceRef, LatLon, Leg, Proposal, Verdict

RELOOK_ALT_M = 25.0
RELOOK_MAX_PX = ledger.SMALL_PX  # 60 px long side, original pixels
RELOOK_SIDE_M = 20.0  # the square flown around the spot: two lines 10 m apart at 25 m
MATCH_M = 10.0  # a re-look photo's detection this close to the spot belongs to the chain
DEFAULT_ALT_M = 50.0  # when the photo has no altitude: the planner's survey altitude
NO_LOOK = "No second look"  # verify's reason when the model failed: flying lower won't help


@dataclass(frozen=True)
class Look:
    verdict: Verdict
    chain_id: str
    long_px: int
    altitude_m: float
    relook_photo: bool  # the photo was taken on a re-look leg of ``chain_id``


def chain_id_for(detection_id: str) -> str:
    return f"relook-{detection_id}"


def _metres(a: LatLon, b: LatLon) -> float:
    k = 111_320.0
    return math.hypot((a.lat - b.lat) * k, (a.lon - b.lon) * k * math.cos(math.radians(a.lat)))


def _step(store: Any, mission_id: str, chain_id: str, step: str, summary: str, refs, **out: Any):
    trace_call(
        store,
        mission_id,
        actor="agent",
        kind="note",
        summary=f"re-look {chain_id}: {summary}",
        output={"type": "relook", "chain_id": chain_id, "step": step, **out},
        refs=[chain_id, *refs],
    )


def chains(store: Any, mission_id: str) -> dict[str, list[dict]]:
    """The re-look chains of a mission from its trace: chain id → its steps' outputs, in order."""
    out: dict[str, list[dict]] = {}
    for e in store.trace_entries(mission_id):
        o = e.output or {}
        if o.get("type") == "relook":
            out.setdefault(o["chain_id"], []).append(o)
    return out


def _leg_step(steps: list[dict]) -> dict | None:
    return next((s for s in reversed(steps) if s["step"] == "leg"), None)


def _flown(state: dict, leg_id: str) -> bool:
    fleet = state["fleet"]
    return fleet is not None and any(
        x.id == leg_id and x.status in ("approved", "flying", "done") for x in fleet.legs
    )


def _chain_of_photo(store: Any, mission_id: str, det: Any, frame: Any) -> str | None:
    """The chain whose approved re-look leg took this photo: at the re-look altitude, the detection
    within ``MATCH_M`` of the spot."""
    alt = frame.pose.alt_agl_m
    if alt is None or alt > RELOOK_ALT_M + 1.0:
        return None
    state = store.state(mission_id)
    here = LatLon(lat=det.lat, lon=det.lon)
    best: tuple[float, str] | None = None
    for cid, steps in chains(store, mission_id).items():
        leg = _leg_step(steps)
        if leg is None or not _flown(state, leg["leg"]):
            continue
        d = _metres(here, LatLon(**leg["target"]))
        if d <= MATCH_M and (best is None or d < best[0]):
            best = (d, cid)
    return best[1] if best else None


def second_look(store: Any, mission_id: str, detection_id: str, client: Any, detector: Any) -> Look:
    """``verify`` with the ledger around it, and the chain's photo and verdict steps when the
    photo came from a re-look leg."""
    det, frame = store.get_detection(mission_id, detection_id)
    alt = frame.pose.alt_agl_m or DEFAULT_ALT_M
    long_px = ledger.box_long_px(store, mission_id, det, frame)
    chain = _chain_of_photo(store, mission_id, det, frame)
    if chain is not None:
        _step(store, mission_id, chain, "photo",
              f"photo {frame.id} from {alt:.0f} m has {det.id} ({long_px} px) over the spot",
              [frame.id, det.id], frame=frame.id, file=frame.file, altitude_m=alt,
              detection=det.id, conf=round(det.conf, 3), box_long_px=long_px)  # fmt: skip
    at = LatLon(lat=det.lat, lon=det.lon)
    before = ledger.snapshot(store, mission_id, at)
    v = verify(store, mission_id, detection_id, client, detector)
    after = ledger.snapshot(store, mission_id, at)
    cid = chain or chain_id_for(det.id)
    ledger.record_second_look(store, mission_id, cid, det, v, long_px, before, after)
    if chain is not None:
        _step(store, mission_id, chain, "verdict", f"second look at {det.id}: person {v.person}",
              [det.id, v.id], detection=det.id, verdict=v.id, person=v.person, reason=v.reason,
              images=v.relook_crops)  # fmt: skip
    return Look(v, cid, long_px, alt, chain is not None)


def held_drones(state: dict) -> set[str]:
    """Drones with a re-look leg waiting for approval: the planner's re-plans leave them alone."""
    return {
        p.target["drone"]
        for p in state["proposals"]
        if p.status == "pending" and "relook" in p.target and "drone" in p.target
    }


def after_verdict(
    store: Any,
    mission_id: str,
    look: Look,
    proposals: list[Proposal],
    allow: bool,
) -> list[Proposal]:
    """What the verdict changes next. A re-look photo's verdict closes its chain (``outcome``).
    Otherwise an ``unclear`` from the model on a box under ``RELOOK_MAX_PX`` seen from above
    ``RELOOK_ALT_M`` gets a re-look leg (when ``allow``: a near-miss, or a reviewer's "unsure")."""
    v = look.verdict
    if look.relook_photo:
        what = {"yes": "resolved: a person", "no": "resolved: not a person"}.get(
            v.person, "still unclear: left to the reviewer"
        )
        _step(store, mission_id, look.chain_id, "outcome", what,
              [v.detection_id, v.id, *(p.id for p in proposals)],
              outcome="resolved" if v.person in ("yes", "no") else "unclear", person=v.person,
              detection=v.detection_id, proposals=[p.id for p in proposals])  # fmt: skip
        return []
    if not allow or v.person != "unclear" or v.reason.startswith(NO_LOOK):
        return []
    if look.long_px >= RELOOK_MAX_PX or look.altitude_m <= RELOOK_ALT_M + 1.0:
        return []
    if look.chain_id in chains(store, mission_id):
        return []  # this detection already has a re-look chain
    return _propose(store, mission_id, look)


def _propose(store: Any, mission_id: str, look: Look) -> list[Proposal]:
    from sightline.agent import loop  # the loop imports this module
    from sightline.search.grid import cells_within_radius
    from sightline.search.planner import PlannerConfig, expected_on_cells, relook_leg

    v, cid = look.verdict, look.chain_id
    det, frame = store.get_detection(mission_id, v.detection_id)
    spot = LatLon(lat=det.lat, lon=det.lon)
    factor = (look.altitude_m / RELOOK_ALT_M) ** 2
    crop = det.crop or f"relook/{det.id}-crop.jpg"
    _step(store, mission_id, cid, "unclear",
          f"second look at {det.id} unclear on a {look.long_px} px box from {look.altitude_m:.0f} m",
          [det.id, v.id, frame.id], detection=det.id, verdict=v.id, frame=frame.id,
          box_long_px=look.long_px, altitude_m=look.altitude_m, target=spot.model_dump(),
          images=[crop, *v.relook_crops], reason=v.reason)  # fmt: skip
    state = store.state(mission_id)
    c, fleet = state["conditions"], state["fleet"]
    why_not = None
    if c is not None and c.flyable is False:
        why_not = f"not flyable ({c.flyability_reason})"
    drones = [d for d in (fleet.drones if fleet else []) if d.status in ("idle", "flying")]
    if why_not is None and not drones:
        why_not = "no drone is idle or flying"
    if why_not is not None:
        _step(store, mission_id, cid, "skipped", f"no re-look leg: {why_not}", [det.id],
              why=why_not)  # fmt: skip
        return []

    def away(d: Any) -> float:
        return _metres(d.position or state["mission"].area.lkp, spot)

    drone = min(drones, key=lambda d: (d.status != "idle", away(d)))
    live, layout = loop._layout(store, mission_id)
    sector = loop._sector_at(live, layout, det.lat, det.lon)
    if sector is None:
        _step(store, mission_id, cid, "skipped", "no re-look leg: the spot is off the map",
              [det.id], why="off the map")  # fmt: skip
        return []
    grid = live.base.grid
    leg = relook_leg(drone, spot, grid, sector, RELOOK_ALT_M, RELOOK_SIDE_M, PlannerConfig())
    visibility = c.visibility_factor if c is not None else 1.0
    radius = RELOOK_SIDE_M / 2
    gain = expected_on_cells(cells_within_radius(grid, spot, radius), live, visibility)
    reason = (
        f"Second look at {det.id} was unclear: box {look.long_px} px, too small to verify; a pass "
        f"at {RELOOK_ALT_M:.0f} m gives about {factor:.0f}× the pixels ({look.altitude_m:.0f} m → "
        f"{RELOOK_ALT_M:.0f} m). {drone.name} is {away(drone):.0f} m away: {leg.est_minutes:.1f} "
        f"min there and over the spot, expected to rule out {gain:.3%} of the probability."
    )
    leg = leg.model_copy(
        update={
            "id": store.next_id(mission_id, "L"),
            "expected_clearance": round(gain, 6),
            "score_per_min": round(gain / max(leg.est_minutes, 0.01), 6),
            "reason": f"Re-look at {det.id} from {RELOOK_ALT_M:.0f} m ({factor:.0f}× the pixels).",
        }
    )
    for old in loop._pending(state, ("drone_leg", "retask_drone"), "drone", drone.id):
        store.set_proposal_status(mission_id, old.id, "superseded", by="agent")
    retask = drone.status == "flying" and drone.leg_id is not None
    verb = "re-task" if retask else "send"
    region = {"lat": spot.lat, "lon": spot.lon, "radius_m": radius}
    p = loop._add(
        store,
        mission_id,
        (cid, det.id, v.id),
        expected=ledger.leg_expected(store, mission_id, leg, region),
        kind="retask_drone" if retask else "drone_leg",
        summary=f"Re-look at {det.id} from {RELOOK_ALT_M:.0f} m: {verb} {drone.name}",
        reason=reason,
        target={"drone": drone.id, "leg": leg.id, "relook": det.id},
        leg=leg,
        evidence=[
            EvidenceRef(
                kind="crop", ref=crop, caption=f"box {look.long_px} px, conf {det.conf:.2f}"
            ),
            *(
                EvidenceRef(kind="relook", ref=r, caption=t)
                for r, t in zip(v.relook_crops, v.tools, strict=True)
            ),
            EvidenceRef(kind="trace", ref=v.id, caption=f"second look: unclear ({v.reason})"),
            EvidenceRef(kind="leg", ref=leg.id, caption=leg.reason),
        ],
        created_by="agent",
    )
    _step(store, mission_id, cid, "leg", f"{p.id} proposes {leg.id} for {drone.name} at "
          f"{RELOOK_ALT_M:.0f} m", [p.id, leg.id, drone.id], proposal=p.id, kind=p.kind,
          leg=leg.id, drone=drone.id, altitude_m=RELOOK_ALT_M, pixel_factor=round(factor, 2),
          est_minutes=leg.est_minutes, expected_clearance=leg.expected_clearance,
          target=spot.model_dump(), from_altitude_m=look.altitude_m)  # fmt: skip
    return [p]


def on_leg_done(store: Any, mission_id: str, leg: Leg) -> None:
    """A leg is done: its ledger record, and, for a re-look leg, its photos over the spot and, when
    none of them had a detection near it, the chain's outcome."""
    chain = next(
        (
            (cid, s)
            for cid, steps in chains(store, mission_id).items()
            if (s := _leg_step(steps)) is not None and s["leg"] == leg.id
        ),
        None,
    )
    ledger.record_leg(store, mission_id, leg, chain[0] if chain else None)
    if chain is None:
        return
    cid, step = chain
    spot = LatLon(**step["target"])
    steps = chains(store, mission_id)[cid]
    seen = {s.get("frame") for s in steps if s["step"] == "photo"}
    frames = [
        f
        for f in store.survey(mission_id).frames
        if f.pose.alt_agl_m is not None
        and abs(f.pose.alt_agl_m - leg.altitude_m) <= 1.0
        and _metres(LatLon(lat=f.pose.lat, lon=f.pose.lon), spot) <= RELOOK_SIDE_M
    ]
    for f in frames:
        if f.id not in seen:
            _step(store, mission_id, cid, "photo",
                  f"photo {f.id} from {f.pose.alt_agl_m:.0f} m over the spot, no detection near it",
                  [f.id], frame=f.id, file=f.file, altitude_m=f.pose.alt_agl_m, detection=None)  # fmt: skip
    if not any(s["step"] == "verdict" for s in steps):
        _step(store, mission_id, cid, "outcome",
              f"{leg.id} done: {len(frames)} photos from {leg.altitude_m:.0f} m over the spot, no "
              f"detection within {MATCH_M:.0f} m of it",
              [leg.id], outcome="not_redetected", person=None, photos=len(frames),
              proposals=[])  # fmt: skip
