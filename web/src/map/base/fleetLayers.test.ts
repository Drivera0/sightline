// The live fleet on the map: drones glide (no overshoot), a re-task animates out, the link ring and
// its words, relay dots along a drone-team link.
import { describe, expect, it } from "vitest";
import type { FleetState, Team } from "../../contract";
import { applyEvent, applyLinkEvent, EMPTY, fleetLinksFromEvents, NO_LINKS, useMission, type FleetLinks } from "../../lib/mission";
import { droneFeatures, droneLinkWords, LINK_WORD } from "./droneLayer";
import { alongPath, easeOut, FleetGlide, GLIDE_MS, metres, RELAY_DOTS, relayDots, type LonLat } from "./fleetMotion";
import { CANCEL_FADE_MS, legFeatures, nearestOnLine, noteCancels, replacementLeg, retaskAnimating, retaskFeatures } from "./legLayer";
import { relayFeatures } from "./relayLayer";

const NOW = new Date("2026-10-24T22:00:00Z");

describe("drones glide between ticks", () => {
  it("eases out to the report over ~400 ms and never overshoots", () => {
    const g = new FleetGlide();
    g.update({ D1: [0, 0] }, 0);
    expect(g.positions(0).D1).toEqual([0, 0]);
    g.update({ D1: [1, 0] }, 1000);
    const xs = [0, 50, 100, 200, 300, 399, 400, 800].map((dt) => g.positions(1000 + dt).D1![0]);
    expect(xs[0]).toBe(0);
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThanOrEqual(xs[i - 1]!);
    expect(Math.max(...xs)).toBeLessThanOrEqual(1);
    expect(xs.at(-1)).toBe(1);
    expect(g.animating(1000 + GLIDE_MS / 2)).toBe(true);
    expect(g.animating(1000 + GLIDE_MS)).toBe(false);
  });

  it("a new report mid-glide continues from where the drone is drawn", () => {
    const g = new FleetGlide();
    g.update({ D1: [0, 0] }, 0);
    g.update({ D1: [1, 0] }, 0);
    const mid = g.positions(200).D1!;
    g.update({ D1: [2, 0] }, 200);
    expect(g.positions(200).D1).toEqual(mid);
  });

  it("reduced motion: drawn at the report at once; gone drones are dropped", () => {
    const g = new FleetGlide();
    g.update({ D1: [0, 0], D2: [5, 5] }, 0);
    g.update({ D1: [1, 1] }, 10, true);
    expect(g.positions(10)).toEqual({ D1: [1, 1] });
  });

  it("ease-out is monotonic from 0 to 1", () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(2)).toBe(1);
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
  });
});

describe("relay dots", () => {
  const path: LonLat[] = [[-122.94, 49.37], [-122.93, 49.37], [-122.93, 49.38]];
  it("travel along the link by length, evenly spaced", () => {
    expect(alongPath(path, 0)).toEqual(path[0]);
    expect(alongPath(path, 1)).toEqual(path[2]);
    const half = alongPath(path, 0.5);
    const total = metres(path[0]!, path[1]!) + metres(path[1]!, path[2]!);
    expect(metres(path[0]!, path[1]!) + metres(path[1]!, half)).toBeCloseTo(total / 2, 0); // past the corner, by length
    const dots = relayDots(path, 0);
    expect(dots).toHaveLength(RELAY_DOTS);
    expect(relayDots(path, 400)).not.toEqual(dots); // they move
    expect(relayDots(path, 400, true)).toEqual(dots); // reduced motion: still
  });
});

const fleet = {
  simulated: true,
  updated_at: "2026-10-24T21:59:00Z",
  drones: [
    { id: "D1", name: "Drone 1", simulated: true, position: { lat: 49.37, lon: -122.94 }, battery_pct: 80, status: "flying" },
    { id: "D2", name: "Drone 2", simulated: true, position: { lat: 49.371, lon: -122.941 }, battery_pct: 70, status: "flying" },
    { id: "D3", name: "Drone 3", simulated: true, position: { lat: 49.372, lon: -122.942 }, battery_pct: 60, status: "flying" },
  ],
  legs: [
    { id: "L1", drone_id: "D1", status: "cancelled", waypoints: [[-122.95, 49.37], [-122.93, 49.37]] },
    { id: "L2", drone_id: "D1", status: "flying", waypoints: [[-122.94, 49.36], [-122.93, 49.36]] },
    { id: "L3", drone_id: "D3", status: "cancelled", waypoints: [[-122.95, 49.38], [-122.93, 49.38]] },
  ],
} as unknown as FleetState;

