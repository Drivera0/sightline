"""Limits on what a client can send the API (``docs/SECURITY.md``).

Sizes, measured on the 1,647 full HERIDAL photos (4000 × 3000, a few 4000 × 2250): median 5.1 MB,
largest 6.9 MB.

- ``MAX_PHOTO_BYTES`` (28 MB): one photo, 4× the largest HERIDAL photo, room for a 48 MP drone JPEG.
- ``MAX_BATCH_BYTES`` (400 MB): one ``POST /missions/{id}/photos`` request, 50 photos (the most per
  batch) at 8 MB, above the largest HERIDAL photo. Checked on ``Content-Length`` and on the bytes
  actually received, so a chunked upload can't get round it.
- ``MAX_FORM_BYTES`` (25 MB): any other multipart write (a radio turn's audio: 30 s at most, a 30 s
  48 kHz stereo WAV is 5.8 MB).
- ``MAX_JSON_BYTES`` (1 MB): every other write (JSON bodies: missions, decisions, clues, fleet
  telemetry; the largest seen are a few KB).
- ``POST /survey`` (the sprint-1 zip) keeps its own limits (``create_app``'s ``max_upload_bytes``).

Uploads: photo files must be named ``.jpg``/``.jpeg``/``.png`` and declared as JPEG or PNG (or with
no type), else the request gets 415; the photo is then decoded, so a wrong extension can't smuggle
anything in. Client file names are never used as paths, and a name with ``..``, a separator or an
absolute path is refused (``safe_filename``).

Rate limit: write methods, per client IP, ``SIGHTLINE_RATE_LIMIT`` as ``<requests>/<seconds>``,
default ``600/60``; ``off`` turns it off (the tests do, unless a test turns it on). The default fits
the simulated fleet, whose drones and ground station all write from one IP
(``sightline/search/fleet.py``): per tick the ground station sends one ``PUT /fleet`` and each drone
at most one ``POST /photos`` (a tick's photos go in one request), plus a rare link or relay note. So
3 drones + 1 ground station = 4 writes per tick: ``fleet run`` (1 tick a second) sends 240 a
minute, ``scripts/creek_run.py`` (2 ticks a second) 480 a minute. 600 leaves 120 a minute for the
console, the radio and a photo replay (1 every 2 s) on the same machine. The fleet and
``creek_run`` honour ``Retry-After``, so a burst (photos synced after a lost link) waits instead of
failing. Over the limit: 429 with
``Retry-After``. Behind Caddy, ``SIGHTLINE_TRUST_PROXY=1`` takes the client IP from the last
``X-Forwarded-For`` entry (the one Caddy adds); never set it without a proxy in front.
"""

from __future__ import annotations

import math
import os
import re
import time
from collections import deque
from collections.abc import Callable

from starlette.datastructures import Headers
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from sightline.api.auth import WRITE_METHODS

MAX_PHOTO_BYTES = 28_000_000
MAX_BATCH_BYTES = 400_000_000
MAX_FORM_BYTES = 25_000_000
MAX_JSON_BYTES = 1_000_000
DEFAULT_RATE = "600/60"  # see the module docstring
PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png"}
PHOTO_TYPES = {"image/jpeg", "image/pjpeg", "image/png", "application/octet-stream", ""}
_PHOTOS_PATH = re.compile(r"^/missions/[^/]+/photos$")


def _mb(n: int) -> str:
    return f"{n / 1_000_000:g} MB"


# --- file names and types -------------------------------------------------------------------------


def safe_filename(name: str) -> bool:
    """True for a plain file name: not empty, no ``..``, no path separator, not absolute, no
    control characters. Client names are labels; this keeps them from ever becoming paths."""
    return bool(
        name
        and name not in (".", "..")
        and ".." not in name
        and not re.search(r"[/\\\x00-\x1f]", name)
        and not re.match(r"^[A-Za-z]:", name)
    )


def photo_type_problem(name: str, content_type: str | None) -> str | None:
    """None for a JPEG or PNG by extension and declared type, else why not (for a 415)."""
    ext = os.path.splitext(name)[1].lower()
    declared = (content_type or "").split(";")[0].strip().lower()
    if ext not in PHOTO_EXTENSIONS:
        return f"{name}: only JPEG or PNG photos (.jpg, .jpeg, .png)"
    if declared not in PHOTO_TYPES:
        return f"{name}: only JPEG or PNG photos, not {declared}"
    return None


