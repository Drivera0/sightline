// The owner's review (2026-10-25): the resources board reads at a glance (a summary line, one primary action
// in words, drag discoverable), Needs you asks one question per item with its outcome on the button, grouped
// most urgent first and pointable from the guided search, and the AI second look says its verdict first and
// what each model (OpenCV 5, Nemotron VL) said.
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Drone, Proposal, Team, Verdict } from "../contract";
import { NO_LINKS } from "../lib/mission";
import { DETECTOR_BROWSER, DETECTOR_CV2, DetectorScore, type ReviewCard } from "../review/LiveReview";
import { RUN_MAX_MS, SECOND_LOOK_LABEL, SecondLook, secondLookSteps, useSecondLook, verdictHead } from "../review/SecondLook";
import { proposalAsk } from "./ApprovalInbox";
import { useConsole } from "./consoleStore";
import { NeedsYou } from "./NeedsYou";
import { DRONE_DRAG, Resources, resourceSummary, TEAM_DRAG } from "./Resources";

const NOW = new Date("2026-10-24T22:00:00Z");
const team = (id: string, callsign: string, status: Team["status"] = "standby", heard: string | null = null): Team => ({
  id, callsign, members: 3, status, position: null, position_at: null, note: null, last_heard_at: heard,
});
const drone = (id: string, status: Drone["status"]): Drone => ({ id, name: `Drone ${id.slice(1)}`, simulated: true, position: null, altitude_m: 50, speed_ms: 8, battery_pct: 80, max_wind_kmh: 40, status, leg_id: null }) as Drone;
const proposal = (over: Partial<Proposal>): Proposal => ({
  id: "p001", kind: "assign_sector", summary: "Assign sector C2 to Team One", reason: "C2 holds 5.5 %.", briefing: null, target: { team: "T1", sector: "C2" },
  evidence: [], status: "pending", created_by: "planner", created_at: "2026-10-24T21:40:00Z", decided_at: null, decided_by: null, decision_reason: null, edits: null, ...over,
});
const heardOf = (overdue = false) => ({ at: null, min: overdue ? 40 : 4, overdue, due: false });

beforeEach(() => useConsole.getState().reset());

describe("Resources: the board at a glance", () => {
  it("sums the teams and drones in one line each, zero counts left out", () => {
    const s = resourceSummary(
      [
        { team: team("T1", "Team One"), heard: { at: null, min: null, overdue: false, due: false } },
        { team: team("T2", "Team Two", "searching"), heard: heardOf() },
        { team: team("T3", "Team Three", "searching"), heard: heardOf(true) },
      ],
      [drone("D1", "flying"), drone("D2", "idle"), drone("D3", "charging")],
    );
    expect(s.teams).toBe("3 teams: 1 free · 1 searching · 1 overdue");
    expect(s.drones).toBe("3 drones: 1 flying · 2 at base");
    expect(resourceSummary([], []).drones).toBeNull();
  });

  function board() {
    const actions = { onCall: vi.fn(), onRecall: vi.fn(), onRecallDrone: vi.fn(), onAssign: vi.fn(), onDroneLeg: vi.fn() };
    const fleet = { simulated: true, updated_at: "", drones: [drone("D1", "idle")], legs: [] } as never;
    render(
      <Resources mission={null} teams={[team("T1", "Team One"), team("T2", "Team Two", "searching", "2026-10-24T21:58:00Z")]} tasks={[]} sectors={[{ sector_id: "C2", label: "", poa: 0.05, drone_coverage: 0, polygon: null } as never]} fleet={fleet} links={NO_LINKS} events={[]} now={NOW} actions={actions} />,
    );
    return actions;
  }

  it("one primary action per row in words: Assign to sector… for a free team, Reassign… for one out, Fly over a sector… for a drone", async () => {
    const actions = board();
    const one = screen.getByRole("article", { name: "Team Team One" });
    expect(screen.getByLabelText("Resources summary")).toHaveTextContent("2 teams: 1 free · 1 searching");
    expect(within(screen.getByRole("article", { name: "Team Team Two" })).getByRole("button", { name: "Reassign…" })).toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "Drone Drone 1" })).getByRole("button", { name: "Fly over a sector…" })).toBeInTheDocument();
    await userEvent.click(within(one).getByRole("button", { name: "Assign to sector…" }));
    expect(useConsole.getState().picking).toEqual({ kind: "team", id: "T1" });
    // the picker opens under the row, POA shown; a tap assigns
    await userEvent.click(within(one).getByRole("button", { name: /^C2/ }));
    expect(actions.onAssign).toHaveBeenCalledWith("T1", "C2");
  });

  it("says rows can be dragged, and a drag says what it carries (team or drone) and tells the map", () => {
    board();
    expect(screen.getByText(/Drag a row onto a sector/)).toBeInTheDocument();
    const one = screen.getByRole("article", { name: "Team Team One" });
    expect(one).toHaveAttribute("draggable", "true");
    const data: Record<string, string> = {};
    const dataTransfer = { setData: (k: string, v: string) => (data[k] = v), effectAllowed: "" };
    act(() => one.dispatchEvent(Object.assign(new Event("dragstart", { bubbles: true }), { dataTransfer })));
    expect(data[TEAM_DRAG]).toBe("T1");
    expect(useConsole.getState().dragging).toEqual({ kind: "team", id: "T1" });
    act(() => one.dispatchEvent(new Event("dragend", { bubbles: true })));
    expect(useConsole.getState().dragging).toBeNull();
    const d1 = screen.getByRole("article", { name: "Drone Drone 1" });
    act(() => d1.dispatchEvent(Object.assign(new Event("dragstart", { bubbles: true }), { dataTransfer })));
    expect(data[DRONE_DRAG]).toBe("D1");
  });
});

