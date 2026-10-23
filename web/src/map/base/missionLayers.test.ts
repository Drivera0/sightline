// LANE_B §6 test 8: the live-mission layers from a mission (clues, teams, drones, legs).
import { describe, expect, it } from "vitest";
import type { Clue, FleetState, Proposal, Team } from "../../contract";
import { clueFeatures } from "./clueLayer";
import { droneFeatures } from "./droneLayer";
import { legFeatures } from "./legLayer";
import { teamFeatures, teamShort } from "./teamLayer";

const NOW = new Date("2026-10-24T22:00:00Z");
const ring = [[0, 0], [1, 1]];

describe("live-mission layers", () => {
  it("clue pins: colour per kind, and a popup that says how it came in", () => {
    const c = { id: "c003", kind: "object", text: "blue bottle", lat: 1, lon: 2, radius_m: 30, reliability: "high", reported_by: "T2", source: "radio", at: "2026-10-24T21:24:00Z" } as Clue;
    const [f] = clueFeatures([c], (id) => (id === "T2" ? "Team Two" : id));
    expect(f!.properties).toMatchObject({ kind: "clue", id: "c003", label: "c003 object", tone: "clue" });
    expect(f!.properties.popup).toBe("blue bottle\nobject · high reliability · within 30 m\nby radio · Team Two · 21:24");
  });

  it("teams: status word, colour and position age; none without a position", () => {
    const teams = [
      { id: "T1", callsign: "Team One", status: "searching", position: { lat: 1, lon: 2 }, position_at: "2026-10-24T21:48:00Z" },
      { id: "T2", callsign: "Team Two", status: "standby", position: null, position_at: null },
    ] as Team[];
    const fs = teamFeatures(teams, NOW);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.properties).toMatchObject({ label: "Team One · searching · 12 min ago", tone: "team", short: "T1" });
  });

  it("teams: a short id for the map, the full line kept for the tooltip", () => {
    expect(teamShort({ id: "T3", callsign: "Team Three" })).toBe("T3");
    expect(teamShort({ id: "alpha", callsign: "Team Three" })).toBe("T3");
    expect(teamShort({ id: "k9", callsign: "Team 12" })).toBe("T12");
    expect(teamShort({ id: "K9", callsign: "Dog unit" })).toBe("K9");
  });

  it("drones: simulated badge and battery, low battery in the warning colour", () => {
    const fleet = { drones: [
      { id: "D1", name: "Drone 1", simulated: true, position: { lat: 1, lon: 2 }, battery_pct: 76.4 },
      { id: "D2", name: "Drone 2", simulated: false, position: { lat: 1, lon: 2 }, battery_pct: 18 },
      { id: "D3", name: "Drone 3", simulated: true, position: null, battery_pct: 100 },
    ], legs: [] } as unknown as FleetState;
    expect(droneFeatures(fleet).map((f) => [f.properties.label, f.properties.tone])).toEqual([
      ["Drone 1 (simulated) · 76 %", "drone"],
      ["Drone 2 · 18 %", "warn"],
    ]);
  });

  it("legs: flown and cut-short ones past (20 %), proposed and approved dashed, the flying one solid", () => {
    const fleet = { drones: [], legs: [
      { id: "L1", status: "flying", waypoints: ring }, { id: "L2", status: "done", waypoints: ring },
      { id: "L3", status: "approved", waypoints: ring }, { id: "L4", status: "cancelled", waypoints: ring },
    ] } as unknown as FleetState;
    const proposals = [{ status: "pending", leg: { id: "L5", waypoints: ring } }, { status: "rejected", leg: { id: "L6", waypoints: ring } }] as unknown as Proposal[];
    expect(legFeatures(fleet, proposals).map((f) => [f.properties.id, f.properties.style])).toEqual([
      ["L2", "past"], ["L4", "past"], ["L5", "proposed"], ["L1", "flying"], ["L3", "approved"],
    ]);
  });

  it("never says clear", () => {
    const all = JSON.stringify([clueFeatures([]), teamFeatures([], NOW), droneFeatures(null), legFeatures(null)]);
    expect(all).not.toMatch(/\bclear(s|ed|ing)?\b/i);
  });
});
