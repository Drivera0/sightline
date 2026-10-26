import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MissionEvent, Proposal } from "../contract";
import { Timeline } from "../command/Timeline";
import { EventFeed } from "../command/EventFeed";
import { clock, clockWithZone, ClockZone, DEMO_TZ, utcLabel, zone } from "./time";

const AT = "2026-10-24T15:01:09Z";

describe("the mission pages' clock", () => {
  it("is 24-hour, in UTC or in the browser's zone", () => {
    expect(clock(AT, true)).toBe("15:01");
    expect(clock(AT, true, true)).toBe("15:01:09");
    const d = new Date(AT);
    const local = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    expect(clock(AT, false)).toBe(local);
    expect(clock(AT, false)).not.toMatch(/AM|PM/i);
    expect(clock("not a time", true)).toBe("not a time");
  });

  it("reads an incident's own zone with its name: the demo at Mount Seymour is 13:35 PDT, 20:35 UTC on hover", () => {
    expect(clock("2026-10-24T20:35:00Z", DEMO_TZ)).toBe("13:35");
    expect(zone(new Date("2026-10-24T20:35:00Z"), DEMO_TZ)).toBe("PDT");
    expect(clockWithZone("2026-10-24T20:35:00Z", DEMO_TZ)).toBe("13:35 PDT");
    expect(utcLabel("2026-10-24T20:35:00Z")).toBe("20:35 UTC");
    expect(zone(new Date(), true)).toBe("UTC");
  });

  it("formats a decision's time in the timeline like the event log beside it (no 12-hour 03:01 PM)", () => {
    const decided = {
      id: "p001", kind: "alert", status: "approved", summary: "Sound heard near the creek", reason: "r", target: {}, evidence: [],
      briefing: null, created_by: "agent", created_at: "2026-10-24T14:50:00Z", decided_by: "Ana", decided_at: AT, decision_reason: null, edits: null,
    } as unknown as Proposal;
    const ev = { id: "e00001", type: "proposal.decided", at: AT, summary: "p001 approved by Ana", ref: "p001", data: decided } as unknown as MissionEvent;
    render(
      <ClockZone.Provider value={{ tz: true }}>
        <Timeline events={[ev]} teams={[]} onConfirmClue={() => undefined} talk={null} clueForm={() => null} />
        <EventFeed events={[ev]} />
      </ClockZone.Provider>,
    );
    expect(screen.getByText(/Ana approved the AI's suggestion/)).toBeInTheDocument();
    expect(screen.getByText("15:01")).toBeInTheDocument();
    expect(screen.getByText("15:01:09")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\d{2}:\d{2} [AP]M/);
  });
});
