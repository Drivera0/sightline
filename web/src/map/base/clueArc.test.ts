// A sound heard on a bearing draws as an arc (contract 15.7), tested on the overdue hiker's whistle.
import { describe, expect, it } from "vitest";
import type { Clue, Team } from "../../contract";
import fixture from "../../command/__fixtures__/scenarios/overdue-hiker.json";
import { bearingArc, bearingOf, bearingOrigin, clueArcFeatures, clueFeatures, destination } from "./clueLayer";
import { flashFeatures } from "../heat/clueFlash";

const clues = fixture.clues as unknown as Clue[];
const teams = fixture.teams as unknown as Team[];
const whistle = clues.find((c) => c.kind === "sound" && c.bearing_deg != null)!;

/** Metres and compass bearing from a to b (flat, as the server's _clue_cells measures them). */
function polar(a: { lat: number; lon: number }, b: [number, number]) {
  const dn = (b[1] - a.lat) * 110_540;
  const de = (b[0] - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return { m: Math.hypot(de, dn), deg: (((Math.atan2(de, dn) * 180) / Math.PI) + 360) % 360 };
}

describe("bearing clues on the map", () => {
  it("the fixture's whistle is a bearing heard by a team", () => {
    expect(whistle).toBeDefined();
    expect(bearingOf(whistle)).toEqual({ bearing: whistle.bearing_deg, spread: whistle.bearing_spread_deg, range: whistle.range_m, radius: whistle.radius_m });
    expect(bearingOrigin(whistle, teams)).toEqual(whistle.origin);
  });

  it("draws one arc, from the team's position, within the spread and range ± radius", () => {
    const arcs = clueArcFeatures(clues, teams, (id) => teams.find((t) => t.id === id)?.callsign ?? id);
    expect(arcs.map((a) => a.properties.id)).toEqual([whistle.id]);
    const ring = arcs[0]!.geometry.coordinates[0]!;
    expect(ring[0]).toEqual(ring.at(-1));
    const b = bearingOf(whistle)!;
    for (const pt of ring) {
      const { m, deg } = polar(whistle.origin!, pt as [number, number]);
      if (m < 1) continue; // the wedge's tip: the team's own position (range − radius is 0 here)
      const off = ((deg - b.bearing + 540) % 360) - 180;
      expect(Math.abs(off)).toBeLessThanOrEqual(b.spread + 0.5);
      expect(m).toBeLessThanOrEqual((b.range + b.radius) * 1.01);
    }
    expect(arcs[0]!.properties.label).toBe(
      `Sound: ${whistle.text}\nheard by Team One · bearing ${Math.round(b.bearing)}° ±${b.spread}°, ${Math.round(b.range)} m ±${Math.round(b.radius)} m`,
    );
  });

  it("an arc with an inner edge when the range is more than its uncertainty", () => {
    const o = { lat: 49.37, lon: -122.95 };
    const ring = bearingArc(o, 223, 20, 250, 100, 8).coordinates[0]!;
    const dists = ring.map((p) => polar(o, p as [number, number]).m);
    expect(Math.min(...dists)).toBeGreaterThan(140);
    expect(Math.max(...dists)).toBeLessThan(360);
    expect(polar(o, destination(o, 223, 250)).deg).toBeCloseTo(223, 0);
  });

  it("falls back to the reporting team's position, and skips a clue nobody can place", () => {
    const c = { ...whistle, origin: null } as Clue;
    expect(bearingOrigin(c, teams)).toEqual(teams.find((t) => t.id === whistle.reported_by)!.position);
    expect(clueArcFeatures([c], [])).toEqual([]);
  });

  it("the pin's popup and the flash say the bearing too", () => {
    const pin = clueFeatures([whistle]).find((f) => f.properties.id === whistle.id)!;
    expect(pin.properties.popup).toContain(`bearing ${Math.round(whistle.bearing_deg!)}°`);
    const base = { grid: { origin_lat: 49.36, origin_lon: -122.96, cell_m: 25, rows: 2, cols: 2 } } as never;
    const [shape] = flashFeatures(base, [whistle], []);
    expect(shape!.geometry.coordinates[0]!.length).toBeGreaterThan(30);
  });
});
