"""``find_similar`` on the demo flight, with the hosted embedder (docs/report/SIMILAR.md, "On the demo flight").

    uv run --env-file .env python scripts/similar_demo.py --cache web/public/cache/demo --confirm f0336-d01

Loads the demo cache (500 frames of HERIDAL **test** imagery on a simulated path; a demonstration,
nothing is chosen on it) into a mission store under ``--out``, records a reviewer's "person" on
``--confirm``, and runs the agent's ``find_similar`` the way the loop does after a confirmed
sighting. Prints the tool call and the proposals from the trace. Needs ``NVIDIA_API_KEY``.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--cache", type=Path, default=ROOT / "web/public/cache/demo")
    ap.add_argument("--confirm", default="f0336-d01")
    ap.add_argument(
        "--out", type=Path, default=None, help="mission store root (default: a temp dir)"
    )
    args = ap.parse_args(argv)

    from sightline.agent import similar_tool
    from sightline.contract import Detection, Frame, LatLon
    from sightline.mission import MissionStore
    from sightline.ml.similar import default_embedder

    emb = default_embedder()
    if emb is None:
        print("NVIDIA_API_KEY is not set", file=sys.stderr)
        return 2
    survey = json.loads((args.cache / "survey.json").read_text())
    dets = json.loads((args.cache / "detections.json").read_text())
    root = args.out or Path(tempfile.mkdtemp(prefix="similar-demo-"))
    store = MissionStore(root)
    lkp = survey["area"]["lkp"]
    mid = store.create("demo", survey["area"]["name"], LatLon(**lkp), "demo").mission_id
    for f in survey["frames"]:
        frame = Frame.model_validate({**f, "rank": f["flight_index"] + 1})
        store.append_frame(mid, frame, (args.cache / f["file"]).read_bytes())
    for fid, items in dets["frames"].items():
        if items:
            crops = {d["crop"]: (args.cache / d["crop"]).read_bytes() for d in items if d["crop"]}
            store.append_detections(mid, fid, [Detection.model_validate(d) for d in items], crops)
    store.emit(mid, "mission.note", f"review {args.confirm}: person", ref=args.confirm,
               data={"answer": "person"})  # fmt: skip

    why = f"a reviewer confirmed detection {args.confirm} as a person"
    out = similar_tool.find_similar(store, mid, args.confirm, emb, why=why)
    for e in store.trace_entries(mid):
        print(f"{e.at}  {e.actor:6s} {e.kind:9s} {e.summary}")
        if e.kind == "tool_call":
            print(f"    indexed {e.output['indexed']}, embedded now {e.output['embedded_now']}, "
                  f"{e.output['ms']} ms, calls {e.output['calls']}")  # fmt: skip
            for m in e.output["matches"]:
                print(f"    {m['detection']}  score {m['score']:.3f}  conf {m['conf']:.3f}  "
                      f"{m['action']}  {m['crop']}")  # fmt: skip
        if e.kind == "proposal":
            print(f"    reason: {e.output['reason']}")
    print(f"\n{len(out)} proposal(s); mission {mid} under {root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
