// Needs you once the subject is found: no "16 waiting"; the proposals and candidates close under one row
// that expands; an overdue team still needs a person, and Recall still works.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Proposal, Team } from "../contract";
import { NeedsYou } from "./NeedsYou";

const AT = "2026-10-24T21:40:00Z";
const p = (id: string, summary: string): Proposal => ({
  id, kind: "assign_sector", summary, reason: "r", briefing: null, target: { team: "T1", sector: "B3" }, evidence: [], status: "pending",
  created_by: "agent", created_at: AT, decided_at: null, decided_by: null, decision_reason: null, edits: null,
});
const team = (id: string, callsign: string, status: Team["status"] = "searching"): Team => ({ id, callsign, members: 3, status, position: null, position_at: null, note: null });

function setup(found: { at: string | null } | null, teams: Team[] = [team("T1", "Team One")], now = new Date("2026-10-24T22:00:00Z")) {
  const onRecall = vi.fn();
  render(
    <NeedsYou
      proposals={[p("p002", "Add f0396-d01 to the review queue"), p("p004", "Assign sector B3 to Team Two")]}
      teams={teams}
      drones={[]}
      events={[]}
      clues={[]}
      now={now}
      checkInMin={30}
      onDecide={vi.fn()}
      imageUrl={(r) => r}
      review={<div>review cards</div>}
      reviewCount={14}
      onCall={vi.fn()}
      onRecall={onRecall}
      onConfirmClue={vi.fn()}
      found={found}
    />,
  );
  return onRecall;
}

describe("Needs you", () => {
  it("counts what waits while the search is on", () => {
    setup(null);
    expect(screen.getByRole("heading", { name: /Needs you/ })).toHaveTextContent("16 waiting");
    expect(screen.getByLabelText("Proposal p002")).toBeInTheDocument();
    expect(screen.getByText("review cards")).toBeInTheDocument();
  });

  it("closes the proposals and candidates when the subject is found, under one row that expands", async () => {
    setup({ at: "2026-10-24T22:00:00Z" });
    const head = screen.getByRole("heading", { name: /Needs you/ });
    expect(head).not.toHaveTextContent("waiting");
    expect(head).toHaveTextContent("subject found");
    expect(screen.queryByLabelText("Proposal p002")).toBeNull(); // nothing left to approve
    expect(screen.queryByText("review cards")).toBeNull();
    const closed = screen.getByRole("group", { name: "Closed: subject found" });
    expect(closed).toHaveTextContent(/^16 items closed at \d\d:\d\d, subject found/);
    expect(closed).not.toHaveAttribute("open");
    await userEvent.click(within(closed).getByText(/16 items closed/));
    expect(closed).toHaveAttribute("open");
    expect(within(closed).getAllByText("closed: subject found")).toHaveLength(3); // two proposals, the candidates
    expect(closed).toHaveTextContent("14 candidates to review");
  });

  it("still asks about an overdue team after the find, and Recall still works", async () => {
    const late: Team = { ...team("T3", "Team Three"), last_heard_at: "2026-10-24T20:00:00Z" };
    const onRecall = setup({ at: null }, [late]);
    const card = screen.getByLabelText("Overdue Team Three");
    expect(screen.getByRole("heading", { name: /Needs you/ })).toHaveTextContent("1 waiting");
    await userEvent.click(within(card).getByRole("button", { name: "Recall" }));
    expect(onRecall).toHaveBeenCalledWith("T3");
    expect(screen.getByRole("group", { name: "Closed: subject found" })).toHaveTextContent("16 items closed, subject found");
  });
});
