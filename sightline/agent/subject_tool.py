"""The agent's bulletin tool: when a mission has a last known point but no lost-person category,
the model decides whether to look for a public bulletin, and what to search for.

The Koester prior (``sightline.search.prior``) needs a category ("hiker", "dementia"); without one
the map starts uniform. ``search_subject`` gives Nemotron the mission's facts and one tool,
``search_public_bulletin(query)``. The model either calls it with a query it wrote, or says why not
(a replay of old photos has no missing person to look for). A call runs ``geo.subject``: Tavily
search on police, search-and-rescue and local news domains, extract, Nemotron Nano reads the pages
and returns each field with a verbatim quote and its URL, names redacted. A profile with a category
becomes **one proposal** for a person to approve:

    Set subject profile: hiker, 34, red jacket, last seen 3:30 p.m. at the Mount Seymour trailhead

Approving it (``apply_decision``, called by the decide endpoint) sets the mission's subject to that
text, rebuilds the map's prior with the category's rings (the map updates so far are replayed on it),
and queues ``subject_set`` for the agent, which re-plans the drones. Trace, in order: ``model_call``
(the decision), ``tool_call`` (Tavily search), ``tool_call`` (extract), ``model_call`` (the profile
with quotes), ``proposal``, ``decision``.

The proposal is an ``alert`` with target ``{"subject": "profile", ...}`` and no briefing (so the
radio never transmits it), not a new kind: a new kind would change the frozen contract (§10), as the
recall's reuse of ``retask_drone`` explains in ``loop.py``.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from sightline.agent.llm import MODEL_FAST, ChatResult, FakeChatClient, failure_text
from sightline.agent.trace import now_iso, trace_call
from sightline.contract import Distribution, EvidenceRef, Proposal
from sightline.geo import subject as geo_subject
from sightline.search.prior import koester_prior, prior_source, subject_category

log = logging.getLogger(__name__)

TOOL_NAME = "search_public_bulletin"
TOOL = {
    "type": "function",
    "function": {
        "name": TOOL_NAME,
        "description": (
            "Search police, search-and-rescue and local news sites for a public bulletin about "
            "this missing person, read the best pages, and return their age, category (hiker or "
            "dementia), last seen time and place, and clothing, each with the sentence it came "
            "from. Names are removed."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "A short web search query (under 20 words): the place, the "
                    "date and 'missing'; never a guessed name.",
                }
            },
            "required": ["query"],
        },
    },
}
DECIDE_PROMPT = """You are the planning agent of a search-and-rescue mission. The probability map's
prior uses Koester's lost-person distance rings, which need a lost-person category (hiker or
dementia). This mission has none, so its prior is uniform over the area.
You have one tool, search_public_bulletin: it searches police, search-and-rescue and local news
sites for a public bulletin about the missing person and reads it. Call it with a short web search
query if a public bulletin about this person could exist. Otherwise do not call it and say in one
sentence why not. A mission in mode "replay" re-runs recorded photos: there is no missing person to
look for. Never guess a person's name."""
FACTS_KEY = "Mission facts:"  # the decision's user message starts with this
LABELS = {
    "category": "Category",
    "age": "Age",
    "last_seen_time": "Last seen",
    "last_seen_place": "Last seen at",
    "clothing": "Clothing",
}

# The demo's scripted model (SIGHTLINE_FAKE_LLM=1): it searches, then reads the synthetic bulletin
# (tests/geo/fixtures/subject_bulletin_synthetic.html) with these quotes, copied from that page.
DEMO_QUERY = "missing hiker Mount Seymour police bulletin"
DEMO_FIELDS = {
    "age": {"value": 34, "quote": "Jordan Example, 34, a hiker", "doc": 0},
    "category": {"value": "hiker", "quote": "a hiker who did not return from a day hike", "doc": 0},
    "last_seen_time": {"value": "3:30 p.m.", "quote": "last seen at about 3:30 p.m.", "doc": 0},
    "last_seen_place": {
        "value": "the Mount Seymour trailhead parking lot",
        "quote": "at the Mount Seymour trailhead parking lot",
        "doc": 0,
    },
    "clothing": {
        "value": "red jacket, black hiking pants and a grey backpack",
        "quote": "wearing a red jacket, black hiking pants and a grey backpack",
        "doc": 0,
    },
}


def demo_client() -> FakeChatClient:
    """The scripted model for the offline demo and tests: the tool call, then the profile."""
    call = ChatResult(
        text="",
        tool_calls=[{"id": "call_demo", "name": TOOL_NAME, "arguments": {"query": DEMO_QUERY}}],
        model=f"{MODEL_FAST} (scripted demo)",
        ms=0,
        tokens_in=0,
        tokens_out=0,
    )
    read = json.dumps({"fields": DEMO_FIELDS, "names": ["Jordan Example"]})
    return FakeChatClient(replies={FACTS_KEY: call, "[doc 0]": read})


