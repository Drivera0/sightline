"""Contract 1.2 (§12–§14): the live-mission models round-trip, reject unknown fields and keep the
draft's rules; the generated TypeScript has them (contract test 1, LANE_D §6)."""

from __future__ import annotations

from pathlib import Path
from typing import get_args

import pytest
from pydantic import BaseModel, ValidationError

from sightline.contract import (
    CONTRACT_VERSION,
    AssignmentCard,
    Clue,
    ClueDraft,
    Conditions,
    ContractVersion,
    Drone,
    FleetState,
    FleetTelemetry,
    Leg,
    MapUpdate,
    Mission,
    MissionBundle,
    MissionEvent,
    Proposal,
    RadioTurn,
    SectorTask,
    Team,
    TraceEntry,
    Verdict,
)

ROOT = Path(__file__).resolve().parents[2]
AT = "2026-10-24T21:40:00Z"

LEG = {
    "id": "L007", "drone_id": "D2", "sector_id": "C3",
    "waypoints": [[-122.93, 49.37], [-122.92, 49.37]], "altitude_m": 60.0, "est_minutes": 8.5,
    "expected_clearance": 0.12, "score_per_min": 0.014, "reason": "highest expected clearance",
    "status": "proposed",
}  # fmt: skip
EXAMPLES: dict[type[BaseModel], dict] = {
    Mission: {
        "contract_version": "1.2", "mission_id": "a1b2c3d4", "name": "Seymour — missing hiker",
        "area": {"name": "Mount Seymour", "lkp": {"lat": 49.37, "lon": -122.94}}, "created_at": AT,
        "mode": "live", "last_seen_at": None, "subject": "adult, red jacket, day hiker",
    },
    MapUpdate: {
        "seq": 1, "kind": "step", "source": "frame", "ref": "f0001",
        "cells": [[10, 0.42], [11, 0.4]], "canopy": [[10, 0.2, 0.9]], "at": AT,
    },
    Verdict: {
        "id": "v0021", "detection_id": "f0042-d01", "tools": ["zoom_native"],
        "relook_crops": ["relook/f0042-d01-zoom.jpg"], "person": "yes", "posture": "lying",
        "group_size": 1, "clothing": "white top, dark pants", "reason": "a person lying down",
        "model": "nvidia/nemotron", "ms": 1350, "at": AT,
    },
    SectorTask: {
        "sector_id": "B3", "state": "searched", "team_id": "T2", "poa": 0.18, "pod": 0.6,
        "note": None, "updated_at": AT,
    },
    Team: {
        "id": "T2", "callsign": "Team Two", "members": 3, "status": "assigned",
        "position": {"lat": 49.3745, "lon": -122.9358}, "position_at": AT, "note": None,
    },
    ClueDraft: {
        "kind": "object", "text": "blue backpack by the creek", "lat": None, "lon": None,
        "at_team_position": True, "reported_by": "T2", "source": "radio", "confirmed_by_turn": "r0003",
    },
    Clue: {
        "kind": "object", "text": "blue backpack by the creek", "lat": 49.3745, "lon": -122.9358,
        "at_team_position": True, "radius_m": 25.0, "reliability": "medium", "reported_by": "T2",
        "source": "radio", "confirmed_by_turn": "r0003", "id": "c003", "at": AT, "confirmed": True,
    },
    Proposal: {
        "id": "p014", "kind": "drone_leg", "summary": "Send Drone 2 to sector C3 (12.0% expected)",
        "reason": "After clue c003.", "briefing": None, "target": {"drone": "D2", "leg": "L007"},
        "leg": LEG, "evidence": [{"kind": "leg", "ref": "L007", "caption": "lawnmower over C3"}],
        "status": "pending", "created_by": "planner", "created_at": AT, "decided_at": None,
        "decided_by": None, "decision_reason": None, "edits": None,
    },
    FleetState: {
        "simulated": True,
        "drones": [{
            "id": "D2", "name": "Drone 2", "simulated": True, "position": None, "altitude_m": 60.0,
            "speed_ms": 8.0, "battery_pct": 84.0, "max_wind_kmh": 38.0, "status": "idle", "leg_id": None,
        }],
        "legs": [{**LEG, "status": "approved"}], "updated_at": AT,
    },
    FleetTelemetry: {"drones": [], "leg_status": {"L007": "flying"}, "at": AT},
    Conditions: {
        "fetched_at": AT, "stale": False, "area": "Mount Seymour", "sources": ["https://example.org"],
        "wind_kmh": 18.0, "gust_kmh": 30.0, "wind_dir_deg": 250.0, "precip_mm_h": 0.4,
        "precip_prob": 0.6, "temp_c": 8.0, "visibility_km": 10.0, "sunset": AT,
        "civil_twilight_end": AT, "alerts": [{"kind": "closure", "title": "Lower Seymour trail closed",
        "text": "Closed for repairs.", "url": "https://example.org/closure"}], "flyable": True,
        "flyable_until": None, "flyability_reason": "gusts 30 below the fleet's 38 km/h",
        "visibility_factor": 0.95, "exposure_band": "moderate", "exposure_note": "heuristic",
    },
    AssignmentCard: {
        "mission_id": "a1b2c3d4", "sector_id": "B3", "sector_label": "Bravo Three", "team_id": "T2",
        "team_callsign": "Team Two", "polygon": [[-122.93, 49.37], [-122.92, 49.37], [-122.92, 49.36]],
        "area_m2": 62500.0, "entry": {"name": "east ridge", "lat": 49.3741, "lon": -122.9301},
        "bearing_deg_from_team": 270.0, "distance_m_from_team": 600.0, "waypoints": [],
        "poa": 0.18, "drone_coverage": 0.4, "look_for": ["red jacket"], "evidence_crops": [],
        "conditions_line": "gusts 30 km/h, light rain", "daylight_remaining_min": 160,
        "radio": "Team Two, sector Bravo Three.", "generated_at": AT,
    },
    MissionEvent: {
        "id": "e00412", "type": "proposal.new", "at": AT, "summary": "p014 drone_leg",
        "ref": "p014", "data": {"id": "p014"},
    },
    TraceEntry: {
        "id": "t000131", "at": AT, "actor": "agent", "kind": "model_call", "summary": "verify f0042-d01",
        "input": {"image": "relook/f0042-d01-zoom.jpg"}, "output": {"person": "yes"},
        "model": "nvidia/nemotron", "ms": 1350, "tokens_in": 890, "tokens_out": 67, "refs": ["f0042-d01"],
    },
    RadioTurn: {
        "id": "r0003", "direction": "in", "callsign": "T2", "transcript": "Affirmative, over.",
        "reply": "Team Two, Sightline. Clue logged. Out.", "audio": None, "state": "committed",
        "actions": ["post_clue"], "asr_ms": 80, "llm_ms": None, "tts_ms": 0, "at": AT,
    },
}  # fmt: skip


