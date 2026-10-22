"""Standard SAR outputs a command post can file (``docs/EXPORTS.md``):

- **ICS 204 Assignment List** for one team, from its assignment card (FEMA ICS 204 v3.1 blocks 1–9).
- **ICS 214 Activity Log** for the mission, from the trace's decisions, the clue log and the task
  board (FEMA ICS 214 v3.1 blocks 1–8).
- **CalTopo / SARTopo GeoJSON**: sectors, searched areas with their POD, drone legs, team positions
  and clues as one FeatureCollection with CalTopo's SimpleStyle properties (``title``,
  ``description``, ``class``, ``stroke``, ``stroke-opacity``, ``stroke-width``, ``fill``,
  ``fill-opacity``, ``marker-color``, ``marker-symbol``).

Pure functions over the mission state, trace and events (no I/O); the API serves them
(``sightline/api/exports.py``). Every value comes from the mission; what Sightline does not know
(names of section chiefs, phone numbers, the incident's ICS 205 channel plan) is left as a blank to
fill in by hand, never invented. A searched area is reported with its POD, never as done or empty.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sightline.contract import AssignmentCard, Leg, Proposal, TraceEntry
from sightline.geo.cards import RADIO_CHANNEL, SWEEP_M

FORM_VERSION = "v3.1"
POD_TARGET = 0.6  # the default POD asked of a ground sweep; contract caps a POD at 0.9
BLANK = "—"
SIGN = "________________"
LIVE_LEG = ("approved", "flying")

# CalTopo styles: strokes and fills with "#", marker colours without (as CalTopo writes them).
STYLE = {
    "sector": {"stroke": "#FF8800", "fill": "#FF8800", "fill-opacity": 0.05},
    "assigned": {"stroke": "#FF0000", "fill": "#FF0000", "fill-opacity": 0.1},
    "searched": {"stroke": "#0066FF", "fill": "#0066FF", "fill-opacity": 0.25},
    "leg": {"stroke": "#A200FF"},
}


# --- shared ------------------------------------------------------------------------------


def _dt(iso: str | None) -> datetime | None:
    if not iso:
        return None
    d = datetime.fromisoformat(iso)
    return d if d.tzinfo else d.replace(tzinfo=UTC)


def ics_time(iso: str | None) -> str:
    """'2026-10-24T20:30:00Z' → '10/24/2026 20:30 UTC' (ICS: month/day/year, 24-hour clock)."""
    d = _dt(iso)
    return BLANK if d is None else d.astimezone(UTC).strftime("%m/%d/%Y %H:%M UTC")


def _hhmm(iso: str | None) -> str:
    d = _dt(iso)
    return BLANK if d is None else d.astimezone(UTC).strftime("%H:%M UTC")


def _cell(x: Any) -> str:
    """One Markdown table cell: no pipes or line breaks, blanks shown as a dash."""
    if x is None or x == "":
        return BLANK
    return str(x).replace("|", "/").replace("\r", " ").replace("\n", " ").strip()


def _table(header: list[str], rows: list[list[Any]]) -> str:
    out = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    out += ["| " + " | ".join(_cell(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def _decisions(trace: list[TraceEntry]) -> dict[str, TraceEntry]:
    """The last decision entry per proposal id (kind ``decision``: who approved or rejected)."""
    out: dict[str, TraceEntry] = {}
    for e in trace:
        if e.kind != "decision":
            continue
        pid = (e.output or {}).get("proposal") or next((r for r in e.refs if r[:1] == "p"), None)
        if pid:
            out[pid] = e
    return out


def _who(entry: TraceEntry | None, p: Proposal | None) -> str | None:
    if entry is not None and (entry.output or {}).get("by"):
        return str(entry.output["by"])
    return p.decided_by if p is not None else None


def _team_name(teams: list[Any], tid: str | None) -> str | None:
    t = next((t for t in teams if t.id == tid), None)
    return t.callsign if t else tid


def _sweep_lines(card: AssignmentCard) -> tuple[int, str]:
    sweeps = [w for w in card.waypoints if w.note == "sweep"]
    if len(sweeps) < 2:
        return 0, ""
    a, b = sweeps[0], sweeps[1]
    runs = "east–west" if abs(b.lon - a.lon) > abs(b.lat - a.lat) else "north–south"
    return len(sweeps) // 2, runs


def _leg_words(leg: Leg, drones: dict[str, Any]) -> str:
    d = drones.get(leg.drone_id)
    name = d.name if d else leg.drone_id
    sim = " (simulated)" if d is not None and d.simulated else ""
    where = f"sector {leg.sector_id}" if leg.sector_id else "a route"
    return (
        f"{name}{sim} flies leg {leg.id} over {where} at {leg.altitude_m:g} m above ground, "
        f"about {leg.est_minutes:.0f} min ({leg.status})."
    )


# --- ICS 204 -----------------------------------------------------------------------------


def team_task(state: dict, team_id: str) -> Any | None:
    """The team's current sector task (assigned or in progress), the latest if several."""
    tasks = [
        t for t in state["tasks"] if t.team_id == team_id and t.state in ("assigned", "in_progress")
    ]
    return max(tasks, key=lambda t: t.updated_at) if tasks else None