def default_client() -> Any:
    """The scripted demo model with ``SIGHTLINE_FAKE_LLM=1``; else Token Factory (thinking off);
    None without a key."""
    if os.environ.get("SIGHTLINE_FAKE_LLM") == "1":
        return demo_client()
    from sightline.agent.llm import NO_THINKING, LLMError, token_factory_client

    try:
        return token_factory_client(extra_body=NO_THINKING)
    except LLMError:
        return None


def is_subject_proposal(p: Proposal) -> bool:
    return p.kind == "alert" and p.target.get("subject") == "profile"


def _domain(url: str) -> str:
    if url == geo_subject.SYNTHETIC_URL:
        return "synthetic demo bulletin"
    return urlparse(url).netloc.removeprefix("www.") or url


def _facts(m: Any) -> dict:
    return {
        "mission": m.name,
        "area": m.area.name,
        "last_known_point": {"lat": m.area.lkp.lat, "lon": m.area.lkp.lon},
        "last_seen_at": m.last_seen_at,
        "mission_started": m.created_at[:10],
        "mode": m.mode,
        "subject": m.subject or "not given",
        "prior": "uniform (no lost-person category)",
    }


def _cache_dir(store: Any, mission_id: str) -> Path:
    return Path(store.root) / mission_id / "subject_cache"


def search_subject(
    store: Any,
    mission_id: str,
    *,
    client: Any,
    tavily: Any = None,
    cache_dir: Path | None = None,
    now: str | None = None,
) -> dict:
    """Let the model decide whether to search for a bulletin; propose the profile it finds.
    Returns ``{"searched", "why", "profile", "proposal"}`` (the proposal as a dict, or None)."""

    def trace(**kw: Any) -> None:
        trace_call(store, mission_id, actor="agent", **kw)

    def done(why: str, searched: bool = False, profile: Any = None, p: Any = None) -> dict:
        if p is None:
            trace(kind="note", summary=f"subject: {why}")
        return {"searched": searched, "why": why, "profile": profile,
                "proposal": p.model_dump() if p is not None else None}  # fmt: skip

    state = store.state(mission_id)
    m = state["mission"]
    category = subject_category(m.subject)
    if category is not None:
        return done(f"the subject already names a category ({category}): no bulletin search")
    pending = [p for p in state["proposals"] if is_subject_proposal(p) and p.status == "pending"]
    if pending:
        return done(f"{pending[0].id} is waiting for a decision: no new search")
    if client is None:
        return done("no model to decide on a bulletin search (no NEBIUS_API_KEY)")

    messages = [
        {"role": "system", "content": DECIDE_PROMPT},
        {"role": "user", "content": FACTS_KEY + "\n" + json.dumps(_facts(m), ensure_ascii=False)},
    ]
    try:
        r = client.chat(messages, model=MODEL_FAST, tools=[TOOL], temperature=0.0, max_tokens=400)
    except Exception as e:  # noqa: BLE001 - offline, budget: no search, said why
        return done(f"the decision call failed ({failure_text(e)}): no search")
    call = next((c for c in r.tool_calls if c["name"] == TOOL_NAME), None)
    query = str((call or {}).get("arguments", {}).get("query") or "").strip()[:300]
    trace(kind="model_call",
          summary=f"subject: the model chose to search: {query}" if query
          else "subject: the model chose not to search",
          input={"facts": _facts(m), "tools": [TOOL_NAME]},
          output={"tool_calls": r.tool_calls, "text": r.text}, result=r)  # fmt: skip
    if not query:
        return done(f"the model chose not to search: {r.text.strip()[:200] or 'no reason given'}")

    found = geo_subject.lookup_subject(
        query,
        cache_dir=cache_dir or _cache_dir(store, mission_id),
        now=now,
        tavily=tavily,
        client=client,
        trace=trace,
    )
    if found.get("cached"):
        trace(kind="note", summary="subject: reused this hour's bulletin lookup (no Tavily calls)")
    values = found["values"]
    if not values.get("category"):
        why = found.get("error") or (
            "no page stated a lost-person category with a quote"
            + (f" ({', '.join(found['sources'])})" if found["sources"] else " (no pages found)")
        )
        return done(f"{why}: no proposal", searched=True, profile=found)

    text = geo_subject.profile_text(values)
    category = values["category"]
    if subject_category(text) != category:
        text = f"{text} ({category})"
    rejected = [
        p
        for p in state["proposals"]
        if is_subject_proposal(p) and p.status == "rejected" and p.target.get("profile") == text
    ]
    if rejected:
        return done(f"the same profile was rejected in {rejected[0].id}: no new proposal",
                    searched=True, profile=found)  # fmt: skip
    p = _propose(store, mission_id, found, text, category)
    return done("proposed", searched=True, profile=found, p=p)


