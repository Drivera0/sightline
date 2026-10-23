import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineEntry } from "../contract";
import { RadioAudio, audioUrl } from "./RadioAudio";

const line = (id: string, audio: string | null, kind: TimelineEntry["kind"] = "radio"): TimelineEntry => ({
  id,
  at: "2026-10-24T21:40:00Z",
  kind,
  text: "Sightline, Team Two. Blue water bottle by the creek crossing, over.",
  refs: [],
  turn_id: "r0004",
  direction: "in",
  team: "T2",
  audio,
});

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

describe("RadioAudio", () => {
  it("never plays the lines that were there when it mounted", () => {
    render(<RadioAudio entries={[line("e1", "voices/demo/r0004.mp3")]} base="/" />);
    fireEvent.pointerDown(document.body);
    expect(played).toEqual([]);
  });

  it("does not autoplay a new line before a user gesture", () => {
    const { rerender } = render(<RadioAudio entries={[]} base="/" />);
    rerender(<RadioAudio entries={[line("e1", "voices/demo/r0004.mp3")]} base="/" />);
    expect(played).toEqual([]);
  });

  it("plays a new line's clip after a gesture, and only radio lines with audio", () => {
    const { rerender } = render(<RadioAudio entries={[]} base="/" />);
    fireEvent.pointerDown(document.body);
    rerender(
      <RadioAudio
        entries={[line("e1", "voices/demo/r0004.mp3"), line("e2", null), line("e3", "x.mp3", "clue")]}
        base="/"
      />,
    );
    expect(played).toHaveLength(1);
    expect(played[0]).toMatch(/\/voices\/demo\/r0004\.mp3$/);
  });

  it("plays one clip at a time, in order", () => {
    const { rerender } = render(<RadioAudio entries={[]} base="/" />);
    fireEvent.keyDown(document.body, { key: "a" });
    rerender(
      <RadioAudio entries={[line("e1", "voices/demo/a.mp3"), line("e2", "voices/demo/b.mp3")]} base="/" />,
    );
    expect(played).toHaveLength(1);
    expect(played[0]).toMatch(/a\.mp3$/);
  });

  it("the mute toggle silences new lines and is remembered", () => {
    const { rerender } = render(<RadioAudio entries={[]} base="/" />);
    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("Voices on");
    act(() => button.click());
    expect(button).toHaveTextContent("Voices off");
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(localStorage.getItem("sightline.radioAudio.muted")).toBe("1");
    rerender(<RadioAudio entries={[line("e1", "voices/demo/r0004.mp3")]} base="/" />);
    expect(played).toEqual([]);
  });

  it("a jump of the clock plays only the newest turn (the team's line, then the desk's reply)", () => {
    const { rerender } = render(<RadioAudio entries={[]} base="/" />);
    fireEvent.pointerDown(document.body);
    const turn = (id: string, t: string, audio: string) => ({ ...line(id, audio), turn_id: t });
    rerender(
      <RadioAudio
        entries={[turn("e1", "r1", "voices/x/r1.mp3"), turn("e1-reply", "r1", "voices/x/r1-desk.mp3"), turn("e2", "r2", "voices/x/r2.mp3"), turn("e2-reply", "r2", "voices/x/r2-desk.mp3")]}
        base="/"
      />,
    );
    expect(played).toHaveLength(1);
    expect(played[0]).toMatch(/r2\.mp3$/);
  });

  it("builds clip URLs under the site base", () => {
    expect(audioUrl("voices/demo/r0004.mp3", "/sightline/")).toBe("/sightline/voices/demo/r0004.mp3");
    expect(audioUrl("voices/demo/r0004.mp3", "/")).toBe("/voices/demo/r0004.mp3");
    expect(audioUrl("/abs.mp3", "/x/")).toBe("/abs.mp3");
  });
});
