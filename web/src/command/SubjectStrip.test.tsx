// The subject strip (the cold test's first question): who, last seen when and where and how long ago in
// local time, LKP centres the map, Profile opens the full profile and Esc closes it.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { Mission } from "../contract";
import { DEMO_TZ } from "../lib/time";
import { useConsole } from "./consoleStore";
import { subjectBrief, SubjectStrip } from "./SubjectStrip";

const mission = {
  contract_version: "1.3",
  mission_id: "demo",
  name: "Mount Seymour",
  area: { name: "Mount Seymour", lkp: { lat: 49.37, lon: -122.945 } },
  created_at: "2026-10-24T20:30:00Z",
  mode: "demo",
  last_seen_at: "2026-10-24T17:30:00Z",
  subject: "adult, red jacket, day hiker",
  base_camp: { lat: 49.373, lon: -122.949, name: "Trailhead lot" },
  status: "searching",
} as Mission;
const now = new Date("2026-10-24T20:35:00Z");

describe("the subject strip", () => {
  beforeEach(() => useConsole.getState().reset());

  it("says who, last seen at 10:30 at the place, 3 h 05 min ago, in the mission's local time", () => {
    expect(subjectBrief(mission, now, DEMO_TZ, "at the trailhead lot")).toEqual({ profile: "Adult, red jacket, day hiker", seen: "10:30", ago: "3 h 05 min ago", place: "at the trailhead lot" });
    render(<SubjectStrip mission={mission} now={now} tz={DEMO_TZ} place="at the trailhead lot" />);
    expect(screen.getByRole("region", { name: "Subject" })).toHaveTextContent("Adult, red jacket, day hiker·last seen 10:30 at the trailhead lot · 3 h 05 min ago");
  });

  it("LKP centres the map on the last known point; Profile opens the full profile, Esc closes it", async () => {
    render(<SubjectStrip mission={mission} now={now} tz={DEMO_TZ} />);
    await userEvent.click(screen.getByRole("button", { name: /LKP/ }));
    expect(useConsole.getState().centre).toMatchObject({ lat: 49.37, lon: -122.945 });
    await userEvent.click(screen.getByRole("button", { name: "Profile" }));
    const profile = screen.getByRole("dialog", { name: "Subject profile" });
    expect(profile).toHaveTextContent("Trailhead lot");
    expect(profile).toHaveTextContent("Not found");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Subject profile" })).toBeNull();
  });
});
