"""Pydantic v2 models of docs/01_CONTRACT.md (v1.3). The doc wins if the two disagree.

Only lane D edits this file. Rounding (contract section 2) happens at write time in `dump_json`,
never inside the models.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

CONTRACT_VERSION = "1.3"
# What readers accept. 1.1 only adds optional fields (map.params.prior_source,
# metrics.search_sim.in_survey), so a 1.0 file is a valid 1.1 file with those fields null.
# 1.2 only adds live-mission files (section 12); the static cache files are unchanged.
# 1.3 only adds optional live-mission fields and models (the command post, section 15).
# Everything the pipeline writes is stamped CONTRACT_VERSION.
ContractVersion = Literal["1.0", "1.1", "1.2", "1.3"]

Probability = Annotated[float, Field(ge=0.0, le=1.0)]
FRAME_ID = r"^f\d{4}$"
DETECTION_ID = r"^f\d{4}-d\d{2}$"
SUM_TOLERANCE = 1e-6


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LatLon(_Model):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


# --- survey.json ---------------------------------------------------------------------------

LonLat = tuple[float, float]  # GeoJSON order


class Pose(_Model):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    alt_agl_m: float | None
    heading_deg: float = Field(ge=0, le=360)
    gsd_m: float = Field(gt=0)


class Source(_Model):
    image: str
    x0: int = Field(ge=0)
    y0: int = Field(ge=0)


class Frame(_Model):
    id: str = Field(pattern=FRAME_ID)
    file: str
    width_px: int = Field(gt=0)
    height_px: int = Field(gt=0)
    flight_index: int = Field(ge=0)
    source: Source
    pose: Pose
    footprint: tuple[LonLat, LonLat, LonLat, LonLat]
    score: Probability
    rank: int = Field(ge=1)
    n_candidates: int = Field(ge=0)

    @model_validator(mode="after")
    def _check(self) -> Frame:
        if self.id != f"f{self.flight_index + 1:04d}":
            raise ValueError(f"id {self.id} does not match flight_index {self.flight_index}")
        if self.footprint[0] == self.footprint[-1]:
            raise ValueError("footprint must not be closed (first corner equals last)")
        return self


class Area(_Model):
    name: str
    lkp: LatLon


class Survey(_Model):
    contract_version: ContractVersion
    survey_id: str
    simulated_path: bool
    area: Area
    frames: list[Frame]

    @model_validator(mode="after")
    def _check(self) -> Survey:
        n = len(self.frames)
        if [f.flight_index for f in self.frames] != list(range(n)):
            raise ValueError("frames must be in flight order with flight_index 0..N-1, no gaps")
        if sorted(f.rank for f in self.frames) != list(range(1, n + 1)):
            raise ValueError("rank values must be exactly 1..N")
        return self


# --- detections.json -----------------------------------------------------------------------


class Detection(_Model):
    id: str = Field(pattern=DETECTION_ID)
    box_px: tuple[int, int, int, int]
    conf: Probability
    crop: str | None
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    radius_m: float = Field(gt=0)

    @model_validator(mode="after")
    def _check(self) -> Detection:
        x1, y1, x2, y2 = self.box_px
        if not (x2 > x1 and y2 > y1):
            raise ValueError(f"box_px must satisfy x2 > x1 and y2 > y1, got {self.box_px}")
        return self


class Detections(_Model):
    contract_version: ContractVersion
    model: str
    save_threshold: Probability
    candidate_threshold: Probability
    frames: dict[Annotated[str, Field(pattern=FRAME_ID)], list[Detection]]

    @model_validator(mode="after")
    def _check(self) -> Detections:
        for frame_id, dets in self.frames.items():
            confs = [d.conf for d in dets]
            if confs != sorted(confs, reverse=True):
                raise ValueError(f"{frame_id}: detections must be sorted by descending conf")
            for i, d in enumerate(dets, start=1):
                if d.id != f"{frame_id}-d{i:02d}":
                    raise ValueError(f"{frame_id}: expected id {frame_id}-d{i:02d}, got {d.id}")
                is_candidate = d.conf >= self.candidate_threshold
                if is_candidate != (d.crop is not None):
                    raise ValueError(
                        f"{d.id}: crop must be non-null exactly when conf >= candidate_threshold"
                    )
        return self


# --- map.json ------------------------------------------------------------------------------


class Grid(_Model):
    origin_nw: LatLon
    cell_m: float = Field(gt=0)
    rows: int = Field(gt=0)
    cols: int = Field(gt=0)


class Params(_Model):
    recall: Probability
    recall_source: str
    pod_cap: Probability
    review_pod: Probability
    # 1.1: "placeholder" when the pipeline used the placeholder prior, otherwise the citation of
    # the lost-person statistics the prior came from. null in 1.0 files.
    prior_source: str | None = None


class Distribution(_Model):
    """Per-cell probabilities plus the mass outside the grid; used for `prior` and `final`."""

    p: list[Probability]
    outside: Probability


class Step(_Model):
    frame_id: str = Field(pattern=FRAME_ID)
    cells: list[tuple[int, Probability]]  # [idx, pod]


class TopCell(_Model):
    idx: int = Field(ge=0)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    p: Probability
    canopy: Probability | None


class MapFile(_Model):
    contract_version: ContractVersion
    grid: Grid
    lkp: LatLon
    params: Params
    prior: Distribution
    canopy: list[Probability | None]
    steps: list[Step]
    final: Distribution
    top_cells: list[TopCell]

    @model_validator(mode="after")
    def _check(self) -> MapFile:
        n = self.grid.rows * self.grid.cols
        for name, arr in (
            ("prior.p", self.prior.p),
            ("canopy", self.canopy),
            ("final.p", self.final.p),
        ):
            if len(arr) != n:
                raise ValueError(f"{name} has {len(arr)} values, expected rows*cols = {n}")
        for name, dist in (("prior", self.prior), ("final", self.final)):
            total = math.fsum(dist.p) + dist.outside
            if abs(total - 1.0) > SUM_TOLERANCE:
                raise ValueError(
                    f"sum({name}.p) + {name}.outside = {total}, expected 1 within 1e-6"
                )
        frame_ids = [s.frame_id for s in self.steps]
        if len(set(frame_ids)) != len(frame_ids):
            raise ValueError("steps must have unique frame_ids")
        for s in self.steps:
            for idx, pod in s.cells:
                if not 0 <= idx < n:
                    raise ValueError(f"{s.frame_id}: cell idx {idx} outside 0..{n - 1}")
                if pod > self.params.pod_cap + 1e-9:
                    raise ValueError(
                        f"{s.frame_id}: pod {pod} exceeds pod_cap {self.params.pod_cap}"
                    )
        if len(self.top_cells) > 5:
            raise ValueError("top_cells holds at most 5 cells")
        ps = [c.p for c in self.top_cells]
        if ps != sorted(ps, reverse=True):
            raise ValueError("top_cells must be sorted by descending p")
        if any(c.idx >= n for c in self.top_cells):
            raise ValueError("top_cells idx outside the grid")
        return self


# --- metrics.json --------------------------------------------------------------------------


class VocScores(_Model):
    precision: Probability
    recall: Probability
    ap50: Probability


class SarScores(_Model):
    precision: Probability
    recall: Probability
    ap: Probability


class DetectorMetrics(_Model):
    model: str
    test_images: int = Field(ge=0)
    tiled: bool
    threshold: Probability
    voc: VocScores
    sar: SarScores
    recall: Probability
    seconds_per_image: float = Field(ge=0)

    @model_validator(mode="after")
    def _check(self) -> DetectorMetrics:
        if self.recall != self.voc.recall:
            raise ValueError("recall must be a copy of voc.recall")
        return self


class BaselineHuman(_Model):
    precision: Probability
    recall: Probability
    seconds_per_image: float = Field(ge=0)
    source: str


class Ablation(_Model):
    name: str
    voc: VocScores


class HitPositions(_Model):
    frames_to_first_hit: int = Field(ge=0)
    frames_to_all_hits: int = Field(ge=0)


class MinutesAtHumanPace(_Model):
    flight_order_first: float = Field(ge=0)
    ranked_first: float = Field(ge=0)


class Ranking(_Model):
    n_frames: int = Field(ge=0)
    n_positive: int = Field(ge=0)
    flight_order: HitPositions
    ranked: HitPositions
    expected_first_hit_random_order: float = Field(ge=0)
    minutes_at_human_pace: MinutesAtHumanPace
    note: str

    @model_validator(mode="after")
    def _check(self) -> Ranking:
        if self.n_positive > self.n_frames:
            raise ValueError("n_positive cannot exceed n_frames")
        return self


class SearchMethod(_Model):
    name: str
    median_cells: float = Field(ge=0)
    p90_cells: float = Field(ge=0)


class InSurvey(_Model):
    """1.1: the same statistics over only the not-found trials whose true cell was photographed."""

    trials: int = Field(ge=0)
    methods: list[SearchMethod]


class SearchSim(_Model):
    simulated: bool
    trials: int = Field(ge=0)
    seed: int
    found_by_drone_rate: Probability
    methods: list[SearchMethod]
    in_survey: InSurvey | None = None  # 1.1; null until lane C's simulate fills it

    @model_validator(mode="after")
    def _in_survey_matches(self) -> SearchSim:
        if self.in_survey is not None:
            if [m.name for m in self.in_survey.methods] != [m.name for m in self.methods]:
                raise ValueError("in_survey.methods must have the same names, in order, as methods")
            if self.in_survey.trials > self.trials:
                raise ValueError("in_survey.trials cannot exceed trials")
        return self


class Metrics(_Model):
    contract_version: ContractVersion
    detector: DetectorMetrics
    baseline_human: BaselineHuman
    ablations: list[Ablation]
    ranking: Ranking
    search_sim: SearchSim


# --- manifest.json -------------------------------------------------------------------------


class StageResult(_Model):
    ok: bool
    seconds: float = Field(ge=0)


class Stages(_Model):
    """Exactly the eight pipeline stages, in order."""

    frames: StageResult
    place: StageResult
    detect: StageResult
    georef: StageResult
    rank: StageResult
    map: StageResult
    metrics: StageResult
    export: StageResult


class Manifest(_Model):
    contract_version: ContractVersion
    survey_id: str
    generated_at: AwareDatetime
    git_sha: str | None
    simulated_path: bool
    n_frames: int = Field(ge=0)
    stages: Stages
    notes: str


# === v1.2: live missions (section 12) ===================================================

# --- mission -------------------------------------------------------------------------------


class BaseCamp(_Model):
    """1.3: where teams stage and drones launch from and return to."""

    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    name: str


class Found(_Model):
    """1.3: where and when the person was found, and by which team."""

    team: str
    sector: str | None
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    at: str


class Mission(_Model):
    contract_version: ContractVersion
    mission_id: str
    name: str
    area: Area
    created_at: str
    mode: Literal["live", "demo", "replay"]
    last_seen_at: str | None
    subject: str | None
    # 1.3 (section 15): null only in missions created before 1.3
    base_camp: BaseCamp | None = None
    status: Literal["searching", "found", "suspended"] = "searching"
    found: Found | None = None  # set exactly when status is "found"
    # a team out in the field not heard from for this long is overdue (a planning choice: no
    # published ground-SAR interval; aviation flight following uses 15-30 min)
    check_in_min: float = Field(default=30.0, gt=0, le=24 * 60)
    # demo missions only: the seed of the generated scenario (sightline/search/demo_scenario.py)
    scenario_seed: int | None = None


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


VerdictObject = Literal["backpack", "fire ring", "shelter", "other"]
ReviewAnswer = Literal["person", "not_person", "not_subject", "unsure", "object"]


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
    # v1.3 (section 15.7): not a person, but a thing a lost person may have left or used
    object: VerdictObject | None = None


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
    status: Literal["standby", "assigned", "searching", "returning", "off_duty", "overdue"]
    position: LatLon | None
    position_at: str | None
    note: str | None
    # 1.3: the last radio turn, clue or position report from the team (not its position's time)
    last_heard_at: str | None = None
    # 1.3: minutes on foot to the current assignment (or back to base camp when recalled), the
    # planner's straight-line walking estimate; null with no assignment
    eta_min: float | None = None


class ClueDraft(_Model):
    kind: Literal["object", "track", "sighting", "sound", "other"]
    text: str
    lat: float | None
    lon: float | None
    at_team_position: bool = False
    radius_m: float | None = Field(default=None, gt=0)
    reliability: Literal["low", "medium", "high"] = "medium"
    reported_by: str
    source: Literal["form", "radio", "review"]
    confirmed_by_turn: str | None = None
    # v1.3 (section 15.7): an image reviewer's "object" answer: the detection it came from. Such a
    # clue is a candidate (confirmed False, low reliability) until a team confirms it on the ground.
    detection_id: str | None = None
    # v1.3 (section 15.7): a sound a team heard is a bearing from where the team stood, not a point:
    # ``origin`` (the team's position), ``bearing_deg`` (true, 0 = north, where the sound came from),
    # ``bearing_spread_deg`` (half the arc's angle) and ``range_m`` (how far away it seemed; the arc is
    # that far give or take ``radius_m``). ``lat``/``lon`` is the arc's middle (``range_m`` along the
    # bearing); the map raises the arc's cells instead of a circle.
    origin: LatLon | None = None
    bearing_deg: float | None = Field(default=None, ge=0, lt=360)
    bearing_spread_deg: float | None = Field(default=None, gt=0, le=90)
    range_m: float | None = Field(default=None, gt=0, le=5000)


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
    home: LatLon | None = None  # 1.3: where it launches from and returns to (the base camp)


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


# --- assignment cards (B builds, D serves, E shows) ----------------------------------------


class Waypoint(_Model):
    name: str
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    note: str | None = None


class AssignmentCard(_Model):
    mission_id: str
    sector_id: str
    sector_label: str
    team_id: str | None
    team_callsign: str | None
    polygon: list[LonLat]
    area_m2: float = Field(gt=0)
    entry: Waypoint
    bearing_deg_from_team: float | None
    distance_m_from_team: float | None
    waypoints: list[Waypoint] = Field(max_length=40)
    poa: Probability
    drone_coverage: Probability
    look_for: list[str]
    evidence_crops: list[str]
    conditions_line: str | None
    daylight_remaining_min: int | None
    radio: str
    generated_at: str


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
    # v1.3 (section 15.7): the clue a team reported, waiting for the search manager to confirm it
    # (state "awaiting_confirm"); ``POST /missions/{id}/turns/{turn}/confirm_clue`` makes it a clue
    draft: ClueDraft | None = None


TimelineKind = Literal["radio", "clue", "detection", "decision", "checkin", "drone", "found"]


class TimelineEntry(_Model):
    """1.3 (section 15): one line of the mission's one timeline, derived from its events
    (``sightline/mission/timeline.py``): radio turns and desk replies, clues, detections and second
    looks, decisions (approvals and direct actions), check-ins, drone legs and links, the find."""

    id: str  # the event's id; a desk reply to a team's turn adds "-reply"
    at: str
    kind: TimelineKind
    team: str | None = None
    drone: str | None = None
    sector: str | None = None
    text: str
    refs: list[str] = Field(default_factory=list)
    turn_id: str | None = None  # radio: the turn, so the console can reply to it
    direction: Literal["in", "out"] | None = None  # radio: from a team (in) or from the desk (out)
    by: str | None = None  # decision: who decided
    audio: str | None = None  # radio: the spoken line, a path under the site (demo fixtures only)


class MissionBundle(_Model):
    """Root type used only to export the live-mission models (section 12) to the JSON Schema."""

    mission: Mission
    map_base: MapBase
    map_update: MapUpdate
    verdict: Verdict
    task: SectorTask
    team: Team
    clue_draft: ClueDraft
    clue: Clue
    proposal: Proposal
    fleet: FleetState
    telemetry: FleetTelemetry
    conditions: Conditions
    card: AssignmentCard
    event: MissionEvent
    trace: TraceEntry
    radio_turn: RadioTurn
    timeline_entry: TimelineEntry


# --- JSON schema and writing ---------------------------------------------------------------


class CacheBundle(_Model):
    """Root type used only to export one JSON Schema covering every cache file."""

    manifest: Manifest
    survey: Survey
    detections: Detections
    map: MapFile
    metrics: Metrics
    mission: MissionBundle | None = None  # v1.2 live-mission models; never in a cache


def _for_json2ts(node: Any, named: bool = False) -> Any:
    """Reshape Pydantic's JSON Schema so json-schema-to-typescript emits clean types.

    Tuples use `prefixItems`, which json2ts ignores (it wants an `items` list), and per-field
    `title`s make it invent aliases like `Lat1`; only named definitions keep their title.
    """
    if isinstance(node, list):
        return [_for_json2ts(v) for v in node]
    if not isinstance(node, dict):
        return node
    out: dict[str, Any] = {}
    for key, value in node.items():
        if key == "title" and not named:
            continue
        if key == "prefixItems":
            out["items"] = [_for_json2ts(v) for v in value]
            out["additionalItems"] = False
        elif key == "$defs":
            out[key] = {name: _for_json2ts(d, named=True) for name, d in value.items()}
        elif key == "properties":  # field names, not keywords: a field may be called "title"
            out[key] = {name: _for_json2ts(d) for name, d in value.items()}
        else:
            out[key] = _for_json2ts(value)
    return out


def export_json_schema(out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    schema = _for_json2ts(CacheBundle.model_json_schema(), named=True)
    out.write_text(json.dumps(schema, indent=2) + "\n")


def _decimals(path: tuple[str, ...]) -> int | None:
    """Decimal places for the float at `path` (contract section 2); None = leave unrounded."""
    if path[0] in ("prior", "final"):
        return None
    if path[-1] in ("lat", "lon") or "footprint" in path:
        return 6
    if path[0] in ("steps", "canopy") or (path[0] == "top_cells" and path[-1] in ("p", "canopy")):
        return 4
    return 3


def _round(node: Any, path: tuple[str, ...]) -> Any:
    if isinstance(node, dict):
        return {k: _round(v, (*path, k)) for k, v in node.items()}
    if isinstance(node, list):
        return [_round(v, path) for v in node]
    if isinstance(node, float):
        places = _decimals(path)
        return node if places is None else round(node, places)
    return node


def dump_json(model: BaseModel) -> str:
    """Serialise a top-level contract file with the contract's float precision. Rejects NaN."""
    data = model.model_dump(mode="json")
    return json.dumps(_round(data, ()), indent=2, allow_nan=False) + "\n"


def _cli() -> None:
    parser = argparse.ArgumentParser(prog="python -m sightline.contract")
    sub = parser.add_subparsers(dest="command", required=True)
    schema = sub.add_parser("schema", help="write the JSON Schema of every cache file")
    schema.add_argument("out", type=Path)
    args = parser.parse_args()
    if args.command == "schema":
        export_json_schema(args.out)


if __name__ == "__main__":
    _cli()
