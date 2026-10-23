// Add a clue (V3 §3): a point picked on the map opens the short form there (what, who reported,
// reliability); the first radio call that lands brings a one-time hint saying how.
import { render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionEvent, Team } from "../contract";
import { useNotify } from "../shell/notify";
import { showMe } from "./showMe";
import { useConsole } from "./consoleStore";
import { useEventToasts } from "./notifications";
import { ClueForm } from "./Timeline";

const teams: Team[] = [{ id: "T2", callsign: "Team Two", members: 3, status: "searching", position: null, position_at: null, note: null }];

describe("Add clue", () => {
  beforeEach(() => {
    useConsole.getState().reset();
    useNotify.getState().reset();
  });

  it("from a point on the map: the form opens at it, with who reported it and how reliable", async () => {
    showMe({ kind: "addClue", at: { lat: 49.3712345, lon: -122.9443219 } });
    const c = useConsole.getState().clue;
    expect(c).toMatchObject({ open: true, at: { lat: 49.3712345, lon: -122.9443219 } });
    const onAddClue = vi.fn();
    render(<ClueForm teams={teams} onAddClue={onAddClue} onDone={() => {}} at={c.at} />);
    expect((screen.getByLabelText("Latitude") as HTMLInputElement).value).toMatch(/^49\.37123/);
    await userEvent.type(screen.getByLabelText("What"), "glove on the trail");
    await userEvent.selectOptions(screen.getByLabelText("Reported by"), "public");
    await userEvent.click(screen.getByRole("radio", { name: "high" }));
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onAddClue).toHaveBeenCalledWith(expect.objectContaining({ text: "glove on the trail", lat: expect.closeTo(49.371234, 5), lon: expect.closeTo(-122.944322, 5), at_team_position: false, reported_by: "public", reliability: "high" }));
  });

  it("the first radio call brings the hint, once", () => {
    const call = (id: string): MissionEvent => ({ id, type: "radio.turn", at: "2026-10-24T21:40:00Z", summary: "", ref: id, data: { id, direction: "in", callsign: "Team Two", transcript: "Sightline, Team Two. Boot print by the creek, over." } as never });
    const { rerender } = renderHook(({ events }) => useEventToasts(events, teams, 0), { initialProps: { events: [] as MissionEvent[] } });
    rerender({ events: [call("e1")] });
    rerender({ events: [call("e1"), call("e2")] });
    const hints = useNotify.getState().log.filter((n) => n.key === "clue-hint");
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ action: "Add clue", target: { kind: "addClue" } });
  });
});
