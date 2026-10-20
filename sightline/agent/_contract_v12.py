"""Lane A's local copy of the contract v1.2 models (docs/01_CONTRACT_v1.2_DRAFT.md §12.2).

Lane D owns ``sightline/contract.py`` and adds these in D-C1; until then lane A builds against
this copy. Delete it at that merge and import from ``sightline.contract`` instead. Field names
and types mirror the draft exactly; ``AssignmentCard`` and ``Waypoint`` (lane B) are left out.
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from sightline.contract import (
    Area,
    Distribution,
    Grid,
    LatLon,
    LonLat,
    Params,
    Probability,
    _Model,
)

ContractVersion = Literal["1.0", "1.1", "1.2"]

# --- mission -------------------------------------------------------------------------------


class Mission(_Model):
    contract_version: ContractVersion
    mission_id: str
    name: str
    area: Area
    created_at: str
    mode: Literal["live", "demo", "replay"]
    last_seen_at: str | None
    subject: str | None


# --- map (C) -------------------------------------------------------------------------------


class MapBase(_Model):
    contract_version: ContractVersion
    grid: Grid
    lkp: LatLon
    params: Params
    prior: Distribution
    canopy: list[Probability | None]


class MapUpdate(_Model):
    seq: int = Field(ge=1)
    kind: Literal["step", "reweight"]
    source: Literal["frame", "review", "ground", "clue", "conditions"]
    ref: str | None
    cells: list[tuple[int, float]]
    canopy: list[tuple[int, float, float]] | None = None
    at: str


# --- detections second look (A) --------------------------------------------------------------


class Verdict(_Model):
    id: str
    detection_id: str
    tools: list[str]
    relook_crops: list[str]
    person: Literal["yes", "no", "unclear"]
    posture: Literal["standing", "sitting", "lying", "unknown"]
    group_size: int | None
    clothing: str | None
    reason: str
    model: str
    ms: int
    at: str


# --- operations ------------------------------------------------------------------------------

SectorTaskState = Literal["proposed", "assigned", "in_progress", "searched"]


class SectorTask(_Model):
    sector_id: str
    state: SectorTaskState
    team_id: str | None
    poa: Probability
    pod: Probability | None = Field(default=None, le=0.9)
    note: str | None
    updated_at: str


class Team(_Model):
    id: str
    callsign: str
    members: int = Field(ge=1)
    status: Literal["standby", "assigned", "searching", "returning", "off_duty"]
    position: LatLon | None
    position_at: str | None
    note: str | None


class ClueDraft(_Model):
    kind: Literal["object", "track", "sighting", "sound", "other"]
    text: str
    lat: float | None
    lon: float | None
    at_team_position: bool = False
    radius_m: float | None = Field(default=None, gt=0)
    reliability: Literal["low", "medium", "high"] = "medium"
    reported_by: str
    source: Literal["form", "radio"]
    confirmed_by_turn: str | None = None


class Clue(ClueDraft):
    id: str
    lat: float
    lon: float
    radius_m: float = Field(gt=0)
    at: str
    confirmed: bool


class EvidenceRef(_Model):
    kind: Literal["crop", "frame", "relook", "trace", "clue", "conditions", "map", "leg"]
    ref: str
    caption: str


# --- fleet -----------------------------------------------------------------------------------


class Drone(_Model):
    id: str
    name: str
    simulated: bool
    position: LatLon | None
    altitude_m: float = Field(gt=0)
    speed_ms: float = Field(gt=0)
    battery_pct: float = Field(ge=0, le=100)
    max_wind_kmh: float = Field(gt=0)
    status: Literal["idle", "flying", "returning", "charging", "offline"]
    leg_id: str | None


class Leg(_Model):
    id: str
    drone_id: str
    sector_id: str | None
    waypoints: list[LonLat]
    altitude_m: float
    est_minutes: float
    expected_clearance: Probability
    score_per_min: float
    reason: str
    status: Literal["proposed", "approved", "flying", "done", "cancelled"]


class Proposal(_Model):
    id: str
    kind: Literal[
        "drone_leg",
        "retask_drone",
        "assign_sector",
        "promote_detection",
        "dismiss_detection",
        "alert",
    ]
    summary: str
    reason: str
    briefing: str | None
    target: dict[str, str]
    leg: Leg | None = None
    evidence: list[EvidenceRef]
    status: Literal["pending", "approved", "rejected", "expired", "superseded"]
    created_by: Literal["agent", "planner", "verifier", "command"]
    created_at: str
    decided_at: str | None
    decided_by: str | None
    decision_reason: str | None
    edits: dict[str, str] | None


class FleetState(_Model):
    simulated: bool
    drones: list[Drone]
    legs: list[Leg]
    updated_at: str


class FleetTelemetry(_Model):
    drones: list[Drone]
    leg_status: dict[str, Literal["flying", "done"]]
    at: str


# --- conditions (B) --------------------------------------------------------------------------


class ConditionAlert(_Model):
    kind: Literal["closure", "warning", "advisory", "other"]
    title: str
    text: str
    url: str


class Conditions(_Model):
    fetched_at: str
    stale: bool
    area: str
    sources: list[str]
    wind_kmh: float | None
    gust_kmh: float | None
    wind_dir_deg: float | None
    precip_mm_h: float | None
    precip_prob: Probability | None
    temp_c: float | None
    visibility_km: float | None
    sunset: str | None
    civil_twilight_end: str | None
    alerts: list[ConditionAlert]
    flyable: bool | None
    flyable_until: str | None
    flyability_reason: str
    visibility_factor: Probability
    exposure_band: Literal["low", "moderate", "high", "severe"] | None
    exposure_note: str


# --- events and trace ------------------------------------------------------------------------

EventType = Literal[
    "photo.processed",
    "detection.new",
    "verdict",
    "map.updated",
    "proposal.new",
    "proposal.decided",
    "clue.added",
    "task.updated",
    "team.updated",
    "fleet.updated",
    "conditions.updated",
    "radio.turn",
    "mission.note",
]


class MissionEvent(_Model):
    id: str
    type: EventType
    at: str
    summary: str
    ref: str | None
    data: dict | None


TraceActor = Literal["agent", "verifier", "planner", "conditions", "radio", "pipeline", "human"]
TraceKind = Literal[
    "model_call", "tool_call", "verdict", "proposal", "decision", "radio_turn", "note"
]


class TraceEntry(_Model):
    id: str
    at: str
    actor: TraceActor
    kind: TraceKind
    summary: str
    input: dict | None
    output: dict | None
    model: str | None
    ms: int | None
    tokens_in: int | None
    tokens_out: int | None
    refs: list[str]


class RadioTurn(_Model):
    id: str
    direction: Literal["in", "out"]
    callsign: str | None
    transcript: str
    reply: str | None
    audio: str | None
    state: Literal[
        "answered", "awaiting_confirm", "committed", "discarded", "transmitted", "say_again"
    ]
    actions: list[str]
    asr_ms: int | None
    llm_ms: int | None
    tts_ms: int | None
    at: str
