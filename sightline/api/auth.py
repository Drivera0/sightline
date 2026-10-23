"""An optional write token for the API.

With ``SIGHTLINE_API_TOKEN`` set, a POST, PUT, PATCH or DELETE needs ``Authorization: Bearer <token>``;
anything else gets 401 with a plain message. Reads (GET, HEAD), CORS preflights (OPTIONS), ``/health``
and the event streams stay open, so the public site can still watch a mission. With the variable unset
nothing changes: the API is open, as on a trusted network.

A plain ASGI middleware rather than ``@app.middleware("http")``: it never wraps the response body, so
SSE streams pass through untouched.
"""

from __future__ import annotations

import hmac
import os

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

ENV = "SIGHTLINE_API_TOKEN"
WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
MISSING = "this API takes writes only with its token: send Authorization: Bearer <token>"
WRONG = "wrong API token"


def token_from_env() -> str | None:
    """The write token, or None when it is unset or blank (the API stays open)."""
    return os.environ.get(ENV, "").strip() or None


def bearer_problem(header: str | None, token: str | bytes) -> str | None:
    """None if ``header`` is ``Bearer <token>``, else the reason it is not (``MISSING``,
    ``WRONG``). Also used by reads that may cost a paid call (``GET /missions/{id}/similar``)."""
    expected = token.encode() if isinstance(token, str) else token
    scheme, _, given = (header or "").partition(" ")
    if scheme.lower() != "bearer" or not given.strip():
        return MISSING
    if not hmac.compare_digest(given.strip().encode(), expected):
        return WRONG
    return None


class WriteToken:
    """Refuses write methods without ``Authorization: Bearer <token>``."""

    def __init__(self, app: ASGIApp, token: str) -> None:
        if not token:
            raise ValueError("an empty token would refuse nothing: leave the middleware out")
        self.app = app
        self.token = token.encode()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["method"] in WRITE_METHODS:
            problem = self.check(Headers(scope=scope).get("authorization"))
            if problem:
                response = JSONResponse(
                    {"detail": problem}, status_code=401, headers={"WWW-Authenticate": "Bearer"}
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)

    def check(self, header: str | None) -> str | None:
        """None if ``header`` carries the token, else the reason for the 401."""
        return bearer_problem(header, self.token)
