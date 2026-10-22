"""Replay the briefing situations of an agent-eval run through ``loop.write_briefing``.

The eval's traces record every briefing attempt with its facts (``model_call`` entries, summary
"briefing ..."). ``--from-traces`` reads a run's ``missions/*/trace.jsonl``, writes the briefing
situations (the facts of each first attempt, in order) to ``inputs.json`` and the run's own numbers
to ``before.json``. Without it, ``--inputs`` is replayed live through the production path
(``write_briefing`` with the agent's client: Nemotron 3 Nano, thinking off) and the numbers go to
``after.json`` and ``briefings.md``.

    uv run python scripts/briefing_replay.py --from-traces runs/agent_eval/<run> --out <dir>
    uv run --env-file .env python scripts/briefing_replay.py --inputs <dir>/inputs.json --out <dir>

Numbers: first-try acceptance, retry acceptance, fallbacks to the template, rejections by reason,
and per model call p50 latency and tokens in / out.
"""

from __future__ import annotations

import argparse
import json
import statistics
from collections import Counter
from pathlib import Path
from typing import Any

from sightline.agent import loop, prompts
from sightline.agent.llm import AGENT_TIMEOUT_S, NO_THINKING, ChatResult, token_factory_client


def _reason(problem: str) -> str:
    """A rejection reason without its details ("numbers not in the facts: ['3']" -> the label)."""
    return problem.split(":")[0].split(" (")[0]


def summarise(attempts: list[list[dict]]) -> dict[str, Any]:
    """``attempts``: per briefing, its model calls ({text, problems, ms, tokens_in, tokens_out})."""
    calls = [c for b in attempts for c in b]
    first_ok = sum(1 for b in attempts if b and not b[0]["problems"])
    retried = [b for b in attempts if b and b[0]["problems"]]
    retry_ok = sum(1 for b in retried if len(b) > 1 and not b[1]["problems"])
    reasons = Counter(_reason(p) for c in calls for p in c["problems"])
    return {
        "briefings": len(attempts),
        "first_try_accepted": first_ok,
        "retried": len(retried),
        "retry_accepted": retry_ok,
        "template_fallback": len(retried) - retry_ok,
        "model_calls": len(calls),
        "rejections": dict(reasons),
        "p50_ms": statistics.median(c["ms"] for c in calls) if calls else None,
        "p50_tokens_in": statistics.median(c["tokens_in"] for c in calls) if calls else None,
        "p50_tokens_out": statistics.median(c["tokens_out"] for c in calls) if calls else None,
        "tokens_in": sum(c["tokens_in"] for c in calls),
        "tokens_out": sum(c["tokens_out"] for c in calls),
        "words_accepted": sorted(
            len(c["text"].split()) for c in calls if not c["problems"] and c["text"]
        ),
    }


def from_traces(run: Path, out: Path) -> None:
    situations, attempts = [], []
    for trace in sorted(run.glob("missions/*/trace.jsonl")):
        mission = json.loads((trace.parent / "mission.json").read_text())
        current: list[dict] | None = None
        for line in trace.read_text().splitlines():
            e = json.loads(line)
            if e.get("kind") != "model_call" or not e.get("summary", "").startswith("briefing"):
                continue
            facts = e["input"]["facts"]
            text = (e.get("output") or {}).get("text", "")
            call = {
                "text": text,
                "problems": loop.check_briefing(text, facts),
                "ms": e["ms"],
                "tokens_in": e["tokens_in"],
                "tokens_out": e["tokens_out"],
            }
            # a retry follows a rejected first attempt with the same facts
            if current is not None and len(current) == 1 and current[0]["problems"]:
                current.append(call)
                continue
            current = [call]
            attempts.append(current)
            situations.append(
                {"mission": trace.parent.name, "name": mission.get("name"), "facts": facts}
            )
    out.mkdir(parents=True, exist_ok=True)
    (out / "inputs.json").write_text(json.dumps(situations, indent=1, ensure_ascii=False) + "\n")
    before = {"source": str(run), "prompt_version": "briefing-v1", **summarise(attempts)}
    (out / "before.json").write_text(json.dumps(before, indent=1) + "\n")
    print(json.dumps({k: v for k, v in before.items() if k != "words_accepted"}, indent=1))


class Recording:
    """The agent's client, recording each briefing call's result for the numbers."""

    def __init__(self, client: Any) -> None:
        self.client, self.results = client, []

    def chat(self, messages: list[dict], **kw: Any) -> ChatResult:
        r = self.client.chat(messages, **kw)
        self.results.append(r)
        return r


def replay(inputs: Path, out: Path) -> None:
    situations = json.loads(inputs.read_text())
    client = Recording(token_factory_client(extra_body=NO_THINKING, timeout_s=AGENT_TIMEOUT_S))
    attempts, rows = [], []
    for i, s in enumerate(situations, 1):
        client.results = []
        text = loop.write_briefing(s["facts"], client)
        calls = [
            {
                "text": r.text.strip(),
                "problems": loop.check_briefing(r.text.strip(), s["facts"]),
                "ms": r.ms,
                "tokens_in": r.tokens_in,
                "tokens_out": r.tokens_out,
            }
            for r in client.results
        ]
        attempts.append(calls)
        outcome = (
            "template"
            if text == loop.template_briefing(s["facts"])
            else ("first try" if len(calls) == 1 else "retry")
        )
        rows.append((i, s["name"], outcome, calls, text))
    after = {
        "source": str(inputs),
        "prompt_version": prompts.BRIEFING_VERSION,
        "model": client.results[0].model if client.results else None,
        **summarise(attempts),
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / "after.json").write_text(json.dumps(after, indent=1) + "\n")
    lines = [
        f"# Briefing replay ({prompts.BRIEFING_VERSION})",
        "",
        (
            f"{len(situations)} briefing situations from `{inputs}`, each through "
            "`loop.write_briefing` live (Nemotron 3 Nano, thinking off)."
        ),
        "",
        "| # | Mission | Outcome | Attempts (words; rejection) | Briefing sent |",
        "|---|---|---|---|---|",
    ]
    for i, name, outcome, calls, text in rows:
        tries = "; ".join(
            f"{len(c['text'].split())}"
            + (f" ({', '.join(c['problems'])})" if c["problems"] else "")
            for c in calls
        )
        lines.append(f"| {i} | {name} | {outcome} | {tries} | {text.replace('|', '/')} |")
    (out / "briefings.md").write_text("\n".join(lines) + "\n")
    print(json.dumps({k: v for k, v in after.items() if k != "words_accepted"}, indent=1))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--from-traces", type=Path, help="an agent-eval run folder (runs/agent_eval/…)")
    ap.add_argument("--inputs", type=Path, help="inputs.json written by --from-traces")
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()
    if a.from_traces:
        from_traces(a.from_traces, a.out)
    elif a.inputs:
        replay(a.inputs, a.out)
    else:
        ap.error("give --from-traces or --inputs")


if __name__ == "__main__":
    main()
