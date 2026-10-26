// The command post console (COMMAND_POST.md §5): the four regions, the T-cards, Needs you, the timeline and
// its talk bar, the sector popover (LANE_E §9 test 2: POD in (0, 0.9]), the clue form (test 5), the status line.
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Clue, Conditions, Mission, MissionEvent, Proposal, SectorTask, Team } from "../contract";
import { NO_LINKS } from "../lib/mission";
import { CommandView, type CommandProps, type ConsoleActions } from "./CommandView";
import { useConsole } from "./consoleStore";
import { StatusLine } from "./StatusLine";
import { clueProblem } from "./Timeline";

const NOW = new Date("2026-10-24T22:00:00Z");
const task = (sector_id: string, state: SectorTask["state"], team_id: string | null = null, pod: number | null = null): SectorTask => ({
  sector_id, state, team_id, poa: 0.05, pod, note: null, updated_at: "2026-10-24T21:20:00Z",
});
const team = (id: string, callsign: string, status: Team["status"] = "standby", heard: string | null = null): Team => ({
  id, callsign, members: 3, status, position: null, position_at: null, note: null, last_heard_at: heard,
});
const mission = { mission_id: "a1b2c3d4", name: "Seymour — missing hiker", created_at: "2026-10-24T20:30:00Z", check_in_min: 30, base_camp: { lat: 49.373, lon: -122.949, name: "Trailhead lot" }, area: { name: "Seymour", lkp: { lat: 49.37, lon: -122.945 } } } as Mission;
const conditions = {
  fetched_at: "2026-10-24T21:50:00Z", wind_kmh: 18, gust_kmh: 30, precip_mm_h: 0.4, civil_twilight_end: "2026-10-25T00:40:00Z",
  flyable: true, flyable_until: "2026-10-25T00:40:00Z", flyability_reason: "gusts under the limit", alerts: [{ kind: "closure", title: "Lower Seymour trail closed", text: "", url: "" }],
} as unknown as Conditions;
const square = (w: number, s: number): [number, number][] => [[w, s + 0.002], [w + 0.003, s + 0.002], [w + 0.003, s], [w, s], [w, s + 0.002]];
const radio = (id: string, callsign: string, text: string, at: string): MissionEvent => ({
  id, type: "radio.turn", at, summary: text, ref: id,
  data: { id, direction: "in", callsign, transcript: text, reply: `${callsign}, Sightline. Copy.`, audio: null, state: "committed", actions: [], asr_ms: null, llm_ms: null, tts_ms: null, at },
});
const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: "p003", kind: "assign_sector", summary: "Assign sector C2 to Team One", reason: "C2 holds 5.5 % of the probability.", briefing: null,
  target: { team: "T1", sector: "C2" }, evidence: [], status: "pending", created_by: "planner", created_at: "2026-10-24T21:42:00Z",
  decided_at: null, decided_by: null, decision_reason: null, edits: null, ...over,
});

function actions(): ConsoleActions {
  return { assign: vi.fn(), droneLeg: vi.fn(), searched: vi.fn(), recheck: vi.fn(), found: vi.fn(), call: vi.fn(), recall: vi.fn(), recallDrone: vi.fn(), confirmClue: vi.fn() };
}

function setup(over: Partial<CommandProps> = {}) {
  const props: CommandProps = {
    mission, status: "live", conditions, imageUrl: (r) => r, proposals: [], clues: [], events: [], fleet: null, links: NO_LINKS,
    tasks: [task("B3", "proposed"), task("C2", "assigned", "T2"), task("A1", "in_progress", "T3"), task("D4", "searched", "T4", 0.6)],
    sectors: [
      { sector_id: "B3", label: "Bravo Three", poa: 0.069, drone_coverage: 0.25, polygon: square(-122.95, 49.37) },
      { sector_id: "C2", label: "Charlie Two", poa: 0.055, drone_coverage: 0, polygon: square(-122.947, 49.37) },
      { sector_id: "D4", label: "Delta Four", poa: 0.012, drone_coverage: 0, polygon: square(-122.944, 49.37) },
    ],
    teams: [team("T1", "Team One", "standby", "2026-10-24T21:58:00Z"), team("T2", "Team Two", "assigned", "2026-10-24T21:50:00Z"), team("T3", "Team Three", "searching", "2026-10-24T21:20:00Z"), team("T4", "Team Four", "standby", "2026-10-24T21:56:00Z")],
    actions: actions(), onAddClue: vi.fn(), onDecide: vi.fn(), now: () => NOW, map: <div>the map</div>, review: null, reviewCount: 0, ...over,
  };
  render(<CommandView {...props} />);
  return props;
}

