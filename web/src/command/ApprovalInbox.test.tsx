// LANE_E §9 test 4: the approval inbox. Reject needs a reason; edits go with the approval; decided
// proposals say who and when; keys act on the focused card only.
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Proposal, Team } from "../contract";
import { ApprovalInbox } from "./ApprovalInbox";

const AT = "2026-10-24T21:40:00Z";
const p = (over: Partial<Proposal>): Proposal => ({
  id: "p001", kind: "assign_sector", summary: "Assign sector B3 to Team One", reason: "Sector B3 holds 6.9% of the probability.",
  briefing: "Team One, search sector B3.", target: { team: "T1", sector: "B3" }, evidence: [], status: "pending",
  created_by: "agent", created_at: AT, decided_at: null, decided_by: null, decision_reason: null, edits: null, ...over,
});
const team = (id: string, callsign: string): Team => ({ id, callsign, members: 3, status: "standby", position: null, position_at: null, note: null });
const TEAMS = [team("T1", "Team One"), team("T2", "Team Two")];

function setup(proposals: Proposal[]) {
  const onDecide = vi.fn();
  render(<ApprovalInbox proposals={proposals} teams={TEAMS} onDecide={onDecide} imageUrl={(r) => `/f/${r}`} />);
  return onDecide;
}

beforeEach(() => sessionStorage.clear());

describe("ApprovalInbox", () => {
  it("lists pending proposals newest first, with the evidence", () => {
    setup([
      p({ id: "p001", created_at: "2026-10-24T21:40:00Z" }),
      p({ id: "p002", kind: "retask_drone", summary: "Re-task Drone 1 to sector B3", briefing: null, created_by: "planner", created_at: "2026-10-24T21:45:00Z",
          evidence: [{ kind: "crop", ref: "crops/f0005-d01.jpg", caption: "photo f0005" }, { kind: "leg", ref: "L002", caption: "lawnmower" }] }),
    ]);
    const cards = screen.getAllByLabelText(/^Proposal p00/);
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual(["Proposal p002", "Proposal p001"]);
    expect(within(cards[0]!).getByAltText("photo f0005")).toHaveAttribute("src", "/f/crops/f0005-d01.jpg");
    expect(within(cards[0]!).getByText("leg L002")).toBeInTheDocument();
    expect(screen.getByText("Approvals · 2 waiting")).toBeInTheDocument();
  });

  it("approves as the person named in the header", async () => {
    const onDecide = setup([p({})]);
    await userEvent.type(screen.getByLabelText("Your name"), "Dana");
    await userEvent.click(screen.getByRole("button", { name: /Approve/ }));
    expect(onDecide).toHaveBeenCalledWith("p001", "approve", "Dana", undefined, undefined);
    expect(sessionStorage.getItem("sightline.operator")).toBe("Dana");
  });

  it("a rejection needs a reason", async () => {
    const onDecide = setup([p({})]);
    await userEvent.click(screen.getByRole("button", { name: /Reject/ }));
    const submit = screen.getByRole("button", { name: "Reject" });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Why reject"), "Team One is on a break");
    await userEvent.click(submit);
    expect(onDecide).toHaveBeenCalledWith("p001", "reject", "Search manager", "Team One is on a break");
  });

  it("edits the team and the briefing before approving", async () => {
    const onDecide = setup([p({})]);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.selectOptions(screen.getByLabelText("Team"), "T2");
    const text = screen.getByLabelText(/Briefing/);
    await userEvent.clear(text);
    await userEvent.type(text, "Team Two, search sector B3 from the east ridge.");
    await userEvent.click(screen.getByRole("button", { name: /Approve/ }));
    expect(onDecide).toHaveBeenCalledWith("p001", "approve", "Search manager", undefined, {
      team: "T2", briefing: "Team Two, search sector B3 from the east ridge.",
    });
  });

  it("keys act on the focused card only, never while typing", async () => {
    const onDecide = setup([p({ id: "p001" }), p({ id: "p002", created_at: "2026-10-24T21:41:00Z" })]);
    fireEvent.keyDown(screen.getByLabelText("Proposal p001"), { key: "a" });
    expect(onDecide).toHaveBeenCalledWith("p001", "approve", "Search manager", undefined, undefined);
    fireEvent.keyDown(screen.getByLabelText("Your name"), { key: "a" });
    expect(onDecide).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByLabelText("Proposal p002"), { key: "x" });
    expect(screen.getByLabelText("Why reject")).toBeInTheDocument();
  });

  it("decided proposals collapse below, saying who decided and when", () => {
    setup([
      p({ id: "p001", status: "approved", decided_by: "Dana", decided_at: AT }),
      p({ id: "p002", status: "rejected", decided_by: "Dana", decided_at: AT, decision_reason: "duplicate" }),
    ]);
    expect(screen.getByText("Nothing waiting. The agent's proposals appear here.")).toBeInTheDocument();
    const decided = screen.getByLabelText("Decided proposals");
    expect(decided).toHaveTextContent(/Approved by Dana at/);
    expect(decided).toHaveTextContent(/Rejected by Dana at .*: duplicate/);
  });

  it('never says "clear"', () => {
    setup([p({})]);
    expect(document.body.textContent).not.toMatch(/\bclear(ed)?\b/i);
  });
});