def ics204(
    state: dict,
    trace: list[TraceEntry],
    team_id: str,
    card: AssignmentCard | None,
    now: str,
    pod_target: float = POD_TARGET,
) -> dict:
    """ICS 204 for one team: blocks 1–9 as a dict (the ``.json``; ``ics204_markdown`` prints it).
    ``card``: the team's assignment card, or None when the team has no sector."""
    mission, teams = state["mission"], state["teams"]
    team = next(t for t in teams if t.id == team_id)
    task = team_task(state, team_id)
    fleet = state["fleet"]
    drones = {d.id: d for d in fleet.drones} if fleet else {}
    sector = card.sector_id if card else None
    legs = (
        [x for x in fleet.legs if x.sector_id == sector and x.status in LIVE_LEG]
        if fleet and sector
        else []
    )

    # 5. Resources assigned: the team, then any drone flying a live leg over the sector
    remarks = [f"status {team.status}"]
    if team.position:
        remarks.append(
            f"last position {team.position.lat:.5f}, {team.position.lon:.5f} at {_hhmm(team.position_at)}"
        )
    if card:
        remarks.append(
            f"report to the {card.entry.name} of sector {card.sector_id} "
            f"({card.entry.lat:.5f}, {card.entry.lon:.5f}); GPX/KML of the card on a handheld GPS"
        )
    resources = [
        {
            "resource_identifier": f"{team.id} {team.callsign}",
            "leader": None,
            "persons": team.members,
            "contact": f"radio {RADIO_CHANNEL}, call sign {team.callsign}",
            "remarks": "; ".join(remarks),
        }
    ]
    for leg in legs:
        d = drones.get(leg.drone_id)
        resources.append(
            {
                "resource_identifier": f"{leg.drone_id} {d.name if d else ''}".strip()
                + (" (simulated)" if d is not None and d.simulated else ""),
                "leader": None,
                "persons": None,
                "contact": "Sightline command view (drone telemetry)",
                "remarks": f"leg {leg.id}, {leg.status}, {leg.altitude_m:g} m above ground"
                + (f", battery {d.battery_pct:.0f} %" if d else ""),
            }
        )

    # 6. Work assignment, in plain words
    if card is None:
        work = f"No sector is assigned to {team.callsign} ({team.id}) at {_hhmm(now)}. Stand by for an assignment."
    else:
        n, runs = _sweep_lines(card)
        hectares = card.area_m2 / 10_000
        parts = [
            f"{team.callsign}: grid sweep of sector {card.sector_id} ({card.sector_label}), "
            f"about {hectares:.1f} ha"
            + (f", in {n} sweep lines {SWEEP_M:g} m apart running {runs}" if n else "")
            + ".",
            f"Enter at the {card.entry.name} ({card.entry.lat:.5f}, {card.entry.lon:.5f})"
            + (
                f", {card.bearing_deg_from_team:.0f}° true and {card.distance_m_from_team:.0f} m "
                "from the team's last position."
                if card.bearing_deg_from_team is not None and card.distance_m_from_team is not None
                else "."
            ),
            (
                f"Target POD {pod_target:g} for this sector; report the POD you achieved when done "
                "(the sector is then marked searched at that POD)."
            ),
            f"POA now {card.poa:.1%}; drone photos have covered {card.drone_coverage:.0%} of it.",
        ]
        if card.look_for:
            parts.append("Look for: " + "; ".join(card.look_for) + ".")
        parts += [_leg_words(leg, drones) for leg in legs]
        work = " ".join(parts)

    # 7. Special instructions: conditions, daylight, no-fly
    c = state["conditions"]
    special = []
    if c is None:
        special.append("Conditions not fetched yet: check weather before entering the field.")
    else:
        line = card.conditions_line if card else None
        if line is None:
            bits = [
                f"wind {c.wind_kmh:.0f} km/h" if c.wind_kmh is not None else None,
                f"gusts {c.gust_kmh:.0f} km/h" if c.gust_kmh is not None else None,
                f"rain {c.precip_mm_h:g} mm/h" if c.precip_mm_h else None,
            ]
            line = ", ".join(b for b in bits if b) or None
        if line:
            special.append(
                f"Weather: {line} (as of {_hhmm(c.fetched_at)}{', stale' if c.stale else ''})."
            )
        mins = card.daylight_remaining_min if card else None
        if mins is not None:
            special.append(
                f"Daylight: {mins // 60} h {mins % 60:02d} min left to the end of civil twilight "
                f"({_hhmm(c.civil_twilight_end)}); plan the return before dark."
            )
        elif c.civil_twilight_end:
            special.append(f"Civil twilight ends {_hhmm(c.civil_twilight_end)}.")
        if c.flyable is False:
            special.append(f"No-fly for drones: {c.flyability_reason}.")
        for a in c.alerts:
            special.append(f"{a.kind.capitalize()}: {a.title}.")
        if c.exposure_band:
            special.append(f"Exposure: {c.exposure_note}.")
    special.append(
        "Report every clue by radio with where it is; mark a searched sector with the POD achieved."
    )

    # 9. Prepared by: whoever approved the assignment, from the trace
    decisions = _decisions(trace)
    approval = next(
        (
            p
            for p in reversed(state["proposals"])
            if p.kind == "assign_sector"
            and p.status == "approved"
            and p.target.get("team") == team_id
            and (sector is None or p.target.get("sector") == sector)
        ),
        None,
    )
    entry = decisions.get(approval.id) if approval else None
    preparer = _who(entry, approval)

    return {
        "form": "ICS 204",
        "form_version": FORM_VERSION,
        "title": "Assignment List",
        "incident_name": mission.name,
        "operational_period": {"from": mission.created_at, "to": now},
        "branch": None,
        "division": f"Sector {card.sector_id} ({card.sector_label})" if card else None,
        "group": None,
        "staging_area": None,
        "operations_personnel": [
            {"role": r, "name": None, "contact": None}
            for r in ("Operations Section Chief", "Branch Director", "Division/Group Supervisor")
        ],
        "resources_assigned": resources,
        "work_assignments": work,
        "special_instructions": special,
        "communications": [
            {
                "name_function": "Command / tactical: Sightline radio desk",
                "primary_contact": f"radio {RADIO_CHANNEL} (placeholder: confirm against the incident's ICS 205)",
            },
            {
                "name_function": f"{team.callsign} ({team.id})",
                "primary_contact": f"radio {RADIO_CHANNEL}",
            },
        ],
        "prepared_by": {
            "name": preparer,
            "position_title": f"approver of record ({approval.id})" if approval else None,
            "signature": None,
            "date_time": now,
            "trace_entry": entry.id if entry else None,
        },
        "sightline": {
            "mission_id": mission.mission_id,
            "team_id": team_id,
            "sector_id": sector,
            "task_state": task.state if task else None,
            "card_generated_at": card.generated_at if card else None,
        },
    }


