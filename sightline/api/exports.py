"""Standard SAR outputs (``docs/EXPORTS.md``): ICS 204 per team, ICS 214 for the mission and a
CalTopo / SARTopo GeoJSON, built by ``sightline/geo/exports.py`` from the mission as it is now.

Reads only, so they stay open when the API has a write token (``sightline/api/auth.py``).
"""

from __future__ import annotations

import json
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

from sightline.api.missions import _store
from sightline.mission import effects
from sightline.mission.store import now_iso

TAG = "exports"
TAG_DOC = {
    "name": TAG,
    "description": "Standard SAR outputs a command post can file: ICS 204 Assignment List per "
    "team, ICS 214 Activity Log, ICS 309 Communications Log, GeoJSON that imports into CalTopo / "
    "SARTopo (all read-only), and the timeline pushed to a D4H Operations Center incident log.",
}

exports_router = APIRouter(tags=[TAG])

PodTarget = Annotated[
    float, Query(gt=0, le=0.9, description="the POD asked of the team's sweep (at most 0.9)")
]


def _team_204(request: Request, mission_id: str, team: str, pod_target: float) -> dict:
    from sightline.geo.cards import assignment_card
    from sightline.geo.exports import ics204, team_task

    store = _store(request, mission_id)
    state = store.state(mission_id)
    t = next((x for x in state["teams"] if x.id.lower() == team.lower()), None)
    if t is None:
        raise HTTPException(404, "no such team")
    now = now_iso()
    task = team_task(state, t.id)
    card = None
    if task is not None:
        layout = effects._layout(store, mission_id)
        if layout is None:
            raise HTTPException(503, "assignment cards wait for lane C (C-S1 sectors)")
        try:
            card = assignment_card(mission_id, task.sector_id, store, layout, now=now)
        except KeyError as e:
            raise HTTPException(404, str(e)) from None
    trace = store.trace_entries(mission_id)
    return ics204(state, trace, t.id, card, now, pod_target)


@exports_router.get(
    "/missions/{mission_id}/ics204/{team}.md",
    response_class=Response,
    responses={200: {"content": {"text/markdown": {}}}},
    summary="ICS 204 Assignment List for one team (Markdown)",
)
def get_ics204_md(
    mission_id: str, team: str, request: Request, pod_target: PodTarget = 0.6
) -> Response:
    """FEMA ICS 204 (v3.1) blocks 1–9 for ``team`` (an id such as ``T2``) from its assignment card:
    incident, operational period (mission start to now), division (the sector), resources (the
    team and any drone on a live leg over the sector), work assignment with the POD target,
    special instructions (wind, daylight, no-fly), communications and who approved it. Printable
    Markdown tables. A team without a sector gets a 204 that says so."""
    from sightline.geo.exports import ics204_markdown

    f = _team_204(request, mission_id, team, pod_target)
    return Response(ics204_markdown(f), media_type="text/markdown; charset=utf-8")


@exports_router.get(
    "/missions/{mission_id}/ics204/{team}.json",
    summary="ICS 204 Assignment List for one team (JSON)",
)
def get_ics204_json(
    mission_id: str, team: str, request: Request, pod_target: PodTarget = 0.6
) -> dict:
    """The same ICS 204 as the ``.md``, as JSON with one key per form block."""
    return _team_204(request, mission_id, team, pod_target)


@exports_router.get(
    "/missions/{mission_id}/ics214.md",
    response_class=Response,
    responses={200: {"content": {"text/markdown": {}}}},
    summary="ICS 214 Activity Log for the mission (Markdown)",
)
def get_ics214_md(mission_id: str, request: Request) -> Response:
    """FEMA ICS 214 (v3.1) blocks 1–8: the activity log from the trace's decisions (approvals,
    re-tasks, recalls, rejections with who and why), the clues logged and the task board's moves
    (assigned, started, searched at a POD), oldest first."""
    from sightline.geo.exports import ics214, ics214_markdown

    store = _store(request, mission_id)
    f = ics214(store.state(mission_id), store.trace_entries(mission_id), store.events(mission_id),
               now_iso())  # fmt: skip
    return Response(ics214_markdown(f), media_type="text/markdown; charset=utf-8")


