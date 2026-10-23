"""The after-action report (contract §15, v1.3): one printable page on how the search went, built
from the mission's own record (state, trace, events, the timeline, the sectors). Written to
``report/after_action.md`` (and ``.json``) the moment the mission is found, and served on demand
(``GET /missions/{id}/report.md``, ``.json``).

Every number is counted from the log; nothing is estimated here except what says so (a leg's flight
minutes are its planned minutes when the fleet reported no start and end). A searched sector is
reported with the POD the team gave, never as done.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sightline.geo.exports import BLANK, _hhmm, _table, ics_time

LIMITS = (
    "Limitations: generated from the mission's log by Sightline. Simulated drones, links and demo "
    "scenarios are labelled as such in the log; a POD is the team's own estimate; radio text is "
    "speech recognition and can mishear; the probability map is a planning aid, not a finding. "
    "Check it before filing."
)


def _t(iso: str | None) -> datetime | None:
    return datetime.fromisoformat(iso) if iso else None


def _flight_minutes(fleet: Any, events: list[Any]) -> tuple[float, str]:
    """Minutes flown on legs: from the fleet's leg start and end notes when there are any, else the
    legs' planned minutes (and which it is)."""
    start: dict[str, str] = {}
    total = 0.0
    measured = False
    for ev in events:
        d = (ev.data or {}).get("drone") if ev.type == "mission.note" else None
        if not d or not d.get("leg"):
            continue
        if d.get("event") == "leg_start":
            start[d["leg"]] = ev.at
        elif d.get("event") == "leg_end" and d["leg"] in start:
            a, b = _t(start.pop(d["leg"])), _t(ev.at)
            if a and b:
                total += max(0.0, (b - a).total_seconds() / 60)
                measured = True
    if measured:
        return round(total, 1), "from the fleet's leg start and end reports"
    legs = [x for x in fleet.legs if x.status == "done"] if fleet else []
    return round(sum(x.est_minutes for x in legs), 1), "planned minutes of the legs flown"


def after_action(
    state: dict,
    trace: list[Any],
    events: list[Any],
    timeline: list[Any],
    sectors: list[dict],
    now: str,
    prior_source: str | None = None,
    frames: int | None = None,
) -> dict:
    """The report as JSON: one key per section. ``frames``: the survey's frame count (the photos
    processed), else the ``photo.processed`` events are counted."""
    m = state["mission"]
    teams = {t.id: t.callsign for t in state["teams"]}
    found = m.found
    end = found.at if found is not None else now
    photos = [e for e in events if e.type == "photo.processed"]
    reviews = [e for e in events if e.type == "mission.note" and (e.data or {}).get("answer")]
    candidates = {e.ref for e in events if e.type == "detection.new" and e.ref}
    verdicts = state["verdicts"]
    key = [x for x in timeline if x.kind in ("clue", "decision", "found")]
    first_photo = photos[0].at if photos else None
    log = ([{"at": first_photo, "kind": "photo", "text": "First photo processed"}] if first_photo else []) + [
        {"at": x.at, "kind": x.kind, "text": x.text, "by": x.by} for x in key
    ]  # fmt: skip
    log.sort(key=lambda r: r["at"])
    searched = [
        {"sector": t.sector_id, "team": teams.get(t.team_id or "", t.team_id), "pod": t.pod,
         "note": t.note, "at": t.updated_at}
        for t in sorted(state["tasks"], key=lambda t: t.updated_at) if t.state == "searched"
    ]  # fmt: skip
    coverage = sorted(
        ({"sector": s["sector_id"], "label": s["label"], "poa": s["poa"], "drone_coverage": s["drone_coverage"]}
         for s in sectors), key=lambda s: -s["drone_coverage"],
    )  # fmt: skip
    fleet = state["fleet"]
    minutes, how = _flight_minutes(fleet, events)
    legs = fleet.legs if fleet else []
    radio = [x for x in timeline if x.kind == "radio"]
    props: dict[str, dict[str, int]] = {}
    for p in state["proposals"]:
        row = props.setdefault(p.created_by, {"approved": 0, "rejected": 0, "superseded": 0,
                                              "expired": 0, "pending": 0})  # fmt: skip
        row[p.status] += 1
    direct = [e for e in trace if e.kind == "decision" and e.actor == "human"
              and (e.output or {}).get("action") not in (None, "found", "scenario")]  # fmt: skip
    mid = m.mission_id
    links = {
        "ics214": f"/missions/{mid}/ics214.md",
        "ics309": f"/missions/{mid}/ics309.md",
        "caltopo": f"/missions/{mid}/caltopo.geojson",
        "ics204": {
            t: f"/missions/{mid}/ics204/{t}.md"
            for t in sorted({x.team_id for x in state["tasks"] if x.team_id})
        },
    }
    return {
        "title": "After-action report",
        "incident_name": m.name,
        "mission_id": mid,
        "mode": m.mode,
        "status": m.status,
        "operational_period": {"from": m.created_at, "to": end},
        "base_camp": m.base_camp.model_dump() if m.base_camp else None,
        "subject": {
            "profile": m.subject,
            "last_seen_at": m.last_seen_at,
            "last_known_point": m.area.lkp.model_dump(),
            "prior": prior_source,
        },
        "found": None
        if found is None
        else {**found.model_dump(), "callsign": teams.get(found.team, found.team)},
        "key_events": log,
        "searched": searched,
        "drone_coverage": coverage,
        "photos": {
            "processed": len(photos) if frames is None else frames,
            "candidates": len(candidates),
            "second_looks": len(verdicts),
            "reviewed": len(reviews),
        },
        "drones": {
            "legs_flown": sum(x.status == "done" for x in legs),
            "legs_cancelled": sum(x.status == "cancelled" for x in legs),
            "flight_minutes": minutes,
            "flight_minutes_from": how,
            "simulated": bool(fleet and fleet.simulated),
        },
        "radio": {
            "turns": len({x.turn_id for x in radio}),
            "from_teams": sum(x.direction == "in" for x in radio),
            "from_command": sum(x.direction == "out" for x in radio),
        },
        "proposals": props,
        "direct_actions": len(direct),
        "links": links,
        "limitations": LIMITS,
        "generated_at": now,
    }