def ics204_markdown(f: dict) -> str:
    """The ICS 204 as printable Markdown tables, block numbers as on the FEMA form."""
    op = f["operational_period"]
    out = [
        "# Assignment List (ICS 204)",
        "",
        _table(
            [
                "1. Incident Name",
                "2. Operational Period",
                "3. Branch / Division / Group / Staging Area",
            ],
            [
                [
                    f["incident_name"],
                    f"From {ics_time(op['from'])} to {ics_time(op['to'])}",
                    f"Division: {_cell(f['division'])}",
                ]
            ],
        ),
        "",
        "**4. Operations Personnel**",
        "",
        _table(
            ["Position", "Name", "Contact Number(s)"],
            [[p["role"], p["name"], p["contact"]] for p in f["operations_personnel"]],
        ),
        "",
        "**5. Resources Assigned**",
        "",
        _table(
            [
                "Resource Identifier",
                "Leader",
                "# of Persons",
                "Contact (e.g., phone, pager, radio frequency, etc.)",
                "Reporting Location, Special Equipment and Supplies, Remarks, Notes, Information",
            ],
            [
                [r["resource_identifier"], r["leader"], r["persons"], r["contact"], r["remarks"]]
                for r in f["resources_assigned"]
            ],
        ),
        "",
        "**6. Work Assignments**",
        "",
        f["work_assignments"],
        "",
        "**7. Special Instructions**",
        "",
        *[f"- {s}" for s in f["special_instructions"]],
        "",
        "**8. Communications** (radio and/or phone contact numbers needed for this assignment)",
        "",
        _table(
            [
                "Name/Function",
                "Primary Contact: indicate cell, pager, or radio (frequency/system/channel)",
            ],
            [[c["name_function"], c["primary_contact"]] for c in f["communications"]],
        ),
        "",
        "**9. Prepared by**",
        "",
        _table(
            ["Name", "Position/Title", "Signature", "Date/Time"],
            [
                [
                    f["prepared_by"]["name"],
                    f["prepared_by"]["position_title"],
                    SIGN,
                    ics_time(f["prepared_by"]["date_time"]),
                ]
            ],
        ),
        "",
        (
            f"ICS 204 · IAP Page ____ · FEMA form {f['form_version']} layout · generated by Sightline "
            "from the mission's assignment card and trace: check it before filing."
        ),
        "",
    ]
    return "\n".join(out)


