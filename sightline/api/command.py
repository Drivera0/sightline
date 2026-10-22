"""The command post's endpoints (contract §15, v1.3): the find and the search manager's direct actions.
Writes, so they take the write token when the API has one (``sightline/api/auth.py``).

    POST /missions/{id}/found                         {team, sector, lat?, lon?, by?}
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from sightline.api.missions import _dump, _store
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