describe("drone link ring", () => {
  it("says the link in words, with how long ago a lost drone was heard", () => {
    const links: FleetLinks["drones"] = {
      D2: { link: "degraded", since: "2026-10-24T21:58:00Z", last_heard_at: null },
      D3: { link: "lost", since: "2026-10-24T21:58:00Z", last_heard_at: "2026-10-24T21:58:00Z" },
    };
    const fs = droneFeatures(fleet, links, NOW);
    expect(fs.map((f) => f.properties.link)).toEqual(["connected", "degraded", "lost"]);
    expect(fs[0]!.properties.label).toBe("Drone 1 (simulated) · 80 %");
    expect(fs[1]!.properties.label).toBe("Drone 2 (simulated) · 70 % · link degraded");
    expect(fs[2]!.properties.label).toBe("Drone 3 (simulated) · 60 % · link lost, last heard 2 min ago");
    expect(fs[2]!.properties.popup).toContain("link lost, last heard 2 min ago (simulated link model)");
    expect(Object.values(LINK_WORD)).toEqual(["link ok", "link degraded", "link lost"]);
  });

  it("draws only the short id and battery on the map, and marks a simulated drone", () => {
    const fs = droneFeatures(fleet, {}, NOW);
    expect(fs.map((f) => [f.properties.short, f.properties.battery, f.properties.sim])).toEqual([
      ["D1", "80%", true],
      ["D2", "70%", true],
      ["D3", "60%", true],
    ]);
    expect(droneLinkWords(undefined, NOW)).toBe("");
    expect(droneLinkWords({ link: "lost", since: "2026-10-24T21:55:00Z", last_heard_at: "2026-10-24T21:55:00Z" }, NOW)).toBe("link lost, last heard 5 min ago");
  });
});

describe("a re-task animates out", () => {
  it("the cancelled leg fades over CANCEL_FADE_MS; a dashed trail runs to the new leg", () => {
    const seen = noteCancels(fleet, {}, 1000, { D1: [-122.94, 49.37] });
    expect(seen.L1!.at).toEqual([-122.94, 49.37]); // where the drone was drawn when it turned
    expect(replacementLeg(fleet, fleet.legs[0]!)?.id).toBe("L2");
    const at = (t: number) => retaskFeatures(fleet, seen, t).map((f) => [f.properties.id, f.properties.style, f.properties.fade]);
    expect(at(1000)).toEqual([["L1", "cancelled", 1], ["L1>L2", "diverted", 1], ["L3", "cancelled", 1]]);
    expect(at(1000 + CANCEL_FADE_MS / 2)[0]).toEqual(["L1", "cancelled", 0.5]);
    expect(at(1000 + CANCEL_FADE_MS)).toEqual([["L1>L2", "diverted", 1]]); // L3 has no new leg: gone
    const trail = retaskFeatures(fleet, seen, 1000).find((f) => f.properties.style === "diverted")!;
    expect(trail.geometry.coordinates).toEqual([[-122.94, 49.37], [-122.94, 49.36]]);
    expect(retaskAnimating(seen, 1000 + CANCEL_FADE_MS - 1)).toBe(true);
    expect(retaskAnimating(seen, 1000 + CANCEL_FADE_MS)).toBe(false);
    expect(legFeatures(fleet).map((f) => f.properties.id)).toEqual(["L2"]); // the steady legs are unchanged
  });

  it("on a fresh page the diversion point is on the old leg, nearest the drone", () => {
    const seen = noteCancels(fleet, {}, 0, { D1: [-122.94, 49.365] }, true);
    expect(seen.L1!.at[0]).toBeCloseTo(-122.94);
    expect(seen.L1!.at[1]).toBeCloseTo(49.37);
    expect(nearestOnLine([[0, 0], [10, 0]], [3, 4])).toEqual([3, 0]);
    expect(noteCancels(fleet, seen, 5000, {})).toEqual(seen); // seen once
  });
});

