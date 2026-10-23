// Typed calls to the mission API (contract §13, LANE_D §4 D-M1). The base URL comes from
// VITE_API_URL; with none set the site is demo-only (`hasApi()` is false). Built by lane A for
// lane D (issue #51).
//
// VITE_API_TOKEN (build time) is sent as `Authorization: Bearer <token>` on writes, for an API started
// with SIGHTLINE_API_TOKEN. Only for a private deployment, never the public site: the token is baked
// into the bundle, so anyone who loads the page can read it.

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
  TimelineEvent,
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

/** The API's write token (VITE_API_TOKEN), or null. Private deployments only: it ships in the bundle. */
export function apiToken(
  env: { VITE_API_TOKEN?: string } = import.meta.env as { VITE_API_TOKEN?: string },
): string | null {
  const token = env.VITE_API_TOKEN?.trim();
  return token ? token : null;
}

export interface Api {
  base: string;
  fetch?: typeof fetch;
  /** The write token; undefined = VITE_API_TOKEN, null = none. */
  token?: string | null;
}

/** `Authorization` for a write. Reads go without it: a GET with it would need a CORS preflight. */
export function authHeaders(api: Api, method: string): Record<string, string> {
  if (method === "GET" || method === "HEAD") return {};
  const token = api.token === undefined ? apiToken() : api.token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function call<T>(api: Api, method: string, path: string, body?: unknown): Promise<T> {
  const f = api.fetch ?? fetch;
  const headers = {
    ...authHeaders(api, method),
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
  };
  const res = await f(`${api.base}${path}`, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
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

/** An image review (contract 15.7): "object" comes with its type, and becomes a clue candidate. */
export const postReview = (api: Api, id: string, detection_id: string, answer: ReviewAnswer, object?: ObjectType | null, by?: string) =>
  call<unknown>(api, "POST", `${m(id)}/reviews`, { detection_id, answer, ...(answer === "object" ? { object: object ?? "other" } : {}), ...(by ? { by } : {}) });
export type ReviewAnswer = "person" | "not_person" | "not_subject" | "object" | "unsure";
export type ObjectType = "backpack" | "fire ring" | "shelter" | "other";

/** A clue candidate (an image reviewer's object) confirmed by a team on the ground, at a reliability. */
export const confirmClueCandidate = (api: Api, id: string, clueId: string, by: string, reliability: "low" | "medium" | "high" = "medium") =>
  call<Clue>(api, "POST", `${m(id)}/clues/${encodeURIComponent(clueId)}/confirm`, { reliability, by });

export const postClue = (api: Api, id: string, draft: ClueDraft) => call<Clue>(api, "POST", `${m(id)}/clues`, draft);

export const postTask = (
  api: Api,
  id: string,
  sector: string,
  body: { state: SectorTask["state"]; team_id?: string | null; pod?: number | null; note?: string | null },
) => call<{ task: SectorTask }>(api, "POST", `${m(id)}/tasks/${encodeURIComponent(sector)}`, body);

export const patchTeam = (api: Api, id: string, tid: string, patch: Partial<Team>) =>
  call<Team>(api, "PATCH", `${m(id)}/teams/${encodeURIComponent(tid)}`, patch);

/** Ask the simulated fleet to change a drone's link (the sim applies it from the event stream). */
export const postFleetLink = (api: Api, id: string, target: string, link: "connected" | "degraded" | "lost", by: string) =>
  call<MissionEvent>(api, "POST", `${m(id)}/fleet/link`, { target, link, by });

// The command post's direct actions (the console acts without waiting for the agent; each one is logged to
// the timeline like an approval). A server from before them answers 404 and the store falls back to the
// task and team calls above where there is one (useMission).
const team = (id: string, tid: string) => `${m(id)}/teams/${encodeURIComponent(tid)}`;
const sector = (id: string, sid: string) => `${m(id)}/sectors/${encodeURIComponent(sid)}`;
export const assignTeam = (api: Api, id: string, tid: string, sector_id: string) => call<unknown>(api, "POST", `${team(id, tid)}/assign`, { sector: sector_id });
export const callTeam = (api: Api, id: string, tid: string, text: string) => call<unknown>(api, "POST", `${team(id, tid)}/call`, { text });
export const recallTeam = (api: Api, id: string, tid: string) => call<unknown>(api, "POST", `${team(id, tid)}/recall`, {});
export const markSearched = (api: Api, id: string, sid: string, pod: number) => call<unknown>(api, "POST", `${sector(id, sid)}/searched`, { pod });
export const recheckSector = (api: Api, id: string, sid: string) => call<unknown>(api, "POST", `${sector(id, sid)}/recheck`, {});
export const postFound = (api: Api, id: string, tid: string, sector_id: string) => call<Mission>(api, "POST", `${m(id)}/found`, { team: tid, sector: sector_id });

/**
 * The mission timeline so far (`GET /missions/{id}/events` asked for JSON). The same path is the SSE
 * stream: a server that answers it with the stream only (or not at all) gives an empty list, and the
 * console builds its timeline from the mission events instead.
 */
export async function getTimeline(api: Api, id: string): Promise<TimelineEvent[]> {
  const ctl = new AbortController();
  try {
    const r = await (api.fetch ?? fetch)(`${api.base}${m(id)}/events`, { headers: { accept: "application/json" }, signal: ctl.signal });
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return [];
    const j = (await r.json()) as unknown;
    const list = Array.isArray(j) ? j : Array.isArray((j as { events?: unknown }).events) ? (j as { events: unknown[] }).events : [];
    return list.filter((e): e is TimelineEvent => !!e && typeof e === "object" && "kind" in e && "text" in e);
  } catch {
    return [];
  } finally {
    ctl.abort(); // never stay on a stream
  }
}

/** Demo only: a conditions record labelled "override (demo)", handled like a refresh (refused for a real fleet). */
export const overrideConditions = (api: Api, id: string, gust_kmh: number, by: string) =>
  call<Conditions>(api, "POST", `${m(id)}/conditions/override`, { gust_kmh, by });

/** Look the conditions up again (Tavily; cached per hour on the server). */
export const refreshConditions = (api: Api, id: string) => call<Conditions>(api, "POST", `${m(id)}/conditions/refresh`);

/** Upload one batch (≤ 50 files) of JPEGs. */
export async function uploadPhotos(api: Api, id: string, files: readonly File[]): Promise<UploadResult> {
  const form = new FormData();
  for (const f of files) form.append("files", f, f.name);
  const res = await (api.fetch ?? fetch)(`${api.base}${m(id)}/photos`, {
    method: "POST",
    headers: authHeaders(api, "POST"),
    body: form,
  });
  if (!res.ok) throw new ApiError(res.status, `upload failed (HTTP ${res.status})`);
  return (await res.json()) as UploadResult;
}

/** A mission file (frame, crop, re-look crop, radio audio) as a URL for <img>/<audio>. */
export const fileUrl = (api: Api, id: string, rel: string) => `${api.base}${m(id)}/files/${rel}`;
/** The SSE stream; `after` resumes after that event id. */
export const eventsUrl = (api: Api, id: string, after?: string | null) =>
  `${api.base}${m(id)}/events${after ? `?after=${encodeURIComponent(after)}` : ""}`;