describe("Needs you: one question, the outcome on the button", () => {
  const teams = [team("T1", "Team One"), team("T2", "Team Two")];
  it("words each kind of proposal as a question and its outcome", () => {
    expect(proposalAsk(proposal({}), teams)).toEqual({ ask: "Send Team One to C2?", action: "Send Team One to C2" });
    expect(proposalAsk(proposal({}), teams, [], "T2").action).toBe("Send Team Two to C2"); // the team picked in Edit
    expect(proposalAsk(proposal({ kind: "drone_leg", target: { drone: "D1", sector: "B2" } }), teams, [drone("D1", "idle")]).action).toBe("Fly Drone 1 over B2");
    expect(proposalAsk(proposal({ kind: "promote_detection", target: { detection: "f0273-d02" } }), teams)).toEqual({ ask: "Put this photo in Review photos?", action: "Add it to Review photos" });
    expect(proposalAsk(proposal({ kind: "retask_drone", target: { drone: "D1", home: "base" } }), teams, [drone("D1", "flying")]).action).toBe("Bring Drone 1 home");
  });

  function needs(highlight: string | null = null) {
    const onDecide = vi.fn();
    render(
      <NeedsYou
        proposals={[proposal({ id: "p002", created_at: "2026-10-24T21:50:00Z", target: { team: "T2", sector: "B3" } }), proposal({})]}
        teams={[...teams, team("T3", "Team Three", "searching", "2026-10-24T21:20:00Z")]}
        drones={[]}
        events={[]}
        clues={[]}
        now={NOW}
        checkInMin={30}
        onDecide={onDecide}
        imageUrl={(r) => r}
        review={null}
        reviewCount={0}
        onCall={vi.fn()}
        onRecall={vi.fn()}
        onConfirmClue={vi.fn()}
        highlight={highlight}
      />,
    );
    return onDecide;
  }

  it("groups by kind, most urgent first: the overdue team, then the proposals oldest first; the button says the outcome", async () => {
    const onDecide = needs();
    const rail = screen.getByLabelText("Approvals rail");
    const heads = within(rail).getAllByRole("heading").map((h) => h.textContent);
    expect(heads[0]).toMatch(/^Teams not heard1/);
    expect(heads[1]).toMatch(/^AI suggestions2/);
    expect(within(rail).getByRole("article", { name: "Overdue Team Three" })).toHaveTextContent("Call Team Three");
    const cards = within(rail).getAllByLabelText(/^Proposal p00/);
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual(["Proposal p001", "Proposal p002"]);
    expect(cards[0]).toHaveTextContent("Send Team One to C2?");
    await userEvent.click(within(cards[0]!).getByRole("button", { name: /^Approve:\s*Send Team One to C2/ }));
    expect(onDecide).toHaveBeenCalledWith("p001", "approve", expect.any(String), undefined, undefined);
  });

  it("points at one item (the guided search): it is marked, the rest dimmed", () => {
    needs("p002");
    expect(screen.getByLabelText("Proposal p002")).toHaveAttribute("data-highlighted");
    expect(screen.getByLabelText("Proposal p001")).toHaveAttribute("data-dimmed");
    expect(screen.getByRole("article", { name: "Overdue Team Three" })).toHaveAttribute("data-dimmed");
    expect(screen.getByRole("article", { name: "Overdue Team Three" })).toHaveAttribute("data-need", "overdue-T3");
  });
});

