"""A stand-in for the mission API (contract §13) for the photo clients' tests: missions, photo uploads
(a photo with no GPS is rejected, as the real API does) and the survey. ``offline = True`` makes every
call fail as if the network were down."""

from __future__ import annotations

from typing import Annotated

import httpx
from fastapi import FastAPI, File, Request, UploadFile


def _pose(path):
    from sightline.geo.pose import read_pose

    try:
        return read_pose(path)
    except OSError:  # not a JPEG the real API could decode either
        return None


class FakeApi:
    def __init__(self) -> None:
        self.offline = False
        self.missions: dict[str, dict] = {}
        self.photos: dict[str, list[str]] = {}  # mission -> names, in upload order
        self.calls: list[str] = []
        app = FastAPI()

        @app.middleware("http")
        async def _network(request: Request, call_next):
            if self.offline:
                raise httpx.ConnectError("network is unreachable")
            self.calls.append(f"{request.method} {request.url.path}")
            return await call_next(request)

        @app.post("/missions", status_code=201)
        def create(body: dict) -> dict:
            mid = f"m{len(self.missions) + 1:07d}"
            self.missions[mid] = body
            self.photos[mid] = []
            return {"mission_id": mid, **body}

        @app.post("/missions/{mid}/photos")
        async def photos(mid: str, files: Annotated[list[UploadFile], File()]) -> dict:
            import tempfile
            from pathlib import Path

            accepted, rejected = [], []
            for f in files:
                with tempfile.NamedTemporaryFile(suffix=".jpg") as tmp:
                    tmp.write(await f.read())
                    tmp.flush()
                    if _pose(Path(tmp.name)) is None:
                        rejected.append({"name": f.filename, "reason": "no GPS in EXIF"})
                        continue
                self.photos[mid].append(f.filename)
                accepted.append(f"f{len(self.photos[mid]):04d}")
            return {"accepted": accepted, "rejected": rejected}

        @app.get("/missions/{mid}/survey")
        def survey(mid: str) -> dict:
            return {"frames": [{"source": {"image": n}} for n in self.photos[mid]]}

        self.app = app