beforeEach(() => useConsole.getState().reset());

describe("the command post", () => {
  it("has the four regions: resources, the map, Needs you and the timeline with its talk bar", () => {
    setup();
    const view = screen.getByLabelText("Command view");
    for (const name of ["Resources", "Needs you", "Timeline"]) expect(within(view).getByRole("region", { name })).toBeInTheDocument();
    expect(view).toHaveTextContent("the map");
    expect(within(view).getByRole("form", { name: "Talk" })).toBeInTheDocument();
    // what was cut: the task board as a list, the KPI sentence, the clue log panel, "You are"
    expect(screen.queryByLabelText("Task board")).toBeNull();
    expect(screen.queryByLabelText("Clue log")).toBeNull();
    expect(screen.queryByLabelText("Your name")).toBeNull();
    expect(view).not.toHaveTextContent(/approvals waiting ·/);
  });

  it("T-cards: heard N min from the last radio turn or check-in, a stable order (out, then free; the roster order), past the check-in a red badge", () => {
    setup();
    const cards = within(screen.getByRole("region", { name: "Resources" })).getAllByRole("article");
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual(["Team Team Two", "Team Team Three", "Team Team One", "Team Team Four"]);
    expect(cards[1]).toHaveTextContent("Overdue · not heard 40 min");
    expect(cards[1]).toHaveAttribute("data-overdue", "true");
    expect(cards[1]).toHaveTextContent("A1");
    expect(cards[2]).toHaveTextContent("at base camp"); // standby at base: no check-in to keep
    expect(cards[0]).toHaveTextContent(/heard \d+ min/);
  });

  it("T-cards: Call addresses the talk bar to the team, Task picks a sector, Recall goes through", async () => {
    const p = setup();
    const one = screen.getByRole("article", { name: "Team Team Two" });
    await userEvent.click(within(one).getByRole("button", { name: "Call" }));
    expect(useConsole.getState().talkTo).toBe("T2");
    expect(screen.getByLabelText("Message")).toHaveValue("Team Two, Sightline. ");
    expect(screen.getByLabelText("Recipient")).toHaveValue("T2");
    await userEvent.click(within(one).getByRole("button", { name: "Reassign…" }));
    expect(useConsole.getState().picking).toEqual({ kind: "team", id: "T2" });
    expect(screen.getByRole("status")).toHaveTextContent("Click a sector for Team Two");
    await userEvent.click(within(one).getByRole("button", { name: "Recall" }));
    expect(p.actions.recall).toHaveBeenCalledWith("T2");
  });

  it("selects a team from its card (the live map flies to it)", async () => {
    setup();
    const { useSelection } = await import("../lib/selection");
    const card = screen.getByRole("article", { name: "Team Team Two" });
    await userEvent.click(within(card).getByRole("button", { name: "Team Two" }));
    expect(useSelection.getState().selectedTeamId).toBe("T2");
    await userEvent.click(within(card).getByRole("button", { name: "Team Two" }));
    expect(useSelection.getState().selectedTeamId).toBeNull();
  });

  it("drone cards: battery, link and leg n/m; Task and Recall", async () => {
    const fleet = {
      simulated: true, updated_at: "", drones: [{ id: "D1", name: "Drone 1", simulated: true, position: null, altitude_m: 50, speed_ms: 8, battery_pct: 22, max_wind_kmh: 40, status: "flying", leg_id: "L004" }],
      legs: [{ id: "L001", drone_id: "D1", sector_id: "B2", waypoints: [], status: "done" }, { id: "L004", drone_id: "D1", sector_id: "C3", waypoints: [], status: "flying" }],
    } as unknown as CommandProps["fleet"];
    const p = setup({ fleet, links: { drones: { D1: { link: "degraded", since: null, last_heard_at: null } }, teams: {} } });
    const card = screen.getByRole("article", { name: "Drone Drone 1" });
    expect(card).toHaveTextContent("battery 22 %");
    expect(card).toHaveTextContent("link degraded");
    expect(card).toHaveTextContent("line 2 of 2");
    expect(card).toHaveTextContent("C3");
    await userEvent.click(within(card).getByRole("button", { name: "Recall" }));
    expect(p.actions.recallDrone).toHaveBeenCalledWith("D1");
  });

  it("Needs you holds decisions only: proposals, overdue teams, clues to read back", async () => {
    const clue = { id: "c005", kind: "object", text: "glove by the bridge", lat: 49.37, lon: -122.94, radius_m: 30, reported_by: "T4", source: "radio", confirmed: false, at: "2026-10-24T21:59:00Z" } as Clue;
    const p = setup({ proposals: [proposal(), proposal({ id: "p001", status: "approved" })], clues: [clue] });
    const needs = screen.getByRole("region", { name: "Needs you" });
    expect(within(needs).getByLabelText("Proposal p003")).toBeInTheDocument();
    expect(within(needs).queryByLabelText("Proposal p001")).toBeNull();
    expect(within(needs).getByRole("article", { name: "Overdue Team Three" })).toHaveTextContent("Team Three not heard for 40 min");
    const back = within(needs).getByRole("article", { name: "Awaiting read-back" });
    expect(back).toHaveTextContent("glove by the bridge");
    await userEvent.click(within(back).getByRole("button", { name: "Confirm clue" }));
    expect(p.actions.confirmClue).toHaveBeenCalledWith("c005");
    expect(needs).toHaveTextContent("3 waiting");
  });

  it("the timeline: one stream, filter chips, read-only rows (no Reply or Confirm: Needs you decides), Show selects the team, Send calls the team", async () => {
    const events = [
      radio("e1", "Team Two", "Blue water bottle by the creek crossing, over.", "2026-10-24T21:37:48Z"),
      { id: "e2", type: "task.updated", at: "2026-10-24T21:56:00Z", summary: "", ref: "D4", data: task("D4", "searched", "T4", 0.6) } as unknown as MissionEvent,
    ];
    const p = setup({ events });
    const tl = screen.getByRole("region", { name: "Timeline" });
    expect(within(tl).getByText("D4 searched at POD 60 % (Team Four)")).toBeInTheDocument();
    await userEvent.click(within(tl).getByRole("button", { name: "Clues" }));
    expect(within(tl).queryByText(/D4 searched/)).toBeNull();
    await userEvent.click(within(tl).getByRole("button", { name: "Radio" }));
    expect(within(tl).getByText(/D4 searched/)).toBeInTheDocument(); // a team's report is a check-in
    expect(within(tl).queryByRole("button", { name: "Reply" })).toBeNull();
    expect(within(tl).queryByRole("button", { name: "Confirm" })).toBeNull();
    await userEvent.click(within(tl).getAllByRole("button", { name: "Show" })[0]!);
    expect((await import("../lib/selection")).useSelection.getState().selectedTeamId).toBe("T4"); // the newest row: Team Four's report
    act(() => useConsole.getState().talk("T2", "Team Two, Sightline. "));
    expect(screen.getByLabelText("Recipient")).toHaveValue("T2");
    await userEvent.type(screen.getByLabelText("Message"), "copy, carry on east.");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(p.actions.call).toHaveBeenCalledWith("T2", "Team Two, Sightline. copy, carry on east.");
  });

  it("hold V with no radio server: the talk bar says to type, and V never fires while typing", async () => {
    setup();
    await userEvent.keyboard("{v>}{/v}");
    expect(screen.getByRole("form", { name: "Talk" })).toHaveTextContent("on the demo, type the call");
  });

  it("the sector popover: the agent's pick first, a drone leg, searched at a POD of at most 90 %, the find", async () => {
    const p = setup({ proposals: [proposal({ target: { team: "T4", sector: "B3" } })] });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 800 });
    act(() => useConsole.getState().openSector("B3", 100, 100));
    const pop = screen.getByRole("dialog", { name: "Sector B3" });
    expect(pop).toHaveTextContent("POA 6.9 % · drone coverage 25 %");
    const teams = within(within(pop).getByRole("group", { name: "Assign a team" })).getAllByRole("button");
    expect(teams.map((b) => b.textContent)).toEqual(["Team Four· AI's pick", "Team One", "Team Two· assigned", "Team Three· searching"]); // teams already out can be re-tasked
    await userEvent.click(teams[1]!);
    expect(p.actions.assign).toHaveBeenCalledWith("T1", "B3");
    expect(screen.queryByRole("dialog")).toBeNull(); // done: the popover closes
    const reopen = () => {
      act(() => useConsole.getState().openSector("B3", 100, 100));
      return screen.getByRole("dialog", { name: "Sector B3" });
    };
    await userEvent.click(within(reopen()).getByRole("button", { name: "Send a drone leg" }));
    expect(p.actions.droneLeg).toHaveBeenCalledWith("B3", undefined);
    const pod = within(reopen()).getByRole("group", { name: "POD entry" });
    expect(within(pod).getByLabelText("POD")).toHaveAttribute("max", "0.9"); // never 100 %
    expect(pod).toHaveTextContent("it never removes it");
    await userEvent.click(within(pod).getByRole("button", { name: "High 70 %" }));
    expect(p.actions.searched).toHaveBeenCalledWith("B3", 0.7);
    act(() => useConsole.getState().openSector("D4", 100, 100));
    const d4 = screen.getByRole("dialog", { name: "Sector D4" });
    await userEvent.click(within(d4).getByRole("button", { name: "Recheck" }));
    expect(p.actions.recheck).toHaveBeenCalledWith("D4");
    reopen();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("records the find from the sector a team is in", async () => {
    const p = setup();
    act(() => useConsole.getState().openSector("C2", 100, 100));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Sector C2" })).getByRole("button", { name: "Found: Team Two has the subject" }));
    expect(p.actions.found).toHaveBeenCalledWith("T2", "C2");
  });

  it("the sectors by POA, folded under the resources; a row opens its popover", async () => {
    setup();
    const rows = within(screen.getByRole("table", { name: "Sectors by POA" })).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual(["Sector B3", "Sector C2", "Sector D4"]);
    expect(rows[2]).toHaveTextContent("searched, POD 60 %");
    await userEvent.click(within(rows[0]!).getByRole("button"));
    expect(useConsole.getState().sector?.id).toBe("B3");
  });

  it("adds a clue at a team's position, from the timeline", async () => {
    const p = setup();
    await userEvent.click(screen.getByRole("button", { name: "Add clue" }));
    await userEvent.type(screen.getByLabelText("What"), "blue backpack by the creek");
    await userEvent.selectOptions(screen.getByLabelText("Team"), "T2");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(p.onAddClue).toHaveBeenCalledWith(expect.objectContaining({ kind: "object", text: "blue backpack by the creek", at_team_position: true, reported_by: "T2", source: "form" }));
  });

  it("checks a clue before sending it (test 5)", async () => {
    expect(clueProblem("", "team", "", "", "")).toBe("Say what was found.");
    expect(clueProblem("pack", "latlon", "91", "-122", "")).toMatch(/Latitude/);
    expect(clueProblem("pack", "latlon", "49.3", "", "")).toMatch(/Longitude/);
    expect(clueProblem("pack", "latlon", "49.3", "-122.9", "-5")).toMatch(/radius/);
    expect(clueProblem("pack", "latlon", "49.3", "-122.9", "40")).toBeNull();
    const p = setup({ onPickOnMap: vi.fn().mockResolvedValue({ lat: 49.3731234, lon: -122.9357654 }) });
    await userEvent.click(screen.getByRole("button", { name: "Add clue" }));
    await userEvent.type(screen.getByLabelText("What"), "boot print");
    await userEvent.selectOptions(screen.getByLabelText("Where"), "latlon");
    await userEvent.type(screen.getByLabelText("Latitude"), "123");
    await userEvent.type(screen.getByLabelText("Longitude"), "-122.9");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Latitude must be a number from -90 to 90.");
    expect(p.onAddClue).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Pick on map" }));
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(p.onAddClue).toHaveBeenCalledWith(expect.objectContaining({ lat: 49.373123, lon: -122.935765, at_team_position: false, reported_by: "command" }));
  });

  it("the views' rail in place of Needs you, a cover over it all, the map still mounted", () => {
    setup({ rightRail: <p>photos rail</p>, cover: <p>the trace</p>, overMap: <p>scrubber</p> });
    const view = screen.getByLabelText("Command view");
    expect(within(view).getByRole("complementary", { name: "View" })).toHaveTextContent("photos rail");
    expect(within(view).queryByRole("region", { name: "Needs you" })).toBeNull();
    expect(view).toHaveTextContent("the map");
    expect(view).toHaveTextContent("scrubber");
    expect(view).toHaveTextContent("the trace");
  });

  it("the shortcut overlay lists the console's keys", async () => {
    const { SHORTCUT_GROUPS } = await import("../shell/shortcuts");
    const keys = (title: string) => SHORTCUT_GROUPS.find((g) => g.title === title)?.shortcuts.flatMap((s) => s.keys);
    expect(keys("Views")).toEqual(["1", "2", "4", "5", "C", "?", "Esc"]);
    expect(keys("Needs you")).toEqual(["3", "Tab", "A", "X", "E", "J", "↓", "K", "↑", "P", "S", "N", "G", "O", "U"]);
    expect(keys("Map")).toEqual(["W", "L", "Esc"]);
    expect(keys("Timeline and radio")).toEqual(["6", "V", "Space"]);
  });

  it("the guided search's bar and Needs you share one scroll column, the bar first (theme.css data-guided)", () => {
    setup({ dock: <div data-testid="bar">the guide</div> });
    const column = document.getElementById("console-needs")!;
    expect(column).toHaveAttribute("data-guided");
    expect(column.className).toMatch(/lg:overflow-y-auto/);
    // the bar, then Needs you, in one column (no box of its own with a scroll cut short)
    const kids = [...column.children];
    expect(kids[0]).toContainElement(screen.getByTestId("bar"));
    expect(kids[0]!.className).not.toMatch(/overflow|max-h/);
    expect(kids[1]).toHaveAttribute("aria-label", "Needs you");
  });

  it("without the guided search, Needs you scrolls on its own", () => {
    setup();
    expect(document.getElementById("console-needs")).not.toHaveAttribute("data-guided");
  });

  it('never says "clear"', () => {
    setup({ proposals: [proposal()] });
    act(() => useConsole.getState().openSector("B3", 100, 100));
    expect(document.body.textContent).not.toMatch(/\bclear(s|ed|ing)?\b/i);
    expect(document.body.textContent).not.toMatch(/\brul(e|ed) out\b/i);
  });
});