# --- ICS 214 -----------------------------------------------------------------------------

DECISION_WORDS = {
    "assign_sector": "Assignment",
    "drone_leg": "Drone leg",
    "retask_drone": "Drone re-task",
    "promote_detection": "Promotion to the review queue",
    "dismiss_detection": "Detection dismissal",
    "alert": "Alert",
}


def _decision_label(p: Proposal | None, status: str) -> str:
    if p is None:
        return f"Proposal {status}"
    kind = (
        "Drone recall"
        if p.kind == "retask_drone" and "home" in p.target
        else DECISION_WORDS[p.kind]
    )
    return f"{kind} {status}"


def ics214(state: dict, trace: list[TraceEntry], events: list[Any], now: str) -> dict:
    """ICS 214 for the mission: blocks 1–8, the activity log oldest first. Rows: every decision
    (from the trace's ``decision`` entries, else the proposal's own record), every clue logged,
    and every task-board move (assigned, started, searched at a POD)."""
    mission, teams = state["mission"], state["teams"]
    proposals = {p.id: p for p in state["proposals"]}
    decisions = _decisions(trace)
    rows: list[dict] = []

    for pid, e in decisions.items():
        p = proposals.get(pid)
        status = str((e.output or {}).get("status") or (p.status if p else "decided"))
        what = f"{_decision_label(p, status)}: {p.summary if p else e.summary} ({pid})"
        if p is not None and p.decision_reason:
            what += f"; reason: {p.decision_reason}"
        rows.append({"at": e.at, "who": _who(e, p), "what": what, "source": e.id})
    for p in state["proposals"]:
        if p.id in decisions or p.status not in ("approved", "rejected") or not p.decided_at:
            continue
        what = f"{_decision_label(p, p.status)}: {p.summary} ({p.id})"
        if p.decision_reason:
            what += f"; reason: {p.decision_reason}"
        rows.append({"at": p.decided_at, "who": p.decided_by, "what": what, "source": p.id})

    for c in state["clues"]:
        who = _team_name(teams, c.reported_by)
        rows.append(
            {
                "at": c.at,
                "who": who,
                "what": f"Clue logged {c.id} ({c.kind}, {c.reliability} reliability, via {c.source}): "
                f"{c.text} at {c.lat:.5f}, {c.lon:.5f}",
                "source": c.id,
            }
        )

    moves = {"assigned": "assigned to", "in_progress": "started by"}
    last: dict[str, str] = {}
    for ev in events:
        if ev.type != "task.updated" or not ev.data:
            continue
        sid, st = ev.data.get("sector_id"), ev.data.get("state")
        if not sid or st == last.get(sid):
            continue
        last[sid] = st
        team = _team_name(teams, ev.data.get("team_id"))
        if st in moves and team:
            what = f"Sector {sid} {moves[st]} {team}"
        elif st == "searched" and ev.data.get("pod") is not None:
            what = f"Sector {sid} searched at POD {ev.data['pod']:g}"
            if ev.data.get("note"):
                what += f": {ev.data['note']}"
        else:
            continue
        rows.append(
            {"at": ev.data.get("updated_at") or ev.at, "who": team, "what": what, "source": ev.id}
        )

    rows.sort(key=lambda r: (_dt(r["at"]) or datetime.min.replace(tzinfo=UTC), r["source"]))
    fleet = state["fleet"]
    resources = [
        {
            "name": f"{t.callsign} ({t.id})",
            "ics_position": f"ground search team, {t.members} persons",
            "home_agency": None,
        }
        for t in teams
    ] + [
        {
            "name": f"{d.name} ({d.id})" + (" (simulated)" if d.simulated else ""),
            "ics_position": "UAS",
            "home_agency": None,
        }
        for d in (fleet.drones if fleet else [])
    ]
    approvers = [r["who"] for r in rows if r["source"].startswith(("t", "p")) and r["who"]]
    return {
        "form": "ICS 214",
        "form_version": FORM_VERSION,
        "title": "Activity Log",
        "incident_name": mission.name,
        "operational_period": {"from": mission.created_at, "to": now},
        "name": "Search management (Sightline mission log)",
        "ics_position": None,
        "home_agency": None,
        "resources_assigned": resources,
        "activity_log": rows,
        "prepared_by": {
            "name": approvers[-1] if approvers else None,
            "position_title": None,
            "signature": None,
            "date_time": now,
        },
        "sightline": {"mission_id": mission.mission_id},
    }


