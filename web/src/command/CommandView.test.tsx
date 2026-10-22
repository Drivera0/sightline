// LANE_E §9 tests 2 (task states; POD in (0, 0.9]), the roster, the clue form, the header.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Conditions, Mission, Proposal, SectorTask, Team } from "../contract";
import { clueProblem, CommandView, HINT_KEY, missionStatus, type CommandProps } from "./CommandView";
import { clock, zone } from "../lib/time";

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

  it("header: the planning heuristics say they are heuristics (B-W2)", () => {
    setup({ conditions: { ...conditions, visibility_factor: 0.6, exposure_band: "moderate" } as Conditions });
    const h = screen.getByLabelText("Mission header");
    expect(h).toHaveTextContent("visibility ×0.6 (heuristic)");
    expect(h).toHaveTextContent("exposure moderate (planning heuristic)");
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

  it("selects a team from the roster (the live map flies to it)", async () => {
    setup();
    const { useSelection } = await import("../lib/selection");
    await userEvent.click(within(screen.getByRole("region", { name: "Teams" })).getByRole("button", { name: "Team Two" }));
    expect(useSelection.getState().selectedTeamId).toBe("T2");
    await userEvent.click(within(screen.getByRole("region", { name: "Teams" })).getByRole("button", { name: "Team Two" }));
    expect(useSelection.getState().selectedTeamId).toBeNull();
  });

  it("checks a clue before sending it (test 5)", async () => {
    expect(clueProblem("", "team", "", "", "")).toBe("Say what was found.");
    expect(clueProblem("pack", "latlon", "91", "-122", "")).toMatch(/Latitude/);
    expect(clueProblem("pack", "latlon", "49.3", "", "")).toMatch(/Longitude/);
    expect(clueProblem("pack", "latlon", "49.3", "-122.9", "-5")).toMatch(/radius/);
    expect(clueProblem("pack", "latlon", "49.3", "-122.9", "40")).toBeNull();
    const p = setup();
    await userEvent.click(screen.getByRole("button", { name: "+ Add clue" }));
    await userEvent.type(screen.getByLabelText("What"), "boot print");
    await userEvent.selectOptions(screen.getByLabelText("Where"), "latlon");
    await userEvent.type(screen.getByLabelText("Latitude"), "123");
    await userEvent.type(screen.getByLabelText("Longitude"), "-122.9");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Latitude must be a number from -90 to 90.");
    expect(p.onAddClue).not.toHaveBeenCalled();
    await userEvent.clear(screen.getByLabelText("Latitude"));
    await userEvent.type(screen.getByLabelText("Latitude"), "49.37");
    await userEvent.type(screen.getByLabelText("Radius (m)"), "40");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(p.onAddClue).toHaveBeenCalledWith(expect.objectContaining({ lat: 49.37, lon: -122.9, radius_m: 40 }));
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

  it("says what needs a person in one status line above the map", () => {
    const proposal = (id: string, kind: Proposal["kind"], status: Proposal["status"] = "pending") => ({ id, kind, status }) as Proposal;
    const items = missionStatus(
      [proposal("p1", "drone_leg"), proposal("p2", "alert"), proposal("p3", "assign_sector", "approved")],
      [team("T1", "One", "searching"), team("T2", "Two", "assigned"), team("T3", "Three", "returning"), team("T4", "Four")],
      [task("A1", "in_progress", "T1"), task("B2", "searched", "T2", 0.5)],
      [],
    );
    expect(items.map((i) => i.text).join(" · ")).toBe("2 approvals waiting · next drone leg ready · 3 teams out · 1 sector in progress · 1 searched · 0 clues");
    expect(items[0]!.tone).toBe("action"); // orange: needs a person
    setup({ map: <div>map</div> });
    expect(screen.getByRole("status", { name: "Mission status" })).toHaveTextContent("no approvals waiting");
  });

  it("console: each sector is one line; the row expands to the details", async () => {
    setup({ map: <div>map</div> });
    const b3 = screen.getByRole("group", { name: "Sector B3" });
    expect(b3).toHaveAttribute("title", "Proposed · drone coverage 25%");
    await userEvent.click(within(b3).getByRole("button", { expanded: false }));
    expect(b3).toHaveTextContent("Bravo Three · POA 6.9% · drone coverage 25%");
  });

  it("console, first visit: a hint says where things are, and stays dismissed", async () => {
    localStorage.removeItem(HINT_KEY);
    setup({ map: <div>map</div> });
    const hint = screen.getByRole("complementary", { name: "How to use the console" });
    expect(within(hint).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "→ Approve the agent's proposals on the right",
      "← Assign teams to sectors on the left",
      "↓ Add clues below the map",
    ]);
    expect(screen.getByText("Desktop recommended.")).toBeInTheDocument(); // shown under 1024 px
    await userEvent.click(within(hint).getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("complementary", { name: "How to use the console" })).toBeNull();
    cleanup();
    setup({ map: <div>map</div> });
    expect(screen.queryByRole("complementary", { name: "How to use the console" })).toBeNull();
  });

  it("demo: the header clock tells the fixtures' scripted time, in UTC", () => {
    setup({ status: "demo" });
    expect(screen.getByLabelText("Mission header")).toHaveTextContent("22:00 UTC");
  });

  it("live: the header clock names the browser's zone too, so a bare 03:37 never shows", () => {
    setup({ status: "live" });
    const d = new Date("2026-10-24T22:00:00Z");
    const label = `${clock(d, false)} ${zone(d, false)}`;
    expect(zone(d, false)).not.toBe("");
    expect(screen.getByLabelText("Mission header")).toHaveTextContent(label);
  });

  it("the shortcut overlay lists the console's keys", async () => {
    const { SHORTCUT_GROUPS } = await import("../shell/shortcuts");
    const console_ = SHORTCUT_GROUPS.find((g) => g.title === "Command console");
    expect(console_?.shortcuts.flatMap((s) => s.keys)).toEqual(["Tab", "A", "X", "W", "C"]);
  });

  it('never says "clear"', () => {
    setup();
    expect(document.body.textContent).not.toMatch(/\bclear(s|ed|ing)?\b/i);
  });
});
