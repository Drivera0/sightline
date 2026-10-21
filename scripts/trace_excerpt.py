"""Print the causal chain behind one proposal from a mission's agent trace (A-G2, LANE_A §5.7).

    uv run python scripts/trace_excerpt.py --mission <id> --proposal <pid> [--root missions]
    uv run python scripts/trace_excerpt.py --dir runs/av_chain/<id> --proposal <pid> [--markdown]

Reads ``trace.jsonl`` only. Starting from the proposal, it follows ``refs`` back and forward:
the detection it concerns, every OpenCV re-look (tool calls with their image paths), the
Nemotron VL call (model, ms, tokens), the verdict, the proposal, and the human decision. This is
the OpenCV Agentic Vision evidence: an OpenCV 5 result feeding a later model call and proposal.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def chain(entries: list[dict], proposal: str) -> list[dict]:
    """The entries linked to ``proposal`` through shared refs, in trace order."""
    linked = {proposal}
    for e in entries:  # the proposal's own refs (detection, verdict, team, ...)
        if proposal in e["refs"]:
            linked |= set(e["refs"])
    changed = True
    while changed:  # e.g. detection -> verdict id -> the verdict entry
        changed = False
        for e in entries:
            refs = set(e["refs"])
            if refs & linked and not refs <= linked:
                linked |= refs
                changed = True
    return [e for e in entries if set(e["refs"]) & linked]


def describe(e: dict) -> list[str]:
    """One entry as a heading line and indented detail lines."""
    head = f"{e['at']}  {e['actor']:<8} {e['kind']:<10} {e['summary']}"
    lines = [head]
    inp, out = e.get("input") or {}, e.get("output") or {}
    if e["kind"] == "tool_call":
        lines.append(f"    image: {out.get('image')}  ({out.get('ms')} ms)")
        if "boxes" in out:
            lines.append(f"    re-detected boxes: {out['boxes']}")
        h = inp.get("heuristics")
        if h:
            lines.append(
                "    why this tool (heuristics): box {:.0f} px, aspect {:.2f}, grey spread {:.1f}".format(
                    h["long_px"], h["aspect"], h["contrast_std"]
                )
            )
    elif e["kind"] == "model_call":
        lines.append(
            f"    model {e['model']} · {e['ms']} ms · {e['tokens_in']} tokens in, "
            f"{e['tokens_out']} out · prompt {inp.get('prompt')}"
        )
        lines.append(f"    images sent: {inp.get('images')}")
        text = out.get("text") or ""
        try:
            text = json.dumps(json.loads(text), ensure_ascii=False)
        except json.JSONDecodeError:
            pass
        lines.append(f"    reply: {text}")
    elif e["kind"] == "verdict":
        lines.append(
            f"    person {out.get('person')} · posture {out.get('posture')} · "
            f"group {out.get('group_size')} · clothing {out.get('clothing')}"
        )
        lines.append(f"    reason: {out.get('reason')}")
    elif e["kind"] == "proposal":
        lines.append(f"    target {out.get('target')}")
        lines.append(f"    reason: {out.get('reason')}")
    elif e["kind"] == "decision":
        lines.append(f"    {out}")
    return lines


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--mission", help="mission id under --root")
    src.add_argument("--dir", type=Path, help="a mission directory holding trace.jsonl")
    ap.add_argument("--root", type=Path, default=Path("missions"))
    ap.add_argument("--proposal", required=True)
    ap.add_argument("--markdown", action="store_true", help="wrap in a fenced block for docs")
    args = ap.parse_args(argv)

    d = args.dir or args.root / args.mission
    entries = [json.loads(line) for line in (d / "trace.jsonl").read_text().splitlines() if line]
    found = chain(entries, args.proposal)
    if not any(e["kind"] == "proposal" and args.proposal in e["refs"] for e in found):
        print(f"no proposal {args.proposal} in {d / 'trace.jsonl'}", file=sys.stderr)
        return 1
    lines = [line for e in found for line in describe(e)]
    print("\n".join(["```text", *lines, "```"] if args.markdown else lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