@exports_router.get(
    "/missions/{mission_id}/caltopo.geojson",
    response_class=Response,
    responses={200: {"content": {"application/geo+json": {}}}},
    summary="Sectors, searched areas, legs, teams and clues for CalTopo / SARTopo (GeoJSON)",
)
def get_caltopo(mission_id: str, request: Request) -> Response:
    """A GeoJSON FeatureCollection with CalTopo's style properties (``title``, ``description``,
    ``class``, ``stroke``, ``stroke-opacity``, ``fill``, ``fill-opacity``, ``marker-color``,
    ``marker-symbol``) and one folder per layer. In CalTopo: Import → choose the file."""
    from sightline.geo.exports import caltopo_geojson

    store = _store(request, mission_id)
    fc = caltopo_geojson(store.state(mission_id), effects.sector_overview(store, mission_id))
    return Response(
        json.dumps(fc, ensure_ascii=False),
        media_type="application/geo+json",
        headers={"Content-Disposition": f'attachment; filename="sightline-{mission_id}.geojson"'},
    )


def _ics309(request: Request, mission_id: str) -> dict:
    from sightline.geo.exports import ics309
    from sightline.mission.timeline import mission_timeline

    store = _store(request, mission_id)
    return ics309(store.state(mission_id), mission_timeline(store, mission_id), now_iso())


@exports_router.get(
    "/missions/{mission_id}/ics309.md",
    response_class=Response,
    responses={200: {"content": {"text/markdown": {}}}},
    summary="ICS 309 Communications Log for the mission (Markdown)",
)
def get_ics309_md(mission_id: str, request: Request) -> Response:
    """FEMA ICS 309 (v3.1) blocks 1–5: every radio turn on the desk, oldest first: time, from,
    to, message (a team's words as transcribed; the desk's replies and calls)."""
    from sightline.geo.exports import ics309_markdown

    return Response(
        ics309_markdown(_ics309(request, mission_id)), media_type="text/markdown; charset=utf-8"
    )


@exports_router.get(
    "/missions/{mission_id}/ics309.json", summary="ICS 309 Communications Log (JSON)"
)
def get_ics309_json(mission_id: str, request: Request) -> dict:
    return _ics309(request, mission_id)


class D4hPush(BaseModel):
    org: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    incident_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    after: str | None = Field(default=None, pattern=r"^e\d+$")  # only the lines after this event


@exports_router.post(
    "/missions/{mission_id}/export/d4h", summary="Push the timeline to a D4H incident log"
)
def post_d4h(mission_id: str, body: D4hPush, request: Request) -> dict:
    """Each timeline line as a D4H Operations Center log entry (``POST /api/v1/orgs/{org}/incidents/
    {id}/logs``, ``{message, tags}``), oldest first. Needs ``D4H_API_TOKEN`` in the API's environment:
    503 without it. A D4H error stops the push: 502 with how many lines went up. A write: it takes
    the API's write token."""
    from sightline.mission import d4h
    from sightline.mission.timeline import mission_timeline

    store = _store(request, mission_id)
    lines = mission_timeline(store, mission_id)
    if body.after:
        n = int(body.after[1:])
        lines = [x for x in lines if int(x.id.split("-")[0][1:]) > n]
    teams = {t.id: t.callsign for t in store.state(mission_id)["teams"]}
    try:
        posted = d4h.push(lines, body.org, body.incident_id, teams)
    except LookupError as e:
        raise HTTPException(503, str(e)) from None
    except d4h.D4hError as e:
        raise HTTPException(502, f"{e} ({e.posted} lines posted before it)") from None
    return {"posted": posted, "last_id": lines[-1].id.split("-")[0] if lines else body.after}
