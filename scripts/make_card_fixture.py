"""Lane B's card fixtures for the other lanes (LANE_B §3, Tue): a real assignment card for sector B3
and its GPX and KML, from a real mission (Mount Seymour, Team Two 300 m north-west of the sector).

    uv run python scripts/make_card_fixture.py

Writes ``web/src/command/__fixtures__/card_sector_B3.json``, ``sample.gpx`` and ``sample.kml``.
Generated, not hand-written; ``AssignmentCardView.test.tsx`` renders it.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
OUT = ROOT / "web/src/command/__fixtures__"
AT = "2026-10-24T22:00:00Z"


def main() -> int:
    from fastapi.testclient import TestClient

    from sightline.api.app import create_app
    from sightline.api.missions import MissionContext
    from sightline.contract import SectorTask
    from sightline.geo.cards import assignment_card, to_gpx, to_kml
    from sightline.mission import MissionStore
    from sightline.mission.queue import LocalQueue
    from sightline.search.sectors import lattice_sectors

    work = Path(tempfile.mkdtemp())
    store = MissionStore(work / "missions")
    ctx = MissionContext(store, queue=LocalQueue(), hooks=None, detector_factory=lambda: None)
    ctx.start()
    with TestClient(create_app(cache_root=work / "c", data_root=work / "u", missions=ctx)) as http:
        mid = http.post("/missions", json={"name": "Card fixture", "area_name": "Mount Seymour",
                        "lkp": {"lat": 49.375, "lon": -122.9375}, "subject": "adult, red jacket"}).json()["mission_id"]  # fmt: skip
        http.patch(
            f"/missions/{mid}/teams/T2",
            json={"position": {"lat": 49.3762, "lon": -122.9398}, "status": "assigned"},
        )
    ctx.queue.stop()
    store.upsert_task(
        mid,
        SectorTask(
            sector_id="B3", state="assigned", team_id="T2", poa=0.06, note=None, updated_at=AT
        ),
    )
    card = assignment_card(mid, "B3", store, lattice_sectors(store.live(mid).base.grid), now=AT)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "card_sector_B3.json").write_text(
        json.dumps(card.model_dump(mode="json"), indent=1) + "\n"
    )
    (OUT / "sample.gpx").write_text(to_gpx(card))
    (OUT / "sample.kml").write_text(to_kml(card))
    print(
        f"wrote {OUT.relative_to(ROOT)}: card B3 for {card.team_callsign}, {len(card.waypoints)} waypoints"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