describe("the AI second look, legible", () => {
  const v: Verdict = {
    id: "v0001", detection_id: "f0273-d02", tools: ["zoom_native"], relook_crops: ["relook/f0273-d02-zoom_native.jpg"], person: "yes", posture: "standing", group_size: 2,
    clothing: "red jacket", reason: "Two human figures are visible.", model: "nvidia/Nemotron-3.5-Super-VL", ms: 1733, at: "2026-10-23T02:03:38.488Z",
  };
  const card: ReviewCard = { id: "f0273-d02", conf: 0.173, crop: "/c.jpg", frame: "f0273", words: "Second look: likely a person", chips: ["OpenCV 5 zoom native", "Nemotron-3.5-Super-VL"], relook: [{ url: "/z.jpg", name: "relook/f0273-d02-zoom_native.jpg" }], ms: 1733, verdict: v, threshold: 0.29, detector: DETECTOR_CV2 };

  it("the verdict first, then each step with what it said, from the record only", () => {
    expect(verdictHead(v)).toEqual({ head: "Likely a person", tone: "found", details: ["2 people", "standing", "red jacket"] });
    expect(secondLookSteps(card)).toEqual([
      { who: "OpenCV 5 · cv2.dnn detector", said: "score 0.17, under 0.29 (photos scoring under 0.29 normally skip review)" },
      { who: "OpenCV 5 zoom", said: "cut the spot again from the full-resolution photo" },
      { who: "Nemotron-3.5-Super-VL", said: "yes, a person: “Two human figures are visible.”" },
    ]);
  });

  it("runs, then shows the headline, the crop beside the OpenCV 5 image, and the time", async () => {
    useSecondLook.getState().reset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<SecondLook c={card} large />);
    await userEvent.click(screen.getByRole("button", { name: SECOND_LOOK_LABEL }));
    act(() => vi.advanceTimersByTime(RUN_MAX_MS));
    const result = screen.getByLabelText("AI re-check result");
    expect(result).toHaveTextContent(/^Likely a person/);
    expect(result).toHaveTextContent("done in 1.7 s");
    expect(within(result).getByAltText("Detector crop of f0273-d02")).toBeInTheDocument();
    expect(within(result).getByText("OpenCV 5 zoom", { selector: "figcaption" })).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("credits the detector on the score: OpenCV 5 cv2.dnn for the pipeline, the browser path by its name, nothing claimed when unknown", () => {
    const { rerender } = render(<DetectorScore c={{ conf: 0.74, detector: DETECTOR_CV2 }} />);
    expect(screen.getByLabelText("OpenCV 5 · cv2.dnn detector score 0.74")).toBeInTheDocument();
    rerender(<DetectorScore c={{ conf: 0.74, detector: DETECTOR_BROWSER }} />);
    expect(screen.getByLabelText("ONNX Runtime Web detector score 0.74")).toBeInTheDocument();
    rerender(<DetectorScore c={{ conf: 0.15 }} />);
    expect(screen.getByLabelText("detector score 0.15")).not.toHaveTextContent("OpenCV");
  });
});
