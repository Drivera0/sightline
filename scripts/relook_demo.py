"""The re-look moment end to end, offline: an unclear second look on a small box sends a drone lower.

    uv run python scripts/relook_demo.py [--val data/heridal/yolo_full/val] [--out runs/relook/...]

1. The real mission API (``create_app``, ``MissionStore``, the photo worker, the live map, the planner
   and the agent's runner) runs in this process on a local port, as in ``scripts/agent_eval.py``.
   The creek scenario's three simulated drones join; a scripted search manager approves the agent's
   opening legs.
2. A photo from 50 m over the hidden person: the detector (scripted from the scenario's truth, as in
   the agent eval) gives a 0.20 near-miss, 21 px long in the original photo.
3. **second look**: the model client is the fake-LLM fixture (``SIGHTLINE_FAKE_LLM=1`` with
   ``SIGHTLINE_FAKE_VL=relook``: the first verdict is ``unclear``, every later one ``yes``, both
   labelled fake in their reason). Under 60 px and unclear, the agent proposes a ``drone_leg`` (or
   ``retask_drone``) over the spot at 25 m: "box 21 px, too small to verify; a pass at 25 m gives
   about 4× the pixels".
4. **approval**: the scripted manager approves it (``decided_by`` says it was scripted).
5. **low pass**: the fleet sim's ``DroneSim`` flies the leg through the API; its photos are taken at
   25 m (``fleet.at_altitude``: the person twice as large, resampled from the 50 m crop).
6. **pipeline again**: detector → second look (``yes``) → ``promote_detection``; the leg is done and
   the ledger records expected vs realised value.

Prints the re-look chain (``chain_id``) and the ledger from the trace and saves them, with the trace,
under ``runs/relook/<timestamp>/``. Validation photos only (``--val``); without them, plain synthetic
photos with the same pose. No network, no keys.

A server for the showcase gets the same scripted second look with
``SIGHTLINE_FAKE_LLM=1 SIGHTLINE_FAKE_VL=relook python -m sightline.pipeline serve``.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def _agent_eval():
    spec = importlib.util.spec_from_file_location("agent_eval", ROOT / "scripts/agent_eval.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["agent_eval"] = mod
    spec.loader.exec_module(mod)
    return mod


def run(out: Path, val: Path) -> dict:
    """The demo in a new mission; returns the chain, the ledger and the flights."""
    os.environ.update(SIGHTLINE_FAKE_LLM="1", SIGHTLINE_FAKE_VL="relook", SIGHTLINE_FAKE_TAVILY="1")
    ae = _agent_eval()
    from sightline.agent.llm import token_factory_client
    from sightline.agent.relook_leg import chains

    t0 = time.monotonic()

    def mark(what: str) -> None:
        print(f"[{time.monotonic() - t0:6.1f} s] {what}", flush=True)

    h = ae.Harness(out, val)
    try:
        h.use_client(token_factory_client)  # the fixture switch, through the agent's runner
        h.detector.conf = ae.NEAR_MISS_CONF
        h.detector.person_px = ae.PERSON_PX_50M
        m = ae.Mission(h, "re-look demo")
        m.create()
        m.join_fleet()
        m.opening_legs()
        mark(f"mission {m.mid}: drones flying their opening legs ({h.photos.source})")
        hidden = h.scn.hidden
        (det,) = m.photo(hidden.lat, hidden.lon, positive=True, k=9)
        mark(f"photo from 50 m: near-miss {det}")
        relooks = [p for p in m.pending("drone_leg", "retask_drone") if "relook" in p.target]
        if not relooks:
            raise SystemExit("no re-look leg was proposed: see the trace")
        p = relooks[0]
        mark(f"proposal {p.id} {p.kind}: {p.summary}\n           {p.reason}")
        m.decide(p.id)
        mark(f"{p.id} approved by the scripted manager")
        flight = m.fly_leg(p.target["leg"])
        mark(f"{flight['leg']} flown by {flight['drone']} at {flight['altitude_m']:.0f} m: "
             f"{flight['photos']} photos, {flight['sim_minutes']} sim min")  # fmt: skip
        promoted = [x for x in m.pending("promote_detection")]
        for x in promoted:
            mark(f"proposal {x.id} promote_detection: {x.summary}")
        trace = h.store.trace_entries(m.mid)
        chain = chains(h.store, m.mid)
        ledger = [e.output for e in trace if (e.output or {}).get("type") == "ledger"]
        print("\nThe chain (trace notes, output.type = relook):")
        for cid, steps in chain.items():
            for s in steps:
                print(f"  {cid} {s['step']:8s} " + ", ".join(
                    f"{k}={s[k]}" for k in ("detection", "verdict", "proposal", "leg", "frame",
                                            "altitude_m", "box_long_px", "pixel_factor", "outcome")
                    if s.get(k) is not None))  # fmt: skip
        print("\nThe ledger (trace notes, output.type = ledger):")
        for r in ledger:
            print(f"  {r['kind']:11s} {r['ref']:10s} {r['chain_id']:18s} expected "
                  f"{r['expected']['gain']:.6f} realised {r['realised']['gain']:.6f} "
                  f"delta {r['delta']:+.6f}")  # fmt: skip
        result = {
            "mission": m.mid,
            "photos": h.photos.source,
            "proposal": p.model_dump(),
            "flight": flight,
            "promoted": [x.model_dump() for x in promoted],
            "chains": chain,
            "ledger": ledger,
        }
        (out / "relook.json").write_text(json.dumps(result, indent=1, default=str))
        (out / "trace.jsonl").write_text(
            "\n".join(e.model_dump_json() for e in trace) + "\n", encoding="utf-8"
        )
        return result
    finally:
        h.close()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--val", type=Path, default=ROOT / "data/heridal/yolo_full/val")
    ap.add_argument("--out", type=Path, default=None, help="default runs/relook/<timestamp>")
    args = ap.parse_args(argv)
    out = args.out or ROOT / "runs/relook" / time.strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    res = run(out, args.val)
    ok = any(
        s["step"] == "outcome" and s["outcome"] == "resolved"
        for steps in res["chains"].values()
        for s in steps
    )
    print(f"\n{out / 'relook.json'}")
    return 0 if ok and res["promoted"] else 1


if __name__ == "__main__":
    sys.exit(main())
