// LANE_E §9 tests 2 (task states; POD in (0, 0.9]), the roster, the clue form, the header.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Conditions, Mission, SectorTask, Team } from "../contract";
import { CommandView, type CommandProps } from "./CommandView";

const NOW = new Date("2026-10-24T22:00:00Z");
const task = (sector_id: string, state: SectorTask["state"], team_id: string | null = null, pod: number | null = null): SectorTask => ({
  sector_id, state, team_id, poa: 0.05, pod, note: null, updated_at: "2026-10-24T21:20:00Z",
});
const team = (id: string, callsign: string, status: Team["status"] = "standby"): Team => ({ id, callsign, members: 3, status, position: null, position_at: null, note: null });
const mission = { mission_id: "a1b2c3d4", name: "Seymour — missing hiker" } as Mission;
const conditions = {
  fetched_at: "2026-10-24T21:50:00Z", wind_kmh: 18, gust_kmh: 30, precip_mm_h: 0.4, civil_twilight_end: "2026-10-25T00:40:00Z",
  flyable: true, flyable_until: "2026-10-25T00:40:00Z", flyability_reason: "", alerts: [{ kind: "closure", title: "Lower Seymour trail closed", text: "", url: "" }],
} as unknown as Conditions;

function setup(over: Partial<CommandProps> = {}) {
  const props: CommandProps = {
    mission, status: "live", conditions, imageUrl: (r) => r, proposals: [], clues: [],
    tasks: [task("B3", "proposed"), task("C2", "assigned", "T2"), task("A1", "in_progress", "T3"), task("D4", "searched", "T4", 0.6)],
    sectors: [{ sector_id: "B3", label: "Bravo Three", poa: 0.069, drone_coverage: 0.25 }],
    teams: [team("T1", "Team One"), team("T2", "Team Two", "assigned"), team("T3", "Team Three", "searching"), team("T4", "Team Four")],
    onSetTask: vi.fn(), onUpdateTeam: vi.fn(), onAddClue: vi.fn(), onDecide: vi.fn(), now: () => NOW, ...over,
  };
  render(<CommandView {...props} />);
  return props;
}

describe("CommandView", () => {
  it("shows each sector's state in words, with the live POA and coverage", () => {
    setup();
    const b3 = screen.getByLabelText("Sector B3");
    expect(b3).toHaveTextContent("Bravo Three");
    expect(b3).toHaveTextContent("6.9%");
    expect(b3).toHaveTextContent("drone coverage 25%");
    expect(screen.getByLabelText("Sector C2")).toHaveTextContent("Assigned to Team Two");
    expect(screen.getByLabelText("Sector A1")).toHaveTextContent("In progress · Team Three · 40 min");
    expect(screen.getByLabelText("Sector D4")).toHaveTextContent("Searched at POD 60%");
  });

  it("assigns a standby team, starts, and marks searched with a POD of at most 90%", async () => {
    const p = setup();
    await userEvent.click(within(screen.getByLabelText("Sector B3")).getByRole("button", { name: "Assign team…" }));
    await userEvent.click(within(screen.getByLabelText("Sector B3")).getByRole("button", { name: "Team One" }));
    expect(p.onSetTask).toHaveBeenCalledWith("B3", { state: "assigned", team_id: "T1" });
    expect(p.onUpdateTeam).toHaveBeenCalledWith("T1", { status: "assigned" });
    await userEvent.click(within(screen.getByLabelText("Sector C2")).getByRole("button", { name: "Start" }));
    expect(p.onSetTask).toHaveBeenCalledWith("C2", { state: "in_progress", team_id: "T2" });
    await userEvent.click(within(screen.getByLabelText("Sector A1")).getByRole("button", { name: "Mark searched…" }));
    const entry = screen.getByLabelText("POD entry");
    expect(within(entry).getByLabelText("POD")).toHaveAttribute("max", "0.9"); // never 100%
    expect(entry).toHaveTextContent("it never removes it");
    await userEvent.click(within(entry).getByRole("button", { name: "High 70%" }));
    expect(p.onSetTask).toHaveBeenCalledWith("A1", { state: "searched", team_id: "T3", pod: 0.7, note: null });
    await userEvent.click(within(screen.getByLabelText("Sector D4")).getByRole("button", { name: "Reopen" }));
    expect(p.onSetTask).toHaveBeenCalledWith("D4", { state: "proposed", team_id: null });
  });

  it("header: conditions in words, with the alert", () => {
    setup();
    const h = screen.getByLabelText("Mission header");
    expect(h).toHaveTextContent("wind 18 km/h, gusts 30");
    expect(h).toHaveTextContent("daylight 2 h 40 m");
    expect(h).toHaveTextContent("Lower Seymour trail closed");
  });

  it("adds a clue at a team's position", async () => {
    const p = setup();
    await userEvent.click(screen.getByRole("button", { name: "+ Add clue" }));
    await userEvent.type(screen.getByLabelText("What"), "blue backpack by the creek");
    await userEvent.selectOptions(screen.getByLabelText("Team"), "T2");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(p.onAddClue).toHaveBeenCalledWith(expect.objectContaining({ kind: "object", text: "blue backpack by the creek", at_team_position: true, reported_by: "T2", source: "form" }));
  });

  it("fills the clue's lat/lon from a pick on the map (B-M3)", async () => {
    const p = setup({ onPickOnMap: vi.fn().mockResolvedValue({ lat: 49.3731234, lon: -122.9357654 }) });
    await userEvent.click(screen.getByRole("button", { name: "+ Add clue" }));
    await userEvent.type(screen.getByLabelText("What"), "boot print");
    await userEvent.selectOptions(screen.getByLabelText("Where"), "latlon");
    await userEvent.click(screen.getByRole("button", { name: "Pick on map" }));
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(p.onAddClue).toHaveBeenCalledWith(expect.objectContaining({ lat: 49.373123, lon: -122.935765, at_team_position: false, reported_by: "command" }));
  });

  it("links each assigned or in-progress sector to its assignment card (E-09)", () => {
    setup({ tasks: [task("B3", "assigned"), task("C2", "in_progress"), task("A1", "proposed")], cardHref: (s) => `#card/${s}` });
    expect(screen.getAllByRole("link", { name: "Card" }).map((a) => a.getAttribute("href"))).toEqual(["#card/B3", "#card/C2"]);
  });

  it("shows the five likeliest unassigned sectors, the rest on request", async () => {
    const tasks = Array.from({ length: 13 }, (_, i) => task(`X${i}`, "proposed"));
    const sectors = tasks.map((t, i) => ({ sector_id: t.sector_id, label: t.sector_id, poa: 0.01 * (i + 1), drone_coverage: 0 }));
    setup({ tasks, sectors });
    const col = screen.getByLabelText("Proposed");
    expect(within(col).getAllByLabelText(/^Sector X/).map((c) => c.getAttribute("aria-label"))).toEqual(["Sector X12", "Sector X11", "Sector X10", "Sector X9", "Sector X8"]);
    expect(col).toHaveTextContent("Proposed (13)");
    await userEvent.click(within(col).getByRole("button", { name: "Show 8 more" }));
    expect(within(col).getAllByLabelText(/^Sector X/)).toHaveLength(13);
  });

  it('never says "clear"', () => {
    setup();
    expect(document.body.textContent).not.toMatch(/\bclear(ed)?\b/i);
  });
});
