import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Detection, MissionEvent, Proposal } from "../contract";
import { applyEvent, EMPTY, photoProgress, useMission, type MissionData } from "./mission";

const AT = "2026-10-24T21:40:00Z";
const API = "http://api.test";
const MID = "a1b2c3d4";

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: "p001", kind: "assign_sector", summary: "Assign sector B3 to Team Two", reason: "r",
  briefing: "New assignment.", target: { team: "T2", sector: "B3" }, evidence: [], status: "pending",
  created_by: "agent", created_at: AT, decided_at: null, decided_by: null, decision_reason: null,
  edits: null, ...over,
});
const det = (id: string, conf: number, crop: string | null): Detection => ({
  id, box_px: [1, 1, 9, 9], conf, crop, lat: 49.37, lon: -122.93, radius_m: 10,
});
let n = 0;
const ev = (type: MissionEvent["type"], data: unknown, ref: string | null = null): MissionEvent => ({
  id: `e${String(++n).padStart(5, "0")}`, type, at: AT, summary: type, ref, data: data as MissionEvent["data"],
});

const base = (): MissionData => ({
  ...EMPTY,
  detections: { contract_version: "1.2", model: "m", save_threshold: 0.05, candidate_threshold: 0.29, frames: {} },
});

describe("applyEvent", () => {
  it("adds and updates what each event carries, once per event id", () => {
    let s = base();
    const e1 = ev("proposal.new", proposal());
    s = applyEvent(s, e1);
    s = applyEvent(s, e1); // replayed after a reconnect
    expect(s.proposals).toHaveLength(1);
    expect(s.events).toHaveLength(1);
    s = applyEvent(s, ev("proposal.decided", proposal({ status: "approved", decided_by: "SM", decided_at: AT })));
    expect(s.proposals[0]?.status).toBe("approved");
    s = applyEvent(s, ev("detection.new", det("f0001-d01", 0.8, "crops/f0001-d01.jpg")));
    s = applyEvent(s, ev("detection.new", { ...det("f0001-d02", 0.2, null), promoted_by: "p002" }));
    expect(s.detections?.frames.f0001?.map((d) => d.id)).toEqual(["f0001-d01", "f0001-d02"]);
    expect(s.promoted).toEqual(["f0001-d02"]);
    s = applyEvent(s, ev("team.updated", { id: "T2", callsign: "Team Two", members: 3, status: "assigned", position: null, position_at: null, note: null }));
    s = applyEvent(s, ev("map.updated", { seq: 1, kind: "step", source: "frame", ref: "f0001", cells: [[0, 0.5]], at: AT }));
    s = applyEvent(s, ev("map.updated", { seq: 1, kind: "step", source: "frame", ref: "f0001", cells: [[0, 0.5]], at: AT }));
    expect(s.teams[0]?.status).toBe("assigned");
    expect(s.mapUpdates.map((u) => u.seq)).toEqual([1]);
  });

  it("counts processed photos, candidates and the median time", () => {
    let s = applyEvent(base(), ev("detection.new", det("f0001-d01", 0.8, "crops/f0001-d01.jpg")));
    for (const ms of [2000, 1000, 3000]) s = applyEvent(s, ev("photo.processed", { total_ms: ms }));
    expect(photoProgress(s)).toEqual({ processed: 3, candidates: 1, medianS: 2 });
  });
});

class MockEventSource {
  static last: MockEventSource | null = null;
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    MockEventSource.last = this;
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(e: MissionEvent) {
    for (const fn of this.listeners[e.type] ?? []) fn({ data: JSON.stringify(e) } as MessageEvent);
  }
  close() {
    this.closed = true;
  }
}

function server(decideStatus = 200) {
  const replies: Record<string, unknown> = {
    [`/missions/${MID}/state`]: {
      mission: { contract_version: "1.2", mission_id: MID, name: "Seymour", area: { name: "a", lkp: { lat: 49.37, lon: -122.93 } }, created_at: AT, mode: "live", last_seen_at: null, subject: null },
      tasks: [], teams: [], clues: [], proposals: [proposal()], verdicts: [], fleet: null, conditions: null,
      events: [{ id: "e00007", type: "mission.note", at: AT, summary: "x", ref: null, data: null }],
    },
    [`/missions/${MID}/survey`]: { contract_version: "1.2", survey_id: MID, simulated_path: false, area: { name: "a", lkp: { lat: 0, lon: 0 } }, frames: [] },
    [`/missions/${MID}/detections`]: base().detections,
    [`/missions/${MID}/map_base`]: null,
    [`/missions/${MID}/map_updates?after=0`]: [],
  };
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(API, "");
    if (path.endsWith("/decide")) {
      const body = JSON.parse(String(init?.body));
      return decideStatus === 200
        ? Response.json(proposal({ status: "approved", decided_by: body.by, decided_at: AT }))
        : Response.json({ detail: "p001 is rejected, not pending" }, { status: decideStatus });
    }
    return Response.json(replies[path] ?? {});
  }) as unknown as typeof fetch;
}

describe("useMission, live", () => {
  beforeEach(() => useMission.getState().disconnect());

  it("loads the state, resumes the stream after the last event, and applies events", async () => {
    const fetch = server();
    await useMission.getState().connect(MID, { base: API, fetch }, { EventSource: MockEventSource });
    const es = MockEventSource.last!;
    expect(es.url).toBe(`${API}/missions/${MID}/events?after=e00007`);
    expect(useMission.getState().status).toBe("live");
    es.emit(ev("clue.added", { id: "c001", kind: "object", text: "backpack" }, "c001"));
    expect(useMission.getState().clues.map((c) => c.id)).toEqual(["c001"]);
    es.onerror?.(new Event("error"));
    expect(useMission.getState().status).toBe("reconnecting");
  });

  it("shows a decision at once and keeps it when the server agrees", async () => {
    const fetch = server();
    await useMission.getState().connect(MID, { base: API, fetch }, { EventSource: MockEventSource });
    const done = useMission.getState().decide("p001", "approve", "SM");
    expect(useMission.getState().proposals[0]?.status).toBe("approved"); // optimistic
    await done;
    expect(useMission.getState().proposals[0]?.decided_by).toBe("SM");
  });

  it("rolls a decision back when the server refuses it", async () => {
    await useMission.getState().connect(MID, { base: API, fetch: server(409) }, { EventSource: MockEventSource });
    await useMission.getState().decide("p001", "approve", "SM");
    expect(useMission.getState().proposals[0]?.status).toBe("pending");
    expect(useMission.getState().error).toContain("not pending");
  });
});

describe("useMission, demo", () => {
  it("runs actions in memory and appends events, with no backend", async () => {
    useMission.getState().useDemo({ ...base(), proposals: [proposal()] });
    expect(useMission.getState().status).toBe("demo");
    await useMission.getState().decide("p001", "approve", "Search manager", undefined, { briefing: "Edited." });
    await useMission.getState().setTask("B3", { state: "searched", pod: 0.6 });
    await useMission.getState().addClue({ kind: "object", text: "backpack", lat: 49.37, lon: -122.93, reported_by: "command", source: "form" } as never);
    const s = useMission.getState();
    expect(s.proposals[0]).toMatchObject({ status: "approved", briefing: "Edited." });
    expect(s.tasks[0]).toMatchObject({ sector_id: "B3", state: "searched", pod: 0.6 });
    expect(s.clues[0]?.id).toBe("c001");
    expect(s.events.map((e) => e.type)).toEqual(["proposal.decided", "task.updated", "clue.added"]);
  });
});
