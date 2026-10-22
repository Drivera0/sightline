import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MissionEvent, Proposal } from "../contract";
import { ApprovalInbox } from "../command/ApprovalInbox";
import { EventFeed } from "../command/EventFeed";
import { clock, ClockZone } from "./time";

const AT = "2026-10-24T15:01:09Z";

describe("the mission pages' clock", () => {
  it("is 24-hour, in UTC on the demo and in the browser's zone on a live mission", () => {
    expect(clock(AT, true)).toBe("15:01");
    expect(clock(AT, true, true)).toBe("15:01:09");
    const d = new Date(AT);
    const local = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    expect(clock(AT, false)).toBe(local);
    expect(clock(AT, false)).not.toMatch(/AM|PM/i);
    expect(clock("not a time", true)).toBe("not a time");
  });

  it("formats the approvals' decided time like the feed beside it (no 12-hour 03:01 PM)", () => {
    const decided = {
      id: "p001", kind: "alert", status: "approved", summary: "Sound heard near the creek", reason: "r", target: {}, evidence: [],
      briefing: null, created_by: "agent", created_at: "2026-10-24T14:50:00Z", decided_by: "Ana", decided_at: AT, decision_reason: null, edits: null,
    } as unknown as Proposal;
    const ev = { id: "e00001", type: "proposal.decided", at: AT, summary: "p001 approved by Ana", ref: "p001", data: null } as MissionEvent;
    render(
      <ClockZone.Provider value={{ utc: true }}>
        <ApprovalInbox proposals={[decided]} teams={[]} onDecide={() => undefined} imageUrl={(r) => r} />
        <EventFeed events={[ev]} />
      </ClockZone.Provider>,
    );
    expect(screen.getByText(/Approved by Ana at 15:01/)).toBeInTheDocument();
    expect(screen.getByText("15:01:09")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\d{2}:\d{2} [AP]M/);
  });
});
