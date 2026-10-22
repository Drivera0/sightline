// useMission (LANE_D §4, §5.5 D-M1): one live mission in the browser. Live mode loads the state over
// the API, then applies the SSE events (`applyEvent`, a pure reducer); the browser's EventSource
// reconnects on its own and resumes with Last-Event-ID. Actions update the local state at once
// (optimistic) and the server's events confirm them. Demo mode (`useDemo`) runs the same actions on an
// in-memory mission, so the click path works on Vercel with no backend. Built by lane A for lane D.

import { create } from "zustand";
import type {
  Clue,
  ClueDraft,
  Conditions,
  Detection,
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
  Verdict,
} from "../contract";
import * as api from "./api";
import type { Api, SectorNow } from "./api";

export const EVENT_TYPES: readonly MissionEvent["type"][] = [
  "photo.processed", "detection.new", "verdict", "map.updated", "proposal.new", "proposal.decided",
  "clue.added", "task.updated", "team.updated", "fleet.updated", "conditions.updated", "radio.turn",
  "mission.note",
];
const MAX_EVENTS = 200;

// The simulated fleet's link model (sightline/search/fleet.py). Not contract models: the sim reports
// link changes and relayed team positions as `mission.note` events (data `fleet_link` / `relay`), and
// `GET /missions/{id}/fleet/links` gives the latest of each. A drone or team never reported is connected.
export type DroneLinkState = "connected" | "degraded" | "lost";
export interface DroneLink {
  link: DroneLinkState;
  since: string | null;
  /** When the ground station last heard the drone's telemetry (set when the link drops). */
  last_heard_at: string | null;
  for_s?: number | null;
  by?: string | null;
}
export interface TeamRelay {
  team_id: string;
  callsign?: string | null;
  /** The drones that carried the team's check-in, in order (via[0] heard it). */
  via: string[];
  hops: number;
  heard_at: string;
  age_s: number;
  lat: number;
  lon: number;
}
export interface TeamLink {
  link: "connected" | "no_signal";
  since?: string | null;
  relay?: TeamRelay;
}
export interface FleetLinks {
  drones: Record<string, DroneLink>;
  teams: Record<string, TeamLink>;
}
export const NO_LINKS: FleetLinks = { drones: {}, teams: {} };

/** The links after one event (pure): only the sim's `mission.note` reports change them. */
export function applyLinkEvent(links: FleetLinks, ev: MissionEvent): FleetLinks {
  if (ev.type !== "mission.note" || !ev.data) return links;
  const d = ev.data as { fleet_link?: { target: string; link: string; last_heard_at?: string | null; for_s?: number | null; by?: string | null }; relay?: TeamRelay };
  if (d.fleet_link) {
    const f = d.fleet_link;
    if (f.target.startsWith("T") && (f.link === "connected" || f.link === "no_signal")) {
      return { ...links, teams: { ...links.teams, [f.target]: { ...links.teams[f.target], link: f.link, since: ev.at } } };
    }
    const entry: DroneLink = { link: f.link as DroneLinkState, since: ev.at, last_heard_at: f.last_heard_at ?? null, for_s: f.for_s ?? null, by: f.by ?? null };
    return { ...links, drones: { ...links.drones, [f.target]: entry } };
  }
  if (d.relay) {
    const t = d.relay.team_id;
    return { ...links, teams: { ...links.teams, [t]: { link: links.teams[t]?.link ?? "no_signal", since: links.teams[t]?.since ?? null, relay: d.relay } } };
  }
  return links;
}

export function fleetLinksFromEvents(events: readonly MissionEvent[]): FleetLinks {
  return events.reduce(applyLinkEvent, NO_LINKS);
}

export interface MissionData {
  mission: Mission | null;
  tasks: SectorTask[];
  teams: Team[];
  clues: Clue[];
  proposals: Proposal[];
  verdicts: Verdict[];
  fleet: FleetState | null;
  conditions: Conditions | null;
  events: MissionEvent[];
  survey: Survey | null;
  detections: Detections | null;
  /** Detections an approved `promote_detection` put in the review queue (below the threshold). */
  promoted: string[];
  mapBase: MapBase | null;
  mapUpdates: MapUpdate[];
  /** Each sector's POA and drone coverage on the live map (refreshed after map updates). */
  sectors: SectorNow[];
  /** The simulated fleet's link states and relayed team positions. */
  links: FleetLinks;
}

