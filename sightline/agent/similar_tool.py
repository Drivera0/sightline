"""``find_similar``: after a confirmed sighting, ask for more photos like it (docs/report/SIMILAR.md).

Rule: the agent asks for similar photos only after a confirmed sighting (a reviewer answers
"person", or the second look says ``yes``); the answer is proposals, never promotions. One
``tool_call`` entry (actor ``agent``) records the query, the model, the threshold, every match and
what it cost; then one ``promote_detection`` proposal per match the queue does not hold yet, each
approved on its own through the normal path (``POST /missions/{id}/proposals/{pid}/decide``).

- **Matches**: the cosine top ``K`` of the mission's detection crops (``sightline/ml/similar.py``)
  at or above ``THRESHOLD`` (chosen on val), from **other photos** of the flight, without crops a
  reviewer already answered and detections already promoted or waiting for a decision. The query's
  own photo is left out: its crops share the ground around the person, which made the closest
  false matches on val, and the reviewer who confirmed it has just looked at that photo.
- **Proposals**: at most ``MAX_PROPOSALS``, for matches below the review threshold (0.29): those
  are the ones nobody would see otherwise. Matches already in the queue are named in the tool
  call's output and in a ``mission.note`` (the feed), so the reviewer can look at them next;
  approving a promotion for them would change nothing.
- **Once per detection**: a second confirmation of the same detection makes no new call.
- **Failure**: no key (no embedder) means the tool is off and nothing is written; an endpoint
  failure is a trace note naming the error, and no proposal.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from sightline.agent.trace import trace_call
from sightline.contract import EvidenceRef, Proposal
from sightline.ml import similar

log = logging.getLogger(__name__)

TOOL = "find_similar"
THRESHOLD = similar.DEFAULT_THRESHOLD
K = similar.DEFAULT_K
MAX_PROPOSALS = 3
MIN_CONF = 0.15  # the verifier's band: crops below it are not indexed (VERIFY_BAND[0])
REVIEW_THRESHOLD = 0.29  # loop.CANDIDATE_THRESHOLD (not imported: the loop imports this module)


def chain_id_for(detection_id: str) -> str:
    return f"similar-{detection_id}"


def _asked_before(store: Any, mission_id: str, detection_id: str) -> bool:
    return any(
        e.actor == "agent"
        and e.kind == "tool_call"
        and e.summary.startswith(TOOL)
        and e.refs[:1] == [detection_id]
        for e in store.trace_entries(mission_id)
    )


def _reviewed(store: Any, mission_id: str) -> set[str]:
    return {
        e.ref
        for e in store.events(mission_id)
        if e.type == "mission.note" and e.ref and isinstance(e.data, dict) and "answer" in e.data
    }


def find_similar(
    store: Any,
    mission_id: str,
    detection_id: str,
    embedder: similar.Embedder | None,
    *,
    why: str,
    threshold: float = THRESHOLD,
    k: int = K,
) -> list[Proposal]:
    """Proposals to review the photos most like ``detection_id`` (module docstring). ``why``:
    the confirmation, in words ("a reviewer confirmed f0336-d01 as a person")."""
    if embedder is None or _asked_before(store, mission_id, detection_id):
        return []
    from sightline.agent import loop  # the loop imports this module

    chain = chain_id_for(detection_id)
    t0 = time.perf_counter()
    try:
        built = similar.build_index(store, mission_id, embedder, min_conf=MIN_CONF)
    except similar.EmbedError as e:
        trace_call(store, mission_id, actor="agent", kind="note",
                   summary=f"{TOOL} for {detection_id} failed: {e}",
                   output={"type": "similar", "chain_id": chain, "error": str(e)},
                   refs=[detection_id, chain])  # fmt: skip
        return []
    index = built.index
    if detection_id not in index.ids:
        trace_call(store, mission_id, actor="agent", kind="note",
                   summary=f"{TOOL}: no crop of {detection_id} to compare",
                   output={"type": "similar", "chain_id": chain}, refs=[detection_id, chain])  # fmt: skip
        return []
    state = store.state(mission_id)
    reviewed = _reviewed(store, mission_id)
    taken = {
        p.target.get("detection")
        for p in state["proposals"]
        if p.kind == "promote_detection" and p.status in ("pending", "approved")
    }
    dets = similar.detections_by_id(store, mission_id)
    frame_id = dets[detection_id][1]
    same_photo = {d for d, (_, fid) in dets.items() if fid == frame_id}
    matches = similar.top_k(
        index.vector(detection_id),
        index.ids,
        index.vectors,
        k=k,
        min_score=threshold,
        exclude={detection_id, *reviewed, *taken, *same_photo},
    )
    to_propose = [m for m in matches if dets[m.id][0].conf < REVIEW_THRESHOLD][:MAX_PROPOSALS]
    in_queue = [m for m in matches if dets[m.id][0].conf >= REVIEW_THRESHOLD]
    ms = round((time.perf_counter() - t0) * 1000)
    n = len(to_propose)
    summary = (
        f"{TOOL}: review {n} photo{'s' if n != 1 else ''} like {detection_id} "
        f"(similarity ≥ {threshold:.2f})"
    )
    if in_queue:
        summary += f"; {len(in_queue)} more already in the review queue"
    rows = [
        {"detection": m.id, "frame": dets[m.id][1], "score": m.score,
         "conf": dets[m.id][0].conf, "crop": built.crops.get(m.id),
         "action": "propose" if m in to_propose else
                   "in the review queue" if m in in_queue else "over the proposal cap"}
        for m in matches
    ]  # fmt: skip
    trace_call(
        store,
        mission_id,
        actor="agent",
        kind="tool_call",
        summary=summary,
        input={"tool": TOOL, "detection": detection_id, "why": why, "k": k,
               "threshold": threshold, "model": index.model,
               "query_crop": built.crops.get(detection_id),
               "excluded": {"reviewed": sorted(reviewed & set(index.ids)),
                            "proposed": sorted(x for x in taken if x),
                            "same_photo": sorted(same_photo - {detection_id})}},
        output={"type": "similar", "chain_id": chain, "indexed": len(index.ids),
                "embedded_now": built.embedded_now, "calls": built.stats,
                "matches": rows, "ms": ms},
        refs=[detection_id, chain, *(m.id for m in matches)],
    )  # fmt: skip
    if in_queue:
        names = ", ".join(f"{m.id} ({m.score:.2f})" for m in in_queue)
        store.emit(mission_id, "mission.note",
                   f"In the review queue and like confirmed {detection_id}: {names}",
                   ref=detection_id, data={"similar": [m.id for m in in_queue], "like": detection_id})  # fmt: skip
    query_crop = built.crops.get(detection_id)
    out = []
    for i, m in enumerate(to_propose, 1):
        det = dets[m.id][0]
        evidence = [
            EvidenceRef(kind="crop", ref=built.crops[m.id],
                        caption=f"{m.id}: detector confidence {det.conf:.2f}"),
        ]  # fmt: skip
        if query_crop:
            evidence.append(
                EvidenceRef(kind="crop", ref=query_crop, caption=f"confirmed: {detection_id}")
            )
        out.append(
            loop._add(
                store,
                mission_id,
                (chain,),
                kind="promote_detection",
                summary=(
                    f"Review {m.id}: looks like confirmed {detection_id} "
                    f"(similarity {m.score:.2f}; {i} of {n})"
                ),
                reason=(
                    f"{why[:1].upper()}{why[1:]}. Of this flight's crops, {m.id} is among the "
                    f"{k} most like it (similarity {m.score:.2f}, at or above {threshold:.2f}, "
                    f"{index.model}). Its detector confidence {det.conf:.2f} is below the review "
                    f"threshold {REVIEW_THRESHOLD}, so no reviewer would see it otherwise."
                ),
                target={"detection": m.id, "like": detection_id},
                evidence=evidence,
                created_by="agent",
            )
        )
    return out
