// Call and Task (V3 §3): Task lists the sectors by POA with the agent's pick for that team first, and a
// tap assigns; Call addresses the talk bar to that team.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Proposal, SectorTask } from "../contract";
import type { SectorNow } from "../lib/api";
import { useConsole } from "./consoleStore";
import { pickRows, SectorPicker } from "./SectorPicker";
import { TalkBar } from "./Timeline";

const sector = (id: string, poa: number) => ({ sector_id: id, label: "", poa, coverage: 0, polygon: null }) as unknown as SectorNow;
const sectors = [sector("A1", 0.02), sector("B3", 0.05), sector("C2", 0.035), sector("D4", 0.08)];
const tasks: SectorTask[] = [{ sector_id: "D4", state: "searched", team_id: "T4", poa: 0, pod: 0.6, note: null, updated_at: "" }];
const proposal: Proposal = {
  id: "p002", kind: "assign_sector", summary: "", reason: "", briefing: null, target: { team: "T1", sector: "C2" }, evidence: [], status: "pending",
  created_by: "agent", created_at: "", decided_at: null, decided_by: null, decision_reason: null, edits: null,
};

describe("Task: the sector picker", () => {
  it("the agent's pick first, then by POA, searched sectors last", () => {
    expect(pickRows("team", "T1", sectors, tasks, [proposal]).map((r) => [r.sector, r.pick])).toEqual([["C2", true], ["B3", false], ["A1", false], ["D4", false]]);
    // another team: no pick, by POA
    expect(pickRows("team", "T2", sectors, tasks, [proposal]).map((r) => r.sector)).toEqual(["B3", "C2", "A1", "D4"]);
  });

  it("a tap assigns; Show N more shows the rest; Cancel closes", async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<SectorPicker kind="team" id="T1" name="Team One" sectors={sectors} tasks={tasks} proposals={[proposal]} onPick={onPick} onClose={onClose} max={2} />);
    expect(screen.getByText("Agent's pick")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^A1/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show 2 more" }));
    expect(screen.getByRole("button", { name: /^A1/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^C2/ }));
    expect(onPick).toHaveBeenCalledWith("C2");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("Call", () => {
  it("opens the talk bar on that team, says it is calling, the cursor in the message", () => {
    const teams = [
      { id: "T1", callsign: "Team One", members: 3, status: "standby" as const, position: null, position_at: null, note: null },
      { id: "T2", callsign: "Team Two", members: 3, status: "standby" as const, position: null, position_at: null, note: null },
    ];
    render(<TalkBar teams={teams} onSend={vi.fn()} />);
    expect(screen.getByLabelText("Recipient")).toHaveValue("T1");
    act(() => useConsole.getState().talk("T2", "Team Two, Sightline. "));
    return Promise.resolve().then(() => {
      expect(screen.getByLabelText("Recipient")).toHaveValue("T2");
      expect(screen.getByText("Calling")).toBeInTheDocument();
      expect(screen.getByLabelText("Message")).toHaveFocus();
    });
  });
});