describe("the status line", () => {
  const line = (over: Partial<Parameters<typeof StatusLine>[0]> = {}) =>
    render(<StatusLine mission={mission} conditions={conditions} teams={[team("T1", "One", "searching"), team("T2", "Two", "returning"), team("T3", "Three")]} clues={[]} now={NOW} tz={true} onConditions={vi.fn()} {...over} />);

  it("says how long the search has run, daylight left, flyability in one word with its gate, people out, found or not, clues", () => {
    line();
    const s = screen.getByRole("status", { name: "Mission status" });
    expect(s).toHaveTextContent("Elapsed1 h 30 min");
    expect(s).toHaveTextContent("Daylight2 h 40 min left, light until 00:40");
    expect(within(s).getByRole("button", { name: /Drones can fly until 00:40/ })).toHaveAttribute("title", expect.stringContaining("gusts under the limit"));
    expect(s).toHaveTextContent("Lower Seymour trail closed");
    expect(s).toHaveTextContent("In the field2 teams (6 people)");
    expect(s).toHaveTextContent("Subjectnot found");
    expect(s).toHaveTextContent("Clues0");
  });

  it("says Found, and where", () => {
    line({ mission: { ...mission, status: "found", found: { team: "T1", sector: "C2", lat: 0, lon: 0, at: "" } } });
    expect(screen.getByRole("status", { name: "Mission status" })).toHaveTextContent("Found · C2");
  });
});
