// Typed calls to the mission API (contract §13, LANE_D §4 D-M1). The base URL comes from
// VITE_API_URL; with none set the site is demo-only (`hasApi()` is false). Built by lane A for
// lane D (issue #51).

import type {
  AssignmentCard,
  Clue,
  ClueDraft,
  Conditions,
  Detections,
  FleetState,
  MapBase,
  MapUpdate,
  Mission,
  MissionEvent,
  Proposal,
  SectorTask,
  Survey,
  Team,
  TraceEntry,
  Verdict,
} from "../contract";

/** What GET /missions/{id}/state returns. */
export interface MissionStateResponse {
  mission: Mission;
  tasks: SectorTask[];
  teams: Team[];
  clues: Clue[];
  proposals: Proposal[];
  verdicts: Verdict[];
  fleet: FleetState | null;
  conditions: Conditions | null;
  events: MissionEvent[];
}

export interface UploadResult {
  accepted: string[];
  rejected: { name: string; reason: string }[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The mission API's base URL ("" = same origin), or null when the site is demo-only. */
export function apiBase(env: { VITE_API_URL?: string } = import.meta.env): string | null {
  const url = env.VITE_API_URL;
  return url === undefined || url === "" ? null : url.replace(/\/$/, "");
}

export function hasApi(): boolean {
  return apiBase() !== null;
}

export interface Api {
  base: string;
  fetch?: typeof fetch;
}

async function call<T>(api: Api, method: string, path: string, body?: unknown): Promise<T> {
  const f = api.fetch ?? fetch;
  const res = await f(`${api.base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { detail?: unknown };
      if (typeof j.detail === "string") detail = j.detail;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

const m = (id: string) => `/missions/${encodeURIComponent(id)}`;

export interface NewMission {
  name: string;
  area_name: string;
  lkp: { lat: number; lon: number };
  last_seen_at?: string | null;
  subject?: string | null;
  mode?: "live" | "demo" | "replay";
}

export const createMission = (api: Api, body: NewMission) => call<Mission>(api, "POST", "/missions", body);
export const getState = (api: Api, id: string) => call<MissionStateResponse>(api, "GET", `${m(id)}/state`);
export const getSurvey = (api: Api, id: string) => call<Survey>(api, "GET", `${m(id)}/survey`);
export const getDetections = (api: Api, id: string) => call<Detections>(api, "GET", `${m(id)}/detections`);
/** Lane B's assignment card for a sector (E-09); `cardFileUrl` for its GPX and KML. */
export const getCard = (api: Api, id: string, sector: string) =>
  call<AssignmentCard>(api, "GET", `${m(id)}/cards/${encodeURIComponent(sector)}`);
export const cardFileUrl = (api: Api, id: string, sector: string, ext: "gpx" | "kml") =>
  `${api.base}${m(id)}/cards/${encodeURIComponent(sector)}.${ext}`;
/** GET /health: what this API runs (contract §13), including whether the radio desk is mounted. */
export interface Health {
  status: string;
  contract_version: string;
  backend: string;
  detector?: string | null;
  radio?: boolean;
}
export const getHealth = (api: Api) => call<Health>(api, "GET", "/health");
export const getMapBase = (api: Api, id: string) => call<MapBase>(api, "GET", `${m(id)}/map_base`);
/** A sector now (GET /sectors): label, POA on the live map, drone coverage. */
export interface SectorNow {
  sector_id: string;
  label: string;
  poa: number;
  drone_coverage: number;
  /** The outline, a closed [lon, lat] ring (servers before #83 leave it out). */
  polygon?: [number, number][];
}
export const getSectors = (api: Api, id: string) => call<SectorNow[]>(api, "GET", `${m(id)}/sectors`);
/** The agent's trace, oldest first; `after`: only the entries after that id (polling). */
export const getTrace = (api: Api, id: string, after?: string | null) =>
  call<TraceEntry[]>(api, "GET", `${m(id)}/trace${after ? `?after=${encodeURIComponent(after)}` : ""}`);

export const getMapUpdates = (api: Api, id: string, after = 0) =>
  call<MapUpdate[]>(api, "GET", `${m(id)}/map_updates?after=${after}`);

export const decide = (
  api: Api,
  id: string,
  pid: string,
  body: { decision: "approve" | "reject"; by: string; reason?: string; edits?: Record<string, string> },
) => call<Proposal>(api, "POST", `${m(id)}/proposals/${encodeURIComponent(pid)}/decide`, body);

export const postReview = (api: Api, id: string, detection_id: string, answer: "person" | "not_person" | "unsure") =>
  call<unknown>(api, "POST", `${m(id)}/reviews`, { detection_id, answer });

export const postClue = (api: Api, id: string, draft: ClueDraft) => call<Clue>(api, "POST", `${m(id)}/clues`, draft);

export const postTask = (
  api: Api,
  id: string,
  sector: string,
  body: { state: SectorTask["state"]; team_id?: string | null; pod?: number | null; note?: string | null },
) => call<{ task: SectorTask }>(api, "POST", `${m(id)}/tasks/${encodeURIComponent(sector)}`, body);

export const patchTeam = (api: Api, id: string, tid: string, patch: Partial<Team>) =>
  call<Team>(api, "PATCH", `${m(id)}/teams/${encodeURIComponent(tid)}`, patch);

/** Upload one batch (≤ 50 files) of JPEGs. */
export async function uploadPhotos(api: Api, id: string, files: readonly File[]): Promise<UploadResult> {
  const form = new FormData();
  for (const f of files) form.append("files", f, f.name);
  const res = await (api.fetch ?? fetch)(`${api.base}${m(id)}/photos`, { method: "POST", body: form });
  if (!res.ok) throw new ApiError(res.status, `upload failed (HTTP ${res.status})`);
  return (await res.json()) as UploadResult;
}

/** A mission file (frame, crop, re-look crop, radio audio) as a URL for <img>/<audio>. */
export const fileUrl = (api: Api, id: string, rel: string) => `${api.base}${m(id)}/files/${rel}`;
/** The SSE stream; `after` resumes after that event id. */
export const eventsUrl = (api: Api, id: string, after?: string | null) =>
  `${api.base}${m(id)}/events${after ? `?after=${encodeURIComponent(after)}` : ""}`;