def after_action_markdown(r: dict) -> str:
    op = r["operational_period"]
    f = r["found"]
    camp = r["base_camp"]
    subj = r["subject"]
    lkp = subj["last_known_point"]
    if f is not None:
        outcome = (
            f"**Found** by {f['callsign']} in sector {f['sector'] or BLANK} at "
            f"{f['lat']:.5f}, {f['lon']:.5f}, {ics_time(f['at'])}."
        )
    else:
        outcome = f"**Not found yet** (status: {r['status']})."
    out = [
        f"# {r['title']}: {r['incident_name']}",
        "",
        outcome,
        "",
        _table(
            ["Operational period", "Base camp", "Mode"],
            [[f"{ics_time(op['from'])} to {ics_time(op['to'])}",
              f"{camp['name']} ({camp['lat']:.5f}, {camp['lon']:.5f})" if camp else None, r["mode"]]],
        ),
        "",
        "## Subject",
        "",
        _table(
            ["Profile", "Last seen", "Last known point", "Prior"],
            [[subj["profile"], ics_time(subj["last_seen_at"]), f"{lkp['lat']:.5f}, {lkp['lon']:.5f}",
              subj["prior"]]],
        ),
        "",
        "## Key events",
        "",
        _table(["Time", "What", "Who"], [[_hhmm(e["at"]), e["text"], e.get("by")] for e in r["key_events"]])
        if r["key_events"]
        else "Nothing logged.",
        "",
        "## Areas searched",
        "",
        _table(["Sector", "Team", "POD", "Note"],
               [[s["sector"], s["team"], f"{s['pod']:.0%}", s["note"]] for s in r["searched"]])
        if r["searched"]
        else "No sector reported searched by a ground team.",
        "",
        "Drone photo coverage by sector (share of its cells a photo looked at): "
        + (", ".join(f"{s['sector']} {s['drone_coverage']:.0%}" for s in r["drone_coverage"] if s["drone_coverage"])
           or "none") + ".",
        "",
        "## Photos, drones, radio, decisions",
        "",
        _table(
            ["Photos processed", "Candidates", "Second looks", "Reviewed by a person"],
            [[r["photos"]["processed"], r["photos"]["candidates"], r["photos"]["second_looks"],
              r["photos"]["reviewed"]]],
        ),
        "",
        _table(
            ["Drone legs flown", "Cancelled", "Flight minutes", "Fleet"],
            [[r["drones"]["legs_flown"], r["drones"]["legs_cancelled"],
              f"{r['drones']['flight_minutes']:g} ({r['drones']['flight_minutes_from']})",
              "simulated" if r["drones"]["simulated"] else "real"]],
        ),
        "",
        _table(
            ["Radio turns", "From teams", "From command"],
            [[r["radio"]["turns"], r["radio"]["from_teams"], r["radio"]["from_command"]]],
        ),
        "",
        _table(
            ["Proposals by", "Approved", "Rejected", "Superseded", "Expired", "Pending"],
            [[who, c["approved"], c["rejected"], c["superseded"], c["expired"], c["pending"]]
             for who, c in sorted(r["proposals"].items())],
        )
        if r["proposals"]
        else "No proposals.",
        "",
        f"Direct actions by the search manager: {r['direct_actions']}.",
        "",
        "## Forms and files",
        "",
        f"- ICS 214 Activity Log: `{r['links']['ics214']}`",
        f"- ICS 309 Communications Log: `{r['links']['ics309']}`",
        *(f"- ICS 204 Assignment List, {t}: `{u}`" for t, u in r["links"]["ics204"].items()),
        f"- CalTopo / SARTopo GeoJSON: `{r['links']['caltopo']}`",
        "",
        r["limitations"],
        "",
        f"Generated {ics_time(r['generated_at'])}.",
        "",
    ]  # fmt: skip
    return "\n".join(out)


def build(store: Any, mission_id: str, now: str) -> dict:
    """The report for a mission in ``store`` now."""
    from sightline.mission import effects
    from sightline.mission.timeline import mission_timeline

    try:
        prior = store.live(mission_id).base.params.prior_source
    except ValueError:
        prior = None
    return after_action(
        store.state(mission_id), store.trace_entries(mission_id), store.events(mission_id),
        mission_timeline(store, mission_id), effects.sector_overview(store, mission_id), now, prior,
        len(store.survey(mission_id).frames),
    )  # fmt: skip


def write(store: Any, mission_id: str, now: str) -> dict:
    """Build the report and keep it with the mission (``report/after_action.md`` and ``.json``)."""
    import json

    r = build(store, mission_id, now)
    store.put_file(mission_id, "report/after_action.md", after_action_markdown(r).encode())
    store.put_file(mission_id, "report/after_action.json", json.dumps(r, indent=1).encode())
    return r
