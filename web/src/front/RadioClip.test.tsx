// "Hear Sightline on the radio": the clip with its transcript, in About and the Debrief, served locally.
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RADIO_CLIP } from "./copy";
import { AboutSheet } from "./About";
import { RadioClip } from "./RadioClip";

afterEach(() => vi.restoreAllMocks());

describe("RadioClip", () => {
  it("renders the play button, the label and the transcript, and plays a file from this site", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<RadioClip />);
    const clip = screen.getByRole("group", { name: "Sightline on the radio" });
    expect(clip).toHaveTextContent(`${RADIO_CLIP.label} · ${RADIO_CLIP.detail}`);
    const transcript = clip.querySelector("details")!;
    expect(within(transcript).getByText("Transcript").tagName).toBe("SUMMARY");
    expect(transcript).toHaveTextContent(RADIO_CLIP.transcript);
    expect(transcript).not.toHaveAttribute("open"); // folded until asked for
    const audio = clip.querySelector("audio")!;
    expect(audio).toHaveAttribute("src", "/front/briefing.mp3");
    expect(audio).toHaveAttribute("preload", "none"); // nothing loads until Play
    await userEvent.click(screen.getByRole("button", { name: "Play the radio briefing" }));
    expect(play).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is in the About sheet, under the pitch", () => {
    render(<AboutSheet onClose={() => undefined} />);
    expect(within(screen.getByRole("dialog", { name: "About Sightline" })).getByRole("group", { name: "Sightline on the radio" })).toHaveTextContent(RADIO_CLIP.transcript);
  });

  it("ships the clip: an MP3 of at most 300 KB in public/front", () => {
    const file = resolve(__dirname, "../../public", RADIO_CLIP.src.slice(1));
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).size).toBeLessThanOrEqual(300 * 1024);
  });
});
