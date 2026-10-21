import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboundItem, TurnResponse, TurnStandby } from "./api";
import { RadioDesk, SAFETY_FRAME, type RadioDeps } from "./RadioDesk";
import { MicDenied } from "./recorder";
import { useRadio } from "./store";

const API = { base: "http://radio.test", missionId: "demo0001" };

function turn(over: Partial<TurnResponse> = {}): TurnResponse {
  return {
    id: "r0001",
    direction: "in",
    callsign: "T2",
    transcript: "Sightline, Team Two, say again the sector boundary, over.",
    reply: "Team Two, Sightline. Entry east ridge, over.",
    audio: "radio/r0001.wav",
    state: "answered",
    actions: ["get_sector_boundary"],
    asr_ms: 76,
    llm_ms: 2389,
    tts_ms: 0,
    at: "2026-10-24T21:40:12.000Z",
    clue: null,
    audio_chunks: ["/missions/demo0001/radio/audio/r0001-0.wav", "/missions/demo0001/radio/audio/r0001-1.wav"],
    ...over,
  };
}

const BRIEFING: OutboundItem = {
  id: "p014",
  kind: "assign_sector",
  summary: "Assign sector B3 to Team Two",
  briefing: "New assignment, sector Bravo Three. Enter from the east ridge.",
  target: { team: "T2", sector: "B3" },
};

function deps(over: Partial<RadioDeps> = {}): RadioDeps {
  return {
    postTurn: vi.fn(async (): Promise<TurnResponse | TurnStandby> => turn()),
    pollTurn: vi.fn(async () => turn()),
    getOutbound: vi.fn(async () => []),
    transmit: vi.fn(async () => turn({ id: "r0002", direction: "out", callsign: "T2", transcript: "", state: "transmitted" })),
    skip: vi.fn(async () => {}),
    startRecording: vi.fn(async () => ({ stop: async () => new Blob(["x"], { type: "audio/webm" }) })),
    playChunks: vi.fn(async () => {}),
    ...over,
  };
}

beforeEach(() => useRadio.getState().reset());