def ics214_markdown(f: dict) -> str:
    op = f["operational_period"]
    log = f["activity_log"]
    out = [
        "# Activity Log (ICS 214)",
        "",
        _table(
            ["1. Incident Name", "2. Operational Period"],
            [[f["incident_name"], f"From {ics_time(op['from'])} to {ics_time(op['to'])}"]],
        ),
        "",
        _table(
            ["3. Name", "4. ICS Position", "5. Home Agency (and Unit)"],
            [[f["name"], f["ics_position"], f["home_agency"]]],
        ),
        "",
        "**6. Resources Assigned**",
        "",
        _table(
            ["Name", "ICS Position", "Home Agency (and Unit)"],
            [[r["name"], r["ics_position"], r["home_agency"]] for r in f["resources_assigned"]],
        )
        if f["resources_assigned"]
        else "No resources on this mission yet.",
        "",
        "**7. Activity Log**",
        "",
        _table(
            ["Date/Time", "Who", "Notable Activities"],
            [[ics_time(r["at"]), r["who"], r["what"]] for r in log],
        )
        if log
        else "No notable activities logged yet.",
        "",
        "**8. Prepared by**",
        "",
        _table(
            ["Name", "Position/Title", "Signature", "Date/Time"],
            [
                [
                    f["prepared_by"]["name"],
                    f["prepared_by"]["position_title"],
                    SIGN,
                    ics_time(f["prepared_by"]["date_time"]),
                ]
            ],
        ),
        "",
        (
            f"ICS 214 · Page 1 · FEMA form {f['form_version']} layout · generated by Sightline from the "
            "mission's trace, clue log and task board: check it before filing."
        ),
        "",
    ]
    return "\n".join(out)


# --- CalTopo GeoJSON ---------------------------------------------------------------------


def _shape(geom: dict, title: str, description: str, style: dict, folder: str) -> dict:
    props = {
        "title": title,
        "description": description,
        "class": "Shape",
        "folderId": folder,
        "stroke": style["stroke"],
        "stroke-opacity": 1,
        "stroke-width": 2,
        "pattern": "solid",
    }
    if geom["type"] == "Polygon":
        props |= {"fill": style["fill"], "fill-opacity": style["fill-opacity"]}
    return {"type": "Feature", "geometry": geom, "properties": props}


