"""The D4H log push (contract §15, v1.3; ``docs/EXPORTS.md``): the mission's timeline posted line by
line to a D4H Operations Center incident log, so Sightline feeds the tool a BC SAR group may already
use instead of replacing it.

D4H Operations Center API v1: ``POST /api/v1/orgs/{org}/incidents/{id}/logs`` with ``{message,
tags}``; D4H stamps each entry with its own time, so each message starts with the time Sightline
logged it (https://operations-center.us.d4h.com/api/docs/v1, read for .documents/COMMAND_POST.md
§3). The token is ``D4H_API_TOKEN`` from the environment (sent as a bearer token), never a request
field; the host is ``D4H_API_URL`` (default the US Operations Center host).
"""

from __future__ import annotations

import os
from collections.abc import Callable, Iterable
from typing import Any

import httpx

from sightline.contract import TimelineEntry

TOKEN_ENV = "D4H_API_TOKEN"
URL_ENV = "D4H_API_URL"
DEFAULT_URL = "https://operations-center.us.d4h.com"
NO_TOKEN = (
    f"the D4H log push needs a D4H Operations Center API token: set {TOKEN_ENV} in the API's "
    "environment (it is never taken from a request)"
)


class D4hError(RuntimeError):
    """D4H refused or could not be reached; ``posted`` lines went up before it stopped."""

    def __init__(self, message: str, posted: int) -> None:
        super().__init__(message)
        self.posted = posted


def _client(base_url: str) -> httpx.Client:
    return httpx.Client(base_url=base_url, timeout=15.0)


client_factory: Callable[[str], Any] = _client  # tests swap in a mocked transport


def log_body(entry: TimelineEntry, teams: dict[str, str]) -> dict:
    """One timeline line as a D4H log entry: the time and the line, tagged by kind, team, drone and
    sector."""
    team = teams.get(entry.team or "", entry.team)
    who = f"{team}: " if team and entry.kind in ("radio", "checkin") else ""
    message = f"[{entry.at[11:16]} UTC] {who}{entry.text}"
    tags = [
        "Sightline",
        entry.kind,
        *(x for x in (team, entry.drone, entry.sector and f"Sector {entry.sector}") if x),
    ]
    return {"message": message, "tags": tags}


def push(
    entries: Iterable[TimelineEntry],
    org: str,
    incident_id: str,
    teams: dict[str, str] | None = None,
    token: str | None = None,
    base_url: str | None = None,
) -> int:
    """Post each line, oldest first; returns how many. ``LookupError`` with no token; ``D4hError``
    when D4H answers with an error or can't be reached (the lines before it are posted)."""
    token = token or os.environ.get(TOKEN_ENV, "").strip()
    if not token:
        raise LookupError(NO_TOKEN)
    base = (base_url or os.environ.get(URL_ENV) or DEFAULT_URL).rstrip("/")
    path = f"/api/v1/orgs/{org}/incidents/{incident_id}/logs"
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    posted = 0
    with client_factory(base) as http:
        for e in entries:
            try:
                r = http.post(path, json=log_body(e, teams or {}), headers=headers)
            except httpx.HTTPError as err:
                raise D4hError(f"D4H could not be reached: {type(err).__name__}", posted) from None
            if r.status_code >= 400:
                raise D4hError(
                    f"D4H answered {r.status_code} on line {e.id}: {r.text[:200]}", posted
                )
            posted += 1
    return posted
