// The demo's fleet controls: degrade and restore a drone's link, set gusts as a labelled demo override, go back
// to the real conditions; never for a real fleet.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Conditions, Drone, FleetState } from "../contract";
import type { Api } from "../lib/api";
import { NO_LINKS, type FleetLinks } from "../lib/mission";
import { MissionHeader } from "./CommandView";
import { conditionsFacts } from "./conditions";
import { ConditionsPanel } from "./ConditionsPanel";
import { FleetControls } from "./FleetControls";

const drone = (id: string): Drone => ({ id, name: `Drone ${id.slice(1)}`, simulated: true, position: null, altitude_m: 50, speed_ms: 8,
  battery_pct: 90, max_wind_kmh: 43.2, status: "flying", leg_id: null });
const FLEET: FleetState = { simulated: true, drones: [drone("D1"), drone("D2"), drone("D3")], legs: [], updated_at: "2026-10-22T09:00:00Z" };
const OVERRIDE = {
  fetched_at: "2026-10-22T09:24:00Z", stale: false, area: "Mount Seymour", sources: ["override (demo)"], wind_kmh: null, gust_kmh: 50,
  wind_dir_deg: null, precip_mm_h: null, precip_prob: null, temp_c: null, visibility_km: null, sunset: null, civil_twilight_end: null,
  alerts: [], flyable: false, flyable_until: null, flyability_reason: "override (demo): gusts 50 km/h at or above the drones' limit of 43 km/h",
  visibility_factor: 1, exposure_band: null, exposure_note: "override (demo): no exposure estimate",
} as Conditions;

function setup(over: { fleet?: FleetState | null; links?: FleetLinks; conditions?: Conditions | null } = {}) {
  const fetch = vi.fn(async (..._: unknown[]) => new Response(JSON.stringify({}), { status: 200 }));
  const api: Api = { base: "http://api", fetch: fetch as unknown as typeof globalThis.fetch, token: null };
  render(<FleetControls api={api} missionId="m1" fleet={over.fleet === undefined ? FLEET : over.fleet} links={over.links ?? NO_LINKS} conditions={over.conditions ?? null} />);
  const calls = () => fetch.mock.calls.map(([url, init]) => [url, (init as RequestInit).method, JSON.parse(String((init as RequestInit).body ?? "null"))]);
  return calls;
}

describe("FleetControls", () => {
  it("degrades D2's link and sets gusts as a labelled demo override", async () => {
    const calls = setup();
    const strip = screen.getByLabelText("Fleet controls");
    expect(within(strip).getByText("Demo only")).toBeInTheDocument();
    await userEvent.click(within(strip).getByRole("button", { name: "Degrade link D2" }));
    await userEvent.click(within(strip).getByRole("button", { name: "Set gusts 50 km/h (demo override)" }));
    expect(calls()).toEqual([
      ["http://api/missions/m1/fleet/link", "POST", { target: "D2", link: "degraded", by: "command (demo controls)" }],
      ["http://api/missions/m1/conditions/override", "POST", { gust_kmh: 50, by: "command (demo controls)" }],
    ]);
    expect(within(strip).getByRole("status")).toHaveTextContent("gusts 50 km/h set (demo override)");
  });

  it("restores a degraded link and goes back to the real conditions after an override", async () => {
    const links: FleetLinks = { drones: { D2: { link: "degraded", since: null, last_heard_at: null } }, teams: {} };
    const calls = setup({ links, conditions: OVERRIDE });
    await userEvent.click(screen.getByRole("button", { name: "Restore D2" }));
    await userEvent.click(screen.getByRole("button", { name: "Back to the real conditions" }));
    expect(calls().map((c) => c[0])).toEqual(["http://api/missions/m1/fleet/link", "http://api/missions/m1/conditions/refresh"]);
    expect(calls()[0]![2]).toMatchObject({ link: "connected" });
  });

  it("is not there for a real fleet", () => {
    setup({ fleet: { ...FLEET, simulated: false } });
    expect(screen.queryByLabelText("Fleet controls")).toBeNull();
  });
});

describe("a demo override on screen", () => {
  it("is labelled in the header and the Conditions panel, with no Tavily quotes", () => {
    render(<MissionHeader mission={null} status="live" conditions={OVERRIDE} now={new Date("2026-10-22T09:25:00Z")} />);
    expect(screen.getByText("Demo override")).toBeInTheDocument();
    expect(screen.getByText(/gusts 50 km\/h · not flyable/)).toBeInTheDocument();
    const lookup = { searches: [], extracted: [], documents: [], fields: { gust_kmh: { value: 40, quote: "gusts 40", url: null } }, alertQuotes: [], model: null, ms: null, tokensIn: null, at: null };
    const gust = conditionsFacts(OVERRIDE, lookup).find((f) => f.id === "gust_kmh")!;
    expect(gust.source).toEqual({ kind: "computed", how: "override (demo): set by hand, not from Tavily" }); // never the old quote
    render(<ConditionsPanel id="c" data={{ conditions: OVERRIDE, lookup, recorded: null, limitKmh: 43.2, drone: "Drone 1" }} now={new Date("2026-10-22T09:25:00Z")} time={(i) => i} />);
    expect(screen.getByText("Demo override: not from Tavily")).toBeInTheDocument();
    expect(screen.queryByText("gusts 40")).toBeNull();
    expect(document.body.textContent).not.toMatch(/\bclear(s|ed|ing)?\b/i);
  });
});
