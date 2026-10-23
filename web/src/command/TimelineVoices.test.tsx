// The radio's voices in the timeline (PR #215's clips): the mute toggle in the header, a speaker on the rows
// that have a clip, and a turn's clip playing when it lands, the team's voice and then the desk's.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Team, TimelineEvent } from "../contract";
import fixture from "./__fixtures__/scenarios/overdue-hiker.json";
import { buildTimeline } from "./timeline";
import { Timeline } from "./Timeline";

const teams = fixture.teams as unknown as Team[];
const radio = (fixture.timeline as unknown as TimelineEvent[]).filter((e) => e.kind === "radio" && e.audio);
let played: string[];

beforeEach(() => {
  played = [];
  localStorage.clear();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    played.push(this.src);
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const view = (server: readonly TimelineEvent[]) => <Timeline events={[]} server={server} teams={teams} onConfirmClue={() => {}} talk={null} clueForm={() => null} voicesKey="demo" />;

describe("radio voices in the timeline", () => {
  it("the fixture's team turns have the team's clip, the replies the desk's", () => {
    const [team, desk] = radio;
    expect(team!.direction).toBe("in");
    expect(team!.audio).toMatch(/voices\/overdue-hiker\/r\d+\.mp3$/);
    expect(desk!.direction).toBe("out");
    expect(desk!.audio).toBe(team!.audio!.replace(".mp3", "-desk.mp3"));
    expect(buildTimeline([], teams, radio).filter((e) => e.audio)).toHaveLength(radio.length);
  });

  it("shows a speaker on the rows with a clip, and the mute toggle in the header", () => {
    render(view(radio.slice(0, 2)));
    expect(screen.getAllByText("voice clip")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Radio voices on/ })).toBeInTheDocument();
  });

  it("plays a turn's clip when it lands, after a gesture; never the lines it opened with", () => {
    const { rerender } = render(view(radio.slice(0, 2)));
    fireEvent.pointerDown(document.body);
    expect(played).toEqual([]);
    rerender(view(radio.slice(0, 4)));
    expect(played).toHaveLength(1);
    expect(played[0]).toContain(radio[2]!.audio!);
    act(() => screen.getByRole("button", { name: /Radio voices on/ }).click());
    rerender(view(radio.slice(0, 6)));
    expect(played).toHaveLength(1);
  });
});