def _marker(
    lat: float, lon: float, title: str, description: str, color: str, symbol: str, folder: str
) -> dict:
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
        "properties": {
            "title": title,
            "description": description,
            "class": "Marker",
            "folderId": folder,
            "marker-color": color,
            "marker-symbol": symbol,
            "marker-size": 1,
        },
    }


FOLDERS = {
    "sectors": "Sectors",
    "searched": "Searched areas",
    "legs": "Drone legs",
    "teams": "Teams",
    "clues": "Clues",
}


def caltopo_geojson(state: dict, sectors: list[dict]) -> dict:
    """A FeatureCollection CalTopo / SARTopo imports (Import → GeoJSON). ``sectors``: the mission's
    sector overview (``effects.sector_overview``: id, label, POA, drone coverage, polygon)."""
    mission, teams = state["mission"], state["teams"]
    tasks = {t.sector_id: t for t in state["tasks"]}
    folders = [
        {
            "type": "Feature",
            "id": f"sightline-{key}",
            "geometry": None,
            "properties": {"title": title, "class": "Folder"},
        }
        for key, title in FOLDERS.items()
    ]
    feats: list[dict] = []
    lkp = mission.area.lkp
    feats.append(
        _marker(
            lkp.lat,
            lkp.lon,
            "LKP",
            f"last known position: {mission.name}"
            + (f", last seen {ics_time(mission.last_seen_at)}" if mission.last_seen_at else ""),
            "000000",
            "cp",
            "sightline-sectors",
        )
    )
    for s in sectors:
        t = tasks.get(s["sector_id"])
        ring = {
            "type": "Polygon",
            "coordinates": [[[round(x, 6), round(y, 6)] for x, y in s["polygon"]]],
        }
        team = _team_name(teams, t.team_id) if t and t.team_id else None
        state_words = (
            f"{t.state.replace('_', ' ')}" + (f", {team}" if team else "") if t else "no task"
        )
        desc = f"POA {s['poa']:.1%}; drone photos cover {s['drone_coverage']:.0%}; {state_words}"
        style = (
            STYLE["assigned"] if t and t.state in ("assigned", "in_progress") else STYLE["sector"]
        )
        feats.append(
            _shape(
                ring, f"Sector {s['sector_id']} ({s['label']})", desc, style, "sightline-sectors"
            )
        )
        if t and t.state == "searched" and t.pod is not None:
            desc = f"searched at POD {t.pod:g} ({ics_time(t.updated_at)})" + (
                f": {t.note}" if t.note else ""
            )
            feats.append(
                _shape(
                    ring,
                    f"{s['sector_id']} searched at POD {t.pod:g}",
                    desc,
                    STYLE["searched"],
                    "sightline-searched",
                )
            )
    fleet = state["fleet"]
    drones = {d.id: d for d in fleet.drones} if fleet else {}
    for leg in fleet.legs if fleet else []:
        if leg.status == "cancelled" or len(leg.waypoints) < 2:
            continue
        line = {
            "type": "LineString",
            "coordinates": [[round(x, 6), round(y, 6)] for x, y in leg.waypoints],
        }
        d = drones.get(leg.drone_id)
        title = f"{leg.id} {d.name if d else leg.drone_id}" + (
            f" over {leg.sector_id}" if leg.sector_id else ""
        )
        feats.append(
            _shape(
                line,
                title,
                f"{_leg_words(leg, drones)} {leg.reason}",
                STYLE["leg"],
                "sightline-legs",
            )
        )
    for t in teams:
        if t.position is None:
            continue
        feats.append(
            _marker(
                t.position.lat,
                t.position.lon,
                f"{t.callsign} ({t.id})",
                f"{t.status}, {t.members} persons, last position {ics_time(t.position_at)}",
                "0000FF",
                "point",
                "sightline-teams",
            )
        )
    for c in state["clues"]:
        feats.append(
            _marker(
                c.lat,
                c.lon,
                f"Clue {c.id}: {c.kind}",
                f"{c.text} ({c.reliability} reliability, reported by "
                f"{_team_name(teams, c.reported_by)} via {c.source}, {ics_time(c.at)}, "
                f"within {c.radius_m:g} m)",
                "FF0000",
                "clue",
                "sightline-clues",
            )
        )
    return {"type": "FeatureCollection", "features": folders + feats}
