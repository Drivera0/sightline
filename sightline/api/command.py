"""The command post's endpoints (contract §15, v1.3): the find and the search manager's direct actions.
Writes, so they take the write token when the API has one (``sightline/api/auth.py``).

    POST /missions/{id}/found                         {team, sector, lat?, lon?, by?}
    POST /missions/{id}/teams/{team}/assign           {sector, reason?, by?}
    POST /missions/{id}/teams/{team}/call             {text, reply_to?, by?}  -> {turn_id, ...}
    POST /missions/{id}/teams/{team}/recall           {reason?, by?}
    POST /missions/{id}/sectors/{sector}/searched     {pod, team?, note?, by?}
    POST /missions/{id}/sectors/{sector}/recheck      {reason?, by?}

409: the action doesn't fit the mission now (the reason says why); 404: no such team or sector.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from sightline.api.missions import _ctx, _dump, _map_result, _store
from sightline.mission import command

TAG = "command post"
TAG_DOC = {
    "name": TAG,
    "description": "The search manager's own actions beside the agent's proposals: the find, "
    "assign, call, recall, searched at a POD, recheck. Each is traced as a human decision.",
}

command_router = APIRouter(tags=[TAG])
By = Field(default="Search manager", min_length=1, max_length=80)


class FoundBody(BaseModel):
    team: str = Field(min_length=1, max_length=32)
    sector: str | None = Field(default=None, max_length=8)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)
    by: str = By


@command_router.post("/missions/{mission_id}/found")
def post_found(mission_id: str, body: FoundBody, request: Request) -> dict:
    """The person is found: ``Mission.status`` → ``found`` with team, sector, position and time.
    No position: the sector's likeliest cell on the map. Traced as a human decision; the agent
    proposes nothing new after it. A second find is a 409."""
    store = _store(request, mission_id)
    try:
        m = command.mark_found(store, mission_id, body.team, body.sector, body.lat, body.lon,
                               body.by)  # fmt: skip
    except command.ActionError as e:
        raise HTTPException(409, str(e)) from None
    except KeyError as e:
        raise HTTPException(404, str(e).strip("'")) from None
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    return _dump(m)


def _run(fn: Callable[[], Any]) -> Any:
    try:
        return fn()
    except command.ActionError as e:
        raise HTTPException(409, str(e)) from None
    except KeyError as e:
        raise HTTPException(404, str(e).strip("'")) from None
    except ValueError as e:
        raise HTTPException(422, str(e)) from None


Reason = Field(default=None, max_length=500)


class AssignBody(BaseModel):
    sector: str = Field(min_length=1, max_length=8)
    reason: str | None = Reason
    by: str = By


class CallBody(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    reply_to: str | None = Field(default=None, max_length=40)  # the radio turn this answers
    by: str = By


class RecallBody(BaseModel):
    reason: str | None = Reason
    by: str = By


class SearchedBody(BaseModel):
    pod: float = Field(gt=0, le=0.9)
    team: str | None = Field(default=None, max_length=32)
    note: str | None = Reason
    by: str = By


@command_router.post("/missions/{mission_id}/teams/{team}/assign")
def post_assign(mission_id: str, team: str, body: AssignBody, request: Request) -> dict:
    """Assign the team to a sector directly (no proposal): task → assigned, team → assigned with
    its walking ETA, pending agent assignments for that team or sector superseded."""
    store = _store(request, mission_id)
    return _run(lambda: command.assign(store, mission_id, team, body.sector, body.by, body.reason))


@command_router.post("/missions/{mission_id}/teams/{team}/call")
def post_call(mission_id: str, team: str, body: CallBody, request: Request) -> dict:
    """Call the team: the radio desk speaks "<Callsign>, Sightline. <text>, over." Returns the
    turn id (the timeline's radio entry carries it) and, with the desk mounted, the audio chunks."""
    store = _store(request, mission_id)
    radio = getattr(request.app.state, "radio", None)
    return _run(lambda: command.call(store, mission_id, team, body.text, body.by, radio,
                                     body.reply_to))  # fmt: skip


@command_router.post("/missions/{mission_id}/teams/{team}/recall")
def post_recall(mission_id: str, team: str, body: RecallBody, request: Request) -> dict:
    """Recall the team to base camp: returning, with the walking ETA back."""
    store = _store(request, mission_id)
    return _run(lambda: command.recall(store, mission_id, team, body.by, body.reason))


@command_router.post("/missions/{mission_id}/sectors/{sector}/searched")
def post_searched(mission_id: str, sector: str, body: SearchedBody, request: Request) -> dict:
    """The sector was searched at ``pod``: the map lowers its cells by that POD (the probability
    stays above zero), the team goes back on standby and the agent re-plans."""
    store = _store(request, mission_id)
    hooks = _ctx(request).hooks
    r = _run(lambda: command.searched(store, mission_id, sector, body.pod, body.by, body.team,
                                      body.note, hooks))  # fmt: skip
    return {"sector": sector, "pod": body.pod, "map": _map_result(r)}


@command_router.post("/missions/{mission_id}/sectors/{sector}/recheck")
def post_recheck(mission_id: str, sector: str, body: RecallBody, request: Request) -> dict:
    """Put a searched sector back on the board to search again (the map keeps its step)."""
    store = _store(request, mission_id)
    return _run(lambda: command.recheck(store, mission_id, sector, body.by, body.reason))
