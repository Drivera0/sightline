"""The bulletin tool, live: the model decides to search, Tavily finds and reads a public bulletin, Nemotron
Nano returns the subject profile with quotes, and the proposal is made (docs/report/TAVILY.md, "The subject
from a public bulletin").

    uv run python scripts/subject_live.py --area "Mount Seymour" --lat 49.375 --lon -122.9375 \\
        --last-seen 2026-01-15T23:30:00Z

A fresh mission with no subject at the given place and time (pick a resolved, public RCMP or SAR release of
a found hiker and give its place and date: the model writes its own query from those facts). One decision
call, at most one Tavily search and one extract, one extraction call: a few cents. Writes
``docs/evidence/subject/<UTC timestamp>/``: ``request.json`` (the mission facts and the model's query),
``result.json`` (values, quotes, URLs, sources), ``proposal.json`` and ``trace.jsonl`` (the mission's trace).
Names are redacted before anything is stored. Keys come from the environment or ``.env``; none is written.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--area", default="Mount Seymour")
    ap.add_argument("--lat", type=float, default=49.375)
    ap.add_argument("--lon", type=float, default=-122.9375)
    ap.add_argument("--last-seen", default=None, help="UTC ISO time the person was last seen")
    args = ap.parse_args(argv)

    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env")
    for fake in ("SIGHTLINE_FAKE_TAVILY", "SIGHTLINE_FAKE_LLM"):
        os.environ.pop(fake, None)
    if not (os.environ.get("TAVILY_API_KEY") and os.environ.get("NEBIUS_API_KEY")):
        print("TAVILY_API_KEY and NEBIUS_API_KEY are needed (environment or .env)")
        return 1

    from sightline.agent import subject_tool
    from sightline.contract import LatLon
    from sightline.mission import MissionStore

    store = MissionStore(Path(tempfile.mkdtemp(prefix="subject-live-")))
    m = store.create(
        f"{args.area}: missing person", args.area, LatLon(lat=args.lat, lon=args.lon), "live",
        last_seen_at=args.last_seen,
    )  # fmt: skip
    out = subject_tool.search_subject(store, m.mission_id, client=subject_tool.default_client())
    trace = store.trace_entries(m.mission_id)
    query = next((e.input or {} for e in trace if e.kind == "tool_call"), {}).get("query")

    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    dest = ROOT / "docs/evidence/subject" / stamp
    dest.mkdir(parents=True, exist_ok=True)
    request = {"mission": subject_tool._facts(m), "query_written_by_model": query}
    (dest / "request.json").write_text(json.dumps(request, indent=2) + "\n")
    (dest / "result.json").write_text(json.dumps({k: out[k] for k in ("searched", "why", "profile")}, indent=2) + "\n")  # fmt: skip
    (dest / "proposal.json").write_text(json.dumps(out["proposal"], indent=2) + "\n")
    (dest / "trace.jsonl").write_text("".join(e.model_dump_json() + "\n" for e in trace))
    print(
        json.dumps({"why": out["why"], "summary": (out["proposal"] or {}).get("summary")}, indent=2)
    )
    print(f"wrote {dest.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