describe("relay for a cut-off team", () => {
  const teams = [{ id: "T2", callsign: "Team Two" }] as Team[];
  const relay = { team_id: "T2", callsign: "Team Two", via: ["D3"], hops: 1, heard_at: "2026-10-24T21:59:20Z", age_s: 40, lat: 49.373, lon: -122.936 };
  const ev = (id: string, data: Record<string, unknown>) => ({ id, type: "mission.note" as const, at: "2026-10-24T21:59:00Z", summary: "", ref: null, data });

  it("links come from the sim's mission.note events", () => {
    let links = applyLinkEvent(NO_LINKS, ev("e1", { fleet_link: { target: "T2", link: "no_signal" } }));
    links = applyLinkEvent(links, ev("e2", { relay }));
    links = applyLinkEvent(links, ev("e3", { fleet_link_request: { target: "D2", link: "lost" } })); // only asked
    links = applyLinkEvent(links, ev("e4", { fleet_link: { target: "D2", link: "lost", last_heard_at: "2026-10-24T21:58:00Z" } }));
    expect(links.teams.T2).toMatchObject({ link: "no_signal", relay: { via: ["D3"] } });
    expect(links.drones).toEqual({ D2: { link: "lost", since: "2026-10-24T21:59:00Z", last_heard_at: "2026-10-24T21:58:00Z", for_s: null, by: null } });
    expect(fleetLinksFromEvents([ev("e1", { fleet_link: { target: "T2", link: "no_signal" } }), ev("e2", { relay })])).toEqual({
      drones: {},
      teams: { T2: { link: "no_signal", since: "2026-10-24T21:59:00Z", relay } },
    });
  });

  it("draws the link from the team through the drones and its dots, only while the team has no signal", () => {
    const links: FleetLinks = { drones: {}, teams: { T2: { link: "no_signal", relay } } };
    const fs = relayFeatures(links, teams, { D3: [-122.942, 49.372] }, 0);
    expect(fs[0]!.properties).toMatchObject({ kind: "relay", label: "Team Two relayed via D3 (simulated)" });
    expect(fs[0]!.geometry.coordinates).toEqual([[-122.936, 49.373], [-122.942, 49.372]]);
    expect(fs.filter((f) => f.properties.kind === "relay-dot")).toHaveLength(RELAY_DOTS);
    expect(relayFeatures({ drones: {}, teams: { T2: { link: "connected", relay } } }, teams, { D3: [0, 0] }, 0)).toEqual([]);
    expect(relayFeatures(links, teams, {}, 0)).toEqual([]); // the drone isn't on the map
  });

  it("the mission store keeps them: applyEvent, and the demo reads them from its events", () => {
    const s = applyEvent(EMPTY, ev("e9", { fleet_link: { target: "D2", link: "degraded" } }));
    expect(s.links.drones.D2?.link).toBe("degraded");
    useMission.getState().useDemo({ events: [ev("e1", { fleet_link: { target: "T2", link: "no_signal" } }), ev("e2", { relay })] });
    expect(useMission.getState().links.teams.T2?.relay?.via).toEqual(["D3"]);
  });

  it("never says clear", () => {
    const all = JSON.stringify([droneFeatures(fleet, {}, NOW), retaskFeatures(fleet, noteCancels(fleet, {}, 0, {}), 0)]);
    expect(all).not.toMatch(/\bclear(s|ed|ing)?\b/i);
  });
});

describe("the demo mission's fleet (scripts/make_fleet_fixture.py)", () => {
  it("has three simulated drones, a re-task, a lost and a degraded link, and a relayed team", async () => {
    const fx = (await import("../../command/__fixtures__/demo_mission.json")).default as unknown as {
      fleet: FleetState;
      events: Parameters<typeof fleetLinksFromEvents>[0];
    };
    expect(fx.fleet.simulated).toBe(true);
    expect(fx.fleet.drones.map((d) => d.id)).toEqual(["D1", "D2", "D3"]);
    const cancelled = fx.fleet.legs.find((l) => l.status === "cancelled")!;
    expect(replacementLeg(fx.fleet, cancelled)?.drone_id).toBe(cancelled.drone_id);
    const links = fleetLinksFromEvents(fx.events);
    expect(Object.values(links.drones).map((l) => l.link).sort()).toEqual(["degraded", "lost"]);
    expect(links.teams.T2?.link).toBe("no_signal");
    expect(links.teams.T2?.relay?.via.length).toBeGreaterThan(0);
  });
});
