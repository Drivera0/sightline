// The command post's direct actions on the demo store (no API): each changes the mission and logs itself
// as an event, so the timeline and the story's replay both see it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetState, MapBase, Mission, SectorTask, Team } from "../contract";
import { demoFlights, EMPTY, sweep, useMission } from "./mission";
import { ApiError } from "./api";

const AT = "2026-10-24T22:00:00Z";
const team = (id: string, callsign: string, status: Team["status"] = "standby"): Team => ({ id, callsign, members: 3, status, position: { lat: 49.371, lon: -122.947 }, position_at: AT, note: null });
const task = (sector_id: string, state: SectorTask["state"], team_id: string | null = null): SectorTask => ({ sector_id, state, team_id, poa: 0.05, pod: null, note: null, updated_at: AT });
const square: [number, number][] = [[-122.951898, 49.374492], [-122.950898, 49.374492], [-122.950898, 49.373492], [-122.951898, 49.373492], [-122.951898, 49.374492]];
const GRID = { origin_nw: { lat: 49.374492, lon: -122.951898 }, cell_m: 5, rows: 40, cols: 40 };
const mapBase = { contract_version: "1.2", grid: GRID, lkp: { lat: 49.373, lon: -122.95 }, params: {}, prior: { p: new Array(1600).fill(0.5 / 1600), outside: 0.5 }, canopy: new Array(1600).fill(null) } as unknown as MapBase;
const mission = { mission_id: "demo", name: "Demo", area: { name: "x", lkp: { lat: 49.373, lon: -122.95 } }, base_camp: { lat: 49.373, lon: -122.949, name: "Trailhead lot" } } as Mission;
const fleet: FleetState = {
  simulated: true, updated_at: AT, legs: [],
  drones: [{ id: "D1", name: "Drone 1", simulated: true, position: { lat: 49.373, lon: -122.949 }, altitude_m: 50, speed_ms: 8, battery_pct: 90, max_wind_kmh: 40, status: "idle", leg_id: null }],
};

beforeEach(() => {
  sessionStorage.setItem("sightline.operator", "Dana");
  useMission.getState().useDemo(
    { ...EMPTY, mission, mapBase, fleet, teams: [team("T1", "Team One"), team("T2", "Team Two", "searching")], tasks: [task("A1", "proposed"), task("B2", "in_progress", "T2")], sectors: [{ sector_id: "A1", label: "Alpha One", poa: 0.1, drone_coverage: 0, polygon: square }] },
    AT,
  );
});

const last = () => useMission.getState().events.at(-1)!;

describe("direct actions on the demo", () => {
  it("assign: the task and the team move, and the timeline says who did it", async () => {
    await useMission.getState().assign("T1", "A1");
    const s = useMission.getState();
    expect(s.tasks.find((t) => t.sector_id === "A1")).toMatchObject({ state: "assigned", team_id: "T1" });
    expect(s.teams.find((t) => t.id === "T1")?.status).toBe("assigned");
    expect(last()).toMatchObject({ type: "mission.note", summary: "Dana assigned A1 to Team One", at: AT });
  });

  it("call: the call goes out on the radio, and the demo's team answers", async () => {
    await useMission.getState().call("T2", "Team Two, Sightline. Radio check, over.");
    const turns = useMission.getState().events.filter((e) => e.type === "radio.turn").map((e) => e.data as { direction: string; transcript: string });
    expect(turns.map((t) => [t.direction, t.transcript])).toEqual([
      ["out", "Team Two, Sightline. Radio check, over."],
      ["in", "Sightline, Team Two. Copy, over."],
    ]);
  });

  it("recall: the team turns Returning", async () => {
    await useMission.getState().recall("T2");
    expect(useMission.getState().teams.find((t) => t.id === "T2")?.status).toBe("returning");
  });

  it("searched: a ground step at the POD over the sector's own cells", async () => {
    await useMission.getState().searched("A1", 0.6);
    const u = useMission.getState().mapUpdates.at(-1)!;
    expect(u).toMatchObject({ kind: "step", source: "ground", ref: "A1" });
    expect(u.cells.length).toBeGreaterThan(0);
    expect(u.cells.every(([, pod]) => pod === 0.6)).toBe(true);
    expect(useMission.getState().tasks.find((t) => t.sector_id === "A1")).toMatchObject({ state: "searched", pod: 0.6 });
  });

  it("recheck reopens a sector; found ends the search where the team is", async () => {
    await useMission.getState().recheck("B2");
    expect(useMission.getState().tasks.find((t) => t.sector_id === "B2")?.state).toBe("proposed");
    await useMission.getState().found("T2", "B2");
    expect(useMission.getState().mission).toMatchObject({ status: "found", found: { team: "T2", sector: "B2", lat: 49.371, lon: -122.947, at: AT } });
  });

  it("drone leg: an idle drone takes off over the sector from base camp; recall brings it home", async () => {
    const start = vi.fn();
    demoFlights.start = start;
    await useMission.getState().droneLeg("A1");
    const f = useMission.getState().fleet!;
    expect(f.legs.at(-1)).toMatchObject({ id: "L001", drone_id: "D1", sector_id: "A1", status: "flying" });
    expect(f.drones[0]).toMatchObject({ status: "flying", leg_id: "L001" });
    expect(start).toHaveBeenCalledWith("L001");
    await useMission.getState().recallDrone("D1");
    expect(useMission.getState().fleet!.drones[0]).toMatchObject({ status: "idle", leg_id: null, position: { lat: 49.373, lon: -122.949 } });
    expect(useMission.getState().fleet!.legs.at(-1)?.status).toBe("cancelled");
  });

  it("a sweep covers the sector in east-west lines", () => {
    const w = sweep(square, 4);
    expect(w).toHaveLength(8);
    expect(new Set(w.map((p) => p[1])).size).toBe(4);
  });
});

describe("direct actions on a live mission", () => {
  it("call the new endpoints, and fall back to the task and team calls on a server without them", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url.replace("http://api", "")}`);
      if (url.endsWith("/assign")) return new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 });
      return new Response(JSON.stringify({}), { status: 200 });
    });
    useMission.setState({ api: { base: "http://api", fetch: fetch as unknown as typeof globalThis.fetch, token: null }, mission: { ...mission, mission_id: "m1" } });
    await useMission.getState().assign("T1", "A1");
    expect(calls).toEqual(["POST /missions/m1/teams/T1/assign", "POST /missions/m1/tasks/A1", "PATCH /missions/m1/teams/T1"]);
    calls.length = 0;
    await useMission.getState().call("T1", "radio check");
    expect(calls).toEqual(["POST /missions/m1/teams/T1/call"]);
    expect(new ApiError(404, "x").status).toBe(404);
  });
});