def _propose(store: Any, mission_id: str, found: dict, text: str, category: str) -> Proposal:
    values, quotes, urls = found["values"], found["quotes"], found["urls"]
    said = []
    for field in ("category", "age", "last_seen_time", "last_seen_place", "clothing"):
        if values.get(field) is None:
            continue
        shown = values[field].split("/")[0] if field == "category" else values[field]
        said.append(f'{LABELS[field]} {shown} ("{quotes[field]}", {_domain(urls[field])})')
    reason = (
        "From a public bulletin found with Tavily: "
        + "; ".join(said)
        + f". Approving sets the lost-person category to {category}: the prior becomes "
        f"{prior_source(category)}, and the drones are re-planned on it. Names are redacted."
    )
    by_url: dict[str, list[str]] = {}
    for field, url in urls.items():
        by_url.setdefault(url, []).append(quotes[field])
    evidence = [
        EvidenceRef(kind="trace", ref=url, caption=" / ".join(qs)[:300])
        for url, qs in by_url.items()
    ]
    p = store.add_proposal(
        mission_id,
        Proposal(
            id="",
            kind="alert",
            summary=f"Set subject profile: {text}"[:200],
            reason=reason,
            briefing=None,  # not for the radio: an approved alert without a briefing is not sent
            target={"subject": "profile", "category": category, "profile": text},
            evidence=evidence,
            status="pending",
            created_by="agent",
            created_at=now_iso(),
            decided_at=None,
            decided_by=None,
            decision_reason=None,
            edits=None,
        ),
    )
    trace_call(store, mission_id, actor="agent", kind="proposal",
               summary=f"{p.id} {p.kind}: {p.summary}",
               output={"proposal": p.id, "kind": p.kind, "target": p.target, "reason": p.reason},
               refs=[p.id, *urls.values()])  # fmt: skip
    return p


# --- approval ------------------------------------------------------------------------------------


def _set_subject(store: Any, mission_id: str, text: str) -> None:
    m = store.get(mission_id).model_copy(update={"subject": text})
    setter = getattr(store, "set_mission", None)
    if setter is not None:  # the tests' in-memory store
        setter(m)
        return
    with store._lock(mission_id) as d:  # MissionStore has no mission update; same file, same lock
        store._save(d, "mission.json", m)


def _set_prior(store: Any, mission_id: str, category: str) -> str:
    """The map's prior rebuilt with the category's rings on the same grid and LKP; the map updates
    so far are replayed on it by the store. Returns the new ``prior_source``."""
    base = store.live(mission_id).base
    p, outside = koester_prior(base.grid, base.lkp, category)
    source = prior_source(category)
    store.put_map_base(
        mission_id,
        base.model_copy(
            update={
                "prior": Distribution(p=[float(x) for x in p], outside=float(outside)),
                "params": base.params.model_copy(update={"prior_source": source}),
            }
        ),
    )
    return source


def apply_decision(store: Any, mission_id: str, p: Proposal, hooks: Any = None) -> None:
    """After a decision on a subject proposal (the decide endpoint has traced it): on approval set
    the subject and the prior and queue the re-plan (``hooks.on_subject_set``)."""
    if not is_subject_proposal(p):
        return
    if p.status != "approved":
        return
    _set_subject(store, mission_id, p.target["profile"])
    try:
        source = _set_prior(store, mission_id, p.target["category"])
        said = f"prior is now {source}"
    except (ValueError, NotImplementedError) as e:  # no map yet: the subject still holds it
        said = f"prior unchanged ({e})"
    store.emit(mission_id, "mission.note", f"Subject profile set ({p.id}): {p.target['profile']}; {said}",
               ref=p.id, data={"subject": p.target, "proposal": p.id})  # fmt: skip
    hook = getattr(hooks, "on_subject_set", None) if hooks is not None else None
    if hook is not None:
        try:
            hook(store, mission_id, p.id)
        except Exception:
            log.exception("on_subject_set failed")


# --- agent events (loop.handle) ------------------------------------------------------------------


def handle(event: str, store: Any, mission_id: str, ref: str, *, client: Any) -> list[Proposal]:
    """``subject_search``: the search above, run by the agent; ``subject_set``: the re-plan after
    an approved profile (``ref`` is the proposal)."""
    from sightline.agent import loop

    if event == "subject_search":
        out = search_subject(store, mission_id, client=client)
        return [Proposal.model_validate(out["proposal"])] if out["proposal"] else []
    p = next((x for x in store.state(mission_id)["proposals"] if x.id == ref), None)
    profile = p.target.get("profile") if p is not None else "set"
    why = f"Subject profile {ref} approved ({profile}): new prior."
    return loop._replan(store, mission_id, why, cause=(ref,))