export const EMPTY: MissionData = {
  mission: null, tasks: [], teams: [], clues: [], proposals: [], verdicts: [], fleet: null,
  conditions: null, events: [], survey: null, detections: null, promoted: [], mapBase: null, mapUpdates: [], sectors: [],
  links: NO_LINKS,
};

function upsert<T>(list: readonly T[], item: T, key: (x: T) => string): T[] {
  const k = key(item);
  const i = list.findIndex((x) => key(x) === k);
  return i < 0 ? [...list, item] : list.map((x, j) => (j === i ? item : x));
}

function addDetection(d: Detections | null, det: Detection): Detections | null {
  if (!d) return d;
  const frameId = det.id.slice(0, 5);
  const current = d.frames[frameId] ?? [];
  if (current.some((x) => x.id === det.id)) return d;
  const frame = [...current, det].sort((a, b) => b.conf - a.conf);
  return { ...d, frames: { ...d.frames, [frameId]: frame } };
}

/** The state after one event (pure). Events already applied (same id) change nothing. */
export function applyEvent(s: MissionData, ev: MissionEvent): MissionData {
  if (s.events.some((e) => e.id === ev.id)) return s;
  const events = [...s.events, ev].slice(-MAX_EVENTS);
  const data = ev.data as unknown;
  const next: MissionData = { ...s, events, links: applyLinkEvent(s.links ?? NO_LINKS, ev) };
  switch (ev.type) {
    case "detection.new": {
      const det = data as (Detection & { promoted_by?: string }) | null;
      if (!det) break;
      next.detections = addDetection(s.detections, det);
      if (det.promoted_by && !s.promoted.includes(det.id)) next.promoted = [...s.promoted, det.id];
      break;
    }
    case "verdict":
      if (data) next.verdicts = upsert(s.verdicts, data as Verdict, (v) => v.id);
      break;
    case "map.updated": {
      const u = data as MapUpdate | null;
      const last = s.mapUpdates.at(-1)?.seq ?? 0;
      if (u && u.seq > last) next.mapUpdates = [...s.mapUpdates, u];
      break;
    }
    case "proposal.new":
    case "proposal.decided":
      if (data) next.proposals = upsert(s.proposals, data as Proposal, (p) => p.id);
      break;
    case "clue.added":
      if (data) next.clues = upsert(s.clues, data as Clue, (c) => c.id);
      break;
    case "task.updated":
      if (data) next.tasks = upsert(s.tasks, data as SectorTask, (t) => t.sector_id);
      break;
    case "team.updated":
      if (data) next.teams = upsert(s.teams, data as Team, (t) => t.id);
      break;
    case "fleet.updated":
      if (data) next.fleet = data as FleetState;
      break;
    case "conditions.updated":
      if (data) next.conditions = data as Conditions;
      break;
    default:
      break;
  }
  return next;
}

/** "photo.processed" events so far, with their timings (MissionProgress). */
export function photoProgress(s: MissionData): { processed: number; candidates: number; medianS: number | null } {
  const done = s.events.filter((e) => e.type === "photo.processed");
  const ms = done.map((e) => Number((e.data as { total_ms?: number } | null)?.total_ms ?? 0)).sort((a, b) => a - b);
  const candidates = Object.values(s.detections?.frames ?? {})
    .flat()
    .filter((d) => d.crop !== null).length;
  const median = ms.length ? (ms[Math.floor((ms.length - 1) / 2)] as number) / 1000 : null;
  return { processed: done.length, candidates, medianS: median };
}

type Status = "idle" | "connecting" | "live" | "reconnecting" | "demo" | "error";

interface EventSourceLike {
  addEventListener: (type: string, fn: (e: MessageEvent) => void) => void;
  onopen: ((e: Event) => void) | null;
  onerror: ((e: Event) => void) | null;
  close: () => void;
}
type EventSourceCtor = new (url: string) => EventSourceLike;

