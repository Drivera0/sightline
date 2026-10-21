"""One real Agentic Vision chain, end to end, for the OpenCV report (A-G2, LANE_A §5.7).

    uv run --extra ml python scripts/av_chain.py [--photo train_ZRI_2061 --index 28] [--split val]

Takes one detection of the frozen detector on a **val** photo (default: a person lying down that
the detector scored 0.18, below the 0.29 review threshold), builds the photo into a mission the
way the pipeline does, and runs the real agent on it: ``loop.handle("detection")`` with OpenCV 5
re-look tools and Nemotron VL on Token Factory. If the agent proposes ``promote_detection``, a
**scripted** approval stands in for the search manager (labelled as such in the trace), so the
chain ends in a decision. Writes the mission's ``trace.jsonl``, ``proposals.json``,
``verdicts.json`` and every image it refers to under ``runs/av_chain/<mission_id>/``; print it
with ``scripts/trace_excerpt.py``. Needs NEBIUS_API_KEY.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT, ROOT / "scripts"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

SCRIPTED_APPROVER = "Search manager (scripted approval for this demo run)"


def dump(store, mission_id: str, out: Path) -> Path:
    """Write the in-memory mission's trace, proposals, verdicts and files to ``out/<id>/``."""
    d = out / mission_id
    d.mkdir(parents=True, exist_ok=True)
    (d / "trace.jsonl").write_text(store.trace_jsonl(mission_id) + "\n", encoding="utf-8")
    state = store.state(mission_id)
    for key in ("proposals", "verdicts"):
        rows = [x.model_dump(mode="json") for x in state[key]]
        (d / f"{key}.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
    for rel, data in store.files(mission_id).items():
        (d / rel).parent.mkdir(parents=True, exist_ok=True)
        (d / rel).write_bytes(data)
    return d


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--photo", default="train_ZRI_2061")
    ap.add_argument("--index", type=int, default=28, help="detection index in that photo")
    ap.add_argument("--split", default="val", choices=["val"], help="val only")
    ap.add_argument(
        "--pt", type=Path, default=ROOT / "data/weights/release_v2/yolo11s_tiles_run1_best.pt"
    )
    ap.add_argument("--out", type=Path, default=ROOT / "runs/av_chain")
    args = ap.parse_args(argv)

    from dotenv import load_dotenv
    from eval_verifier import photo_mission

    from sightline.agent import loop
    from sightline.agent.llm import NO_THINKING, token_factory_client
    from sightline.agent.trace import trace_call
    from sightline.ml.backend import make_detector
    from sightline.ml.data import load_split
    from sightline.ml.detect import Detector

    load_dotenv(ROOT / ".env")
    image = next(
        im
        for im in load_split(args.split, ROOT / "data/heridal/yolo_full")
        if im.path.stem == args.photo
    )
    det = Detector(args.pt).detect_tiled(image.path, conf=0.05)[args.index]
    print(f"{args.photo} #{args.index}: conf {det.conf:.3f}, box {det.box}")
    store, mid = photo_mission(image.path, det.box, det.conf, name=f"AV chain: {args.photo}")

    # The pipeline (lane D) has no trace entry for a detection; this script stands in for it.
    trace_call(
        store,
        mid,
        actor="pipeline",
        kind="note",
        summary=(
            f"detection f0001-d01 in {args.photo}: confidence {det.conf:.3f}, below the 0.29 review "
            "threshold, so it is not in the review queue (near-miss)"
        ),
        input={
            "photo": args.photo,
            "box_px_orig": [det.box.x1, det.box.y1, det.box.x2, det.box.y2],
        },
        refs=["f0001-d01"],
    )
    proposals = loop.handle(
        "detection",
        store,
        mid,
        "f0001-d01",
        client=token_factory_client(extra_body=NO_THINKING),
        detector=make_detector(weights=args.pt, backend="cv2"),
    )
    for p in proposals:
        print(f"proposal {p.id} {p.kind}: {p.summary}")
        if p.kind == "promote_detection":
            decided = store.decide_proposal(
                mid, p.id, "approve", by=SCRIPTED_APPROVER, reason="scripted demo run"
            )
            trace_call(
                store,
                mid,
                actor="human",
                kind="decision",
                summary=f"{p.id} approved by {SCRIPTED_APPROVER}",
                output={"proposal": p.id, "status": decided.status, "by": decided.decided_by},
                refs=[p.id, *p.target.values()],
            )
    d = dump(store, mid, args.out)
    pid = proposals[0].id if proposals else "<none>"
    print(f"wrote {d}\nprint it: uv run python scripts/trace_excerpt.py --dir {d} --proposal {pid}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