describe("RadioDesk", () => {
  it("shows the channel, the safety frame and empty states", async () => {
    render(<RadioDesk api={API} deps={deps()} operator="Dana" />);
    expect(screen.getByText(/Channel 2 · Sightline relay · Operator: Dana/)).toBeInTheDocument();
    expect(screen.getByText(SAFETY_FRAME)).toBeInTheDocument();
    expect(await screen.findByText("Nothing waiting to be transmitted.")).toBeInTheDocument();
    expect(screen.getByText("No radio traffic yet.")).toBeInTheDocument();
  });

  it("text fallback posts the text as the selected team, logs the turn and plays its chunks", async () => {
    const d = deps();
    render(<RadioDesk api={API} deps={d} />);
    await userEvent.type(screen.getByPlaceholderText(/type what the team says/), "Sightline, Team Two, say again the sector boundary, over.");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(d.playChunks).toHaveBeenCalled());
    expect(d.postTurn).toHaveBeenCalledWith(API, { text: "Sightline, Team Two, say again the sector boundary, over." }, "T2");
    expect(d.playChunks).toHaveBeenCalledWith(
      ["http://radio.test/missions/demo0001/radio/audio/r0001-0.wav", "http://radio.test/missions/demo0001/radio/audio/r0001-1.wav"],
      false,
    );
    expect(screen.getByText("Answered")).toBeInTheDocument();
    expect(screen.getByText(/ASR 76 ms · model 2.4 s · first audio 0 ms/)).toBeInTheDocument();
    await waitFor(() => expect(useRadio.getState().stage).toBe("idle"));
  });

  it("hold to talk records, release sends the audio", async () => {
    const d = deps();
    render(<RadioDesk api={API} deps={d} />);
    const talk = screen.getByRole("button", { name: /Hold to talk/ });
    await act(async () => fireEvent.mouseDown(talk));
    expect(useRadio.getState().stage).toBe("recording");
    await act(async () => fireEvent.mouseUp(talk));
    await waitFor(() => expect(d.postTurn).toHaveBeenCalled());
    const input = (d.postTurn as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { audio: Blob };
    expect(input.audio).toBeInstanceOf(Blob);
  });

  it("a refused microphone switches to the text box", async () => {
    const d = deps({ startRecording: vi.fn(async () => Promise.reject(new MicDenied("Microphone permission was refused."))) });
    render(<RadioDesk api={API} deps={d} />);
    await act(async () => fireEvent.mouseDown(screen.getByRole("button", { name: /Hold to talk/ })));
    expect(await screen.findByRole("alert")).toHaveTextContent("refused");
    expect(screen.getByPlaceholderText("No microphone: type what the team says")).toBeInTheDocument();
  });

  it("shows the readback while a clue awaits confirmation", async () => {
    const readback = "Team Two, Sightline. Copy object, blue backpack by the creek, at your position. Confirm, over.";
    const d = deps({ postTurn: vi.fn(async () => turn({ state: "awaiting_confirm", reply: readback })) });
    render(<RadioDesk api={API} deps={d} />);
    await userEvent.type(screen.getByPlaceholderText(/type what the team says/), "found a blue backpack");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    const card = await screen.findByLabelText("Awaiting confirmation");
    expect(card).toHaveTextContent("Awaiting confirmation from Team Two");
    expect(card).toHaveTextContent(readback);
  });

  it("transmits an approved briefing only when the operator presses Transmit, and can skip", async () => {
    const d = deps({ getOutbound: vi.fn().mockResolvedValueOnce([BRIEFING]).mockResolvedValue([]) });
    render(<RadioDesk api={API} deps={d} />);
    expect(await screen.findByText(BRIEFING.briefing)).toBeInTheDocument();
    expect(d.transmit).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Transmit" }));
    await waitFor(() => expect(d.transmit).toHaveBeenCalledWith(API, "p014"));
    expect(await screen.findByText("Transmitted")).toBeInTheDocument();

    const d2 = deps({ getOutbound: vi.fn().mockResolvedValueOnce([BRIEFING]).mockResolvedValue([]) });
    useRadio.getState().reset();
    render(<RadioDesk api={API} deps={d2} />);
    await userEvent.click((await screen.findAllByRole("button", { name: "Skip" })).at(-1)!);
    await waitFor(() => expect(d2.skip).toHaveBeenCalledWith(API, "p014"));
  });
});

describe("standby", () => {
  it("plays standby at once, waits for the answer, then plays and logs it", async () => {
    const standby: TurnStandby = {
      standby: true,
      reply: "Team Two, Sightline. Standby.",
      audio_chunks: ["/missions/demo0001/radio/audio/s0001.wav"],
      poll: "/missions/demo0001/radio/turn/pending/abc123def456",
    };
    const d = deps({
      postTurn: vi.fn(async () => standby),
      pollTurn: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue(turn()),
    });
    render(<RadioDesk api={API} deps={d} />);
    await userEvent.type(screen.getByPlaceholderText(/type what the team says/), "say again the sector boundary");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Standby sent · thinking…")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Answered")).toBeInTheDocument(), { timeout: 3000 });
    expect(d.pollTurn).toHaveBeenCalledTimes(3);
    const played = (d.playChunks as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0][0]);
    expect(played).toEqual([
      "http://radio.test/missions/demo0001/radio/audio/s0001.wav", // standby first
      "http://radio.test/missions/demo0001/radio/audio/r0001-0.wav", // then the answer
    ]);
  });
});

describe("radio copy", () => {
  it('never says "clear" or "cleared" (LANE_E §9 test 1)', () => {
    const dir = join(__dirname);
    for (const f of readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.tsx"))) {
      expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(/\bclear(ed)?\b/i);
    }
  });
});