interface MissionStore extends MissionData {
  status: Status;
  error: string | null;
  api: Api | null;
  connect: (missionId: string, api: Api, deps?: { EventSource?: EventSourceCtor }) => Promise<void>;
  useDemo: (data: Partial<MissionData>) => void;
  disconnect: () => void;
  decide: (pid: string, decision: "approve" | "reject", by: string, reason?: string, edits?: Record<string, string>) => Promise<void>;
  review: (detectionId: string, answer: "person" | "not_person" | "unsure") => Promise<void>;
  addClue: (draft: ClueDraft) => Promise<void>;
  setTask: (sector: string, body: { state: SectorTask["state"]; team_id?: string | null; pod?: number | null; note?: string | null }) => Promise<void>;
  /** Re-read the survey and detections (after a photo is processed). */
  refreshPhotos: () => Promise<void>;
  /** Re-read the sectors' POA and coverage (after the map changes; at most every 2 s). */
  refreshSectors: () => Promise<void>;
  updateTeam: (teamId: string, patch: Partial<Team>) => Promise<void>;
}

let source: EventSourceLike | null = null;
let lastSectors = 0;
let demoSeq = 0;

const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

export const useMission = create<MissionStore>((set, get) => {
  /** Demo mode: an event as the server would have sent it. */
  const demoEvent = (type: MissionEvent["type"], summary: string, ref: string | null, data: unknown) => {
    demoSeq += 1;
    const ev: MissionEvent = { id: `e${String(demoSeq).padStart(5, "0")}`, type, at: now(), summary, ref, data: data as MissionEvent["data"] };
    set((s) => applyEvent(s, ev));
  };
  const mid = () => get().mission?.mission_id ?? "";

  return {
    ...EMPTY,
    status: "idle",
    error: null,
    api: null,

    connect: async (missionId, a, deps = {}) => {
      get().disconnect();
      set({ ...EMPTY, status: "connecting", error: null, api: a });
      try {
        const [state, survey, detections, mapBase, mapUpdates, sectors] = await Promise.all([
          api.getState(a, missionId),
          api.getSurvey(a, missionId),
          api.getDetections(a, missionId),
          api.getMapBase(a, missionId).catch(() => null),
          api.getMapUpdates(a, missionId).catch(() => [] as MapUpdate[]),
          api.getSectors(a, missionId).catch(() => [] as SectorNow[]),
        ]);
        const { events, ...rest } = state;
        const links = await fetchLinks(a, missionId).catch(() => fleetLinksFromEvents(events));
        set({ ...rest, events, survey, detections, mapBase, mapUpdates, sectors, promoted: [], links });
        const Ctor = deps.EventSource ?? (globalThis.EventSource as unknown as EventSourceCtor);
        const es = new Ctor(api.eventsUrl(a, missionId, events.at(-1)?.id ?? null));
        source = es;
        es.onopen = () => set({ status: "live" });
        es.onerror = () => set({ status: "reconnecting" }); // EventSource retries with Last-Event-ID
        for (const type of EVENT_TYPES) {
          es.addEventListener(type, (e: MessageEvent) => {
            const ev = JSON.parse(e.data as string) as MissionEvent;
            set((s) => applyEvent(s, ev));
            if (ev.type === "photo.processed") void get().refreshPhotos();
            if (ev.type === "map.updated") void get().refreshSectors();
          });
        }
        set({ status: "live" });
      } catch (e) {
        set({ status: "error", error: e instanceof Error ? e.message : String(e) });
      }
    },

    useDemo: (data) => {
      get().disconnect();
      demoSeq = data.events?.length ?? 0;
      set({ ...EMPTY, links: fleetLinksFromEvents(data.events ?? []), ...data, status: "demo", error: null, api: null });
    },

    disconnect: () => {
      source?.close();
      source = null;
    },

    refreshPhotos: async () => {
      const a = get().api;
      if (!a) return;
      const [survey, detections] = await Promise.all([api.getSurvey(a, mid()), api.getDetections(a, mid())]);
      // Keep detections that arrived by event while this was loading.
      set((s) => ({ survey, detections: mergeDetections(detections, s.detections) }));
    },

    refreshSectors: async () => {
      const a = get().api;
      const now = Date.now();
      if (!a || now - lastSectors < 2000) return;
      lastSectors = now;
      try {
        set({ sectors: await api.getSectors(a, mid()) });
      } catch {
        /* the next map update tries again */
      }
    },

    updateTeam: async (teamId, patch) => {
      const before = get().teams;
      set({ teams: before.map((t) => (t.id === teamId ? { ...t, ...patch } : t)) });
      const a = get().api;
      if (!a) {
        const team = get().teams.find((t) => t.id === teamId);
        if (team) demoEvent("team.updated", `${team.callsign}: ${team.status}`, teamId, team);
        return;
      }
      try {
        await api.patchTeam(a, mid(), teamId, patch);
      } catch (e) {
        set({ teams: before, error: e instanceof Error ? e.message : String(e) });
      }
    },

    decide: async (pid, decision, by, reason, edits) => {
      const before = get().proposals;
      const status = decision === "approve" ? "approved" : "rejected";
      const optimistic = before.map((p) =>
        p.id === pid
          ? { ...p, status, decided_by: by, decided_at: now(), decision_reason: reason ?? null, edits: edits ?? null, briefing: edits?.briefing ?? p.briefing }
          : p,
      ) as Proposal[];
      set({ proposals: optimistic });
      const a = get().api;
      if (!a) {
        const p = optimistic.find((x) => x.id === pid);
        if (p) demoEvent("proposal.decided", `${pid} ${status} by ${by}`, pid, p);
        return;
      }
      try {
        const p = await api.decide(a, mid(), pid, { decision, by, reason, edits });
        set((s) => ({ proposals: upsert(s.proposals, p, (x) => x.id) }));
      } catch (e) {
        set({ proposals: before, error: e instanceof Error ? e.message : String(e) }); // roll back
      }
    },

    review: async (detectionId, answer) => {
      const a = get().api;
      if (!a) {
        demoEvent("mission.note", `review ${detectionId}: ${answer}`, detectionId, { answer });
        return;
      }
      try {
        await api.postReview(a, mid(), detectionId, answer);
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) });
      }
    },

    addClue: async (draft) => {
      const a = get().api;
      if (!a) {
        const n = get().clues.length + 1;
        const clue = { ...draft, id: `c${String(n).padStart(3, "0")}`, lat: draft.lat ?? 0, lon: draft.lon ?? 0, radius_m: draft.radius_m ?? 25, at: now(), confirmed: true } as Clue;
        demoEvent("clue.added", `${clue.kind}: ${clue.text}`, clue.id, clue);
        return;
      }
      try {
        const clue = await api.postClue(a, mid(), draft);
        set((s) => ({ clues: upsert(s.clues, clue, (c) => c.id) }));
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    },

    setTask: async (sector, body) => {
      const before = get().tasks;
      const old = before.find((t) => t.sector_id === sector);
      const task: SectorTask = {
        sector_id: sector, state: body.state, team_id: body.team_id ?? null, poa: old?.poa ?? 0,
        pod: body.pod ?? null, note: body.note ?? null, updated_at: now(),
      };
      set({ tasks: upsert(before, task, (t) => t.sector_id) });
      const a = get().api;
      if (!a) {
        demoEvent("task.updated", `sector ${sector}: ${task.state}`, sector, task);
        return;
      }
      try {
        await api.postTask(a, mid(), sector, body);
      } catch (e) {
        set({ tasks: before, error: e instanceof Error ? e.message : String(e) });
      }
    },
  };
});

/** GET /missions/{id}/fleet/links: the latest link of every drone and team (a server without the
 * fleet's link model answers 404, and the caller reads the events it has instead). */
async function fetchLinks(a: Api, missionId: string): Promise<FleetLinks> {
  const r = await (a.fetch ?? fetch)(`${a.base}/missions/${missionId}/fleet/links`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = (await r.json()) as Partial<FleetLinks>;
  return { drones: j.drones ?? {}, teams: j.teams ?? {} };
}

function mergeDetections(fresh: Detections, current: Detections | null): Detections {
  if (!current) return fresh;
  let out = fresh;
  for (const dets of Object.values(current.frames)) for (const d of dets) out = addDetection(out, d) ?? out;
  return out;
}