# --- body size --------------------------------------------------------------------------------------


class BodyTooLarge(HTTPException):
    def __init__(self, limit: int) -> None:
        super().__init__(413, f"request body over {_mb(limit)}")


def body_limit(scope: Scope) -> int | None:
    """The byte limit for this request, or None (not a write, or ``/survey`` with its own)."""
    if scope["method"] not in WRITE_METHODS or scope["path"] == "/survey":
        return None
    if _PHOTOS_PATH.match(scope["path"]):
        return MAX_BATCH_BYTES
    ctype = Headers(scope=scope).get("content-type", "")
    return MAX_FORM_BYTES if ctype.startswith("multipart/") else MAX_JSON_BYTES


class BodyLimit:
    """413 for a write whose body is over its limit: at once from ``Content-Length``, or as soon as
    the bytes received pass it (a chunked body has no length)."""

    def __init__(self, app: ASGIApp, limit: Callable[[Scope], int | None] = body_limit) -> None:
        self.app = app
        self.limit = limit

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        limit = self.limit(scope) if scope["type"] == "http" else None
        if limit is None:
            await self.app(scope, receive, send)
            return
        length = Headers(scope=scope).get("content-length", "")
        if length.isdigit() and int(length) > limit:
            await _plain(413, BodyTooLarge(limit).detail)(scope, receive, send)
            return
        received, started = 0, False

        async def counted() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise BodyTooLarge(limit)  # FastAPI re-raises an HTTPException met in parsing
            return message

        async def tracked(message: Message) -> None:
            nonlocal started
            started = started or message["type"] == "http.response.start"
            await send(message)

        try:
            await self.app(scope, counted, tracked)
        except BodyTooLarge as e:
            if started:
                raise
            await _plain(413, e.detail)(scope, receive, send)


def _plain(status: int, detail: str, headers: dict[str, str] | None = None) -> JSONResponse:
    return JSONResponse({"detail": detail}, status_code=status, headers=headers)


# --- rate limit -------------------------------------------------------------------------------------


def parse_rate(text: str | None) -> tuple[int, float] | None:
    """``"300/60"`` → (300, 60.0); ``"off"``, ``"0"`` or blank → None."""
    text = (text or "").strip().lower()
    if text in ("", "off", "0", "none"):
        return None
    m = re.fullmatch(r"(\d+)\s*/\s*(\d+(?:\.\d+)?)", text)
    if not m or int(m.group(1)) < 1 or float(m.group(2)) <= 0:
        raise ValueError(f"rate limit {text!r}: give <requests>/<seconds>, e.g. 300/60, or off")
    return int(m.group(1)), float(m.group(2))


def rate_from_env() -> tuple[int, float] | None:
    return parse_rate(os.environ.get("SIGHTLINE_RATE_LIMIT", DEFAULT_RATE))


class RateLimit:
    """A sliding window per client IP over write methods; reads and streams are never limited.
    In memory, per process: enough for one API container."""

    def __init__(
        self,
        app: ASGIApp,
        requests: int,
        seconds: float,
        trust_proxy: bool = False,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.app, self.requests, self.seconds = app, requests, seconds
        self.trust_proxy, self.clock = trust_proxy, clock
        self.hits: dict[str, deque[float]] = {}

    def client(self, scope: Scope) -> str:
        if self.trust_proxy:
            forwarded = Headers(scope=scope).get("x-forwarded-for", "")
            if forwarded.strip():
                return forwarded.split(",")[-1].strip()
        client = scope.get("client")
        return client[0] if client else "unknown"

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] not in WRITE_METHODS:
            await self.app(scope, receive, send)
            return
        now = self.clock()
        if len(self.hits) > 10_000:  # forget idle clients now and then
            self.hits = {k: q for k, q in self.hits.items() if q and q[-1] > now - self.seconds}
        q = self.hits.setdefault(self.client(scope), deque())
        while q and q[0] <= now - self.seconds:
            q.popleft()
        if len(q) >= self.requests:
            wait = max(1, math.ceil(q[0] + self.seconds - now))
            detail = f"too many writes: at most {self.requests} per {self.seconds:g} s; try again in {wait} s"
            await _plain(429, detail, {"Retry-After": str(wait)})(scope, receive, send)
            return
        q.append(now)
        await self.app(scope, receive, send)