def test_version() -> None:
    assert CONTRACT_VERSION == "1.2"
    assert get_args(ContractVersion) == ("1.0", "1.1", "1.2")  # static 1.0/1.1 caches still load


@pytest.mark.parametrize("model", list(EXAMPLES), ids=lambda m: m.__name__)
def test_round_trips(model: type[BaseModel]) -> None:
    obj = model.model_validate(EXAMPLES[model])
    assert model.model_validate(obj.model_dump(mode="json")) == obj


@pytest.mark.parametrize("model", list(EXAMPLES), ids=lambda m: m.__name__)
def test_unknown_fields_are_rejected(model: type[BaseModel]) -> None:
    with pytest.raises(ValidationError, match="extra"):
        model.model_validate({**EXAMPLES[model], "surprise": 1})


@pytest.mark.parametrize(
    ("model", "change"),
    [
        (SectorTask, {"pod": 0.95}),  # ground POD is capped at 0.9
        (SectorTask, {"state": "cleared"}),  # never "cleared"
        (MapUpdate, {"seq": 0}),
        (Team, {"members": 0}),
        (Clue, {"radius_m": 0}),
        (Clue, {"lat": None}),  # a clue always has a position
        (Drone, {"battery_pct": 101}),
        (Leg, {"expected_clearance": 1.5}),
        (Proposal, {"kind": "dismiss_area"}),
        (MissionEvent, {"type": "area.cleared"}),
        (AssignmentCard, {"waypoints": [{"name": "w", "lat": 0, "lon": 0}] * 41}),
    ],
)
def test_rules_from_the_draft(model: type[BaseModel], change: dict) -> None:
    base = (
        EXAMPLES.get(model)
        or {
            Drone: EXAMPLES[FleetState]["drones"][0],
            Leg: LEG,
        }[model]
    )
    with pytest.raises(ValidationError):
        model.model_validate({**base, **change})


def test_a_proposal_leg_is_a_leg() -> None:
    p = Proposal.model_validate(EXAMPLES[Proposal])
    assert isinstance(p.leg, Leg) and p.leg.id == "L007"


def test_every_live_model_is_in_the_typescript_contract() -> None:
    ts = (ROOT / "web/src/contract.ts").read_text()
    for name in [*MissionBundle.model_fields, *(m.__name__ for m in EXAMPLES)]:
        if name[0].isupper():
            assert f"export interface {name} " in ts, (
                f"{name} missing: run `pnpm gen:contract` in web/"
            )
    assert '"1.0" | "1.1" | "1.2"' in ts


def test_a_field_called_title_survives_into_typescript() -> None:
    """ConditionAlert.title was dropped: the schema cleanup removed every key named "title"."""
    ts = (ROOT / "web/src/contract.ts").read_text()
    alert = ts[ts.index("export interface ConditionAlert") :].split("}")[0]
    assert "title: string;" in alert
