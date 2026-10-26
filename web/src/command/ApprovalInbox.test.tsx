// LANE_E §9 test 4: the proposals in Needs you. Reject needs a reason; edits go with the approval; decided
// proposals leave for the timeline; keys act on the focused card only.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Drone, Proposal, Team } from "../contract";
import { ApprovalInbox, recallSummary } from "./ApprovalInbox";

const AT = "2026-10-24T21:40:00Z";
const p = (over: Partial<Proposal>): Proposal => ({
  id: "p001", kind: "assign_sector", summary: "Assign sector B3 to Team One", reason: "Sector B3 holds 6.9% of the probability.",
  briefing: "Team One, search sector B3.", target: { team: "T1", sector: "B3" }, evidence: [], status: "pending",
  created_by: "agent", created_at: AT, decided_at: null, decided_by: null, decision_reason: null, edits: null, ...over,
});
const team = (id: string, callsign: string): Team => ({ id, callsign, members: 3, status: "standby", position: null, position_at: null, note: null });
const TEAMS = [team("T1", "Team One"), team("T2", "Team Two")];

function setup(proposals: Proposal[]) {
  const onDecide = vi.fn();
  render(<ApprovalInbox proposals={proposals} teams={TEAMS} onDecide={onDecide} imageUrl={(r) => `/f/${r}`} />);
  return onDecide;
}

beforeEach(() => sessionStorage.clear());

describe("ApprovalInbox", () => {
  it("lists pending proposals newest first, with the evidence", () => {
    setup([
      p({ id: "p001", created_at: "2026-10-24T21:40:00Z" }),
      p({ id: "p002", kind: "retask_drone", summary: "Re-task Drone 1 to sector B3", briefing: null, created_by: "planner", created_at: "2026-10-24T21:45:00Z",
          evidence: [{ kind: "crop", ref: "crops/f0005-d01.jpg", caption: "photo f0005" }, { kind: "leg", ref: "L002", caption: "lawnmower" }] }),
    ]);
    const cards = screen.getAllByLabelText(/^Proposal p00/);
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual(["Proposal p002", "Proposal p001"]);
    expect(within(cards[0]!).getByAltText("photo 5")).toHaveAttribute("src", "/f/crops/f0005-d01.jpg");
    // the ids wait under "details" (the Trace has them too)
    expect(within(cards[0]!).getByText(/leg L002/).closest("details")).not.toBeNull();
    expect(within(cards[0]!).getByText("Send Drone 1 elsewhere, to sector B3")).toBeInTheDocument();
    expect(within(cards[1]!).getByText("or do it yourself: click B3 on the map")).toBeInTheDocument();
  });

  it("approves as the console's one name (no name field on the card)", async () => {
    sessionStorage.setItem("sightline.operator", "Dana");
    const onDecide = setup([p({})]);
    expect(screen.queryByLabelText("Your name")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Approve/ }));
    expect(onDecide).toHaveBeenCalledWith("p001", "approve", "Dana", undefined, undefined);
  });

  it("shows a short reason whole; a long one two lines and a visible link for the rest (nothing folded behind a click)", async () => {
    setup([p({ reason: "Sector B3 holds 6.9% of the probability." })]);
    expect(screen.getByText("Sector B3 holds 6.9% of the probability.").className).not.toMatch(/line-clamp/);
    expect(screen.queryByRole("button", { name: "Show the whole reason" })).toBeNull();
    cleanup();
    setup([p({ reason: `Sector B3 holds 6.9% of the probability. ${"A long second sentence the card shows in part. ".repeat(4)}` })]);
    const why = screen.getByText(/Sector B3 holds/);
    expect(why.className).toMatch(/line-clamp-2/);
    await userEvent.click(screen.getByRole("button", { name: "Show the whole reason" }));
    expect(why.className).not.toMatch(/line-clamp/);
  });

  it("a rejection needs a reason", async () => {
    const onDecide = setup([p({})]);
    await userEvent.click(screen.getByRole("button", { name: /Reject/ }));
    const submit = screen.getByRole("button", { name: "Reject" });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Why reject"), "Team One is on a break");
    await userEvent.click(submit);
    expect(onDecide).toHaveBeenCalledWith("p001", "reject", "Search manager", "Team One is on a break");
  });

  it("edits the team and the briefing before approving", async () => {
    const onDecide = setup([p({})]);
    await userEvent.click(screen.getByRole("button", { name: /^Edit/ }));
    await userEvent.selectOptions(screen.getByLabelText("Team"), "T2");
    const text = screen.getByLabelText(/Briefing/);
    await userEvent.clear(text);
    await userEvent.type(text, "Team Two, search sector B3 from the east ridge.");
    await userEvent.click(screen.getByRole("button", { name: /Approve/ }));
    expect(onDecide).toHaveBeenCalledWith("p001", "approve", "Search manager", undefined, {
      team: "T2", briefing: "Team Two, search sector B3 from the east ridge.",
    });
  });

  it("keys act on the focused card only, never while typing", async () => {
    const onDecide = setup([p({ id: "p001" }), p({ id: "p002", created_at: "2026-10-24T21:41:00Z" })]);
    fireEvent.keyDown(screen.getByLabelText("Proposal p001"), { key: "a" });
    expect(onDecide).toHaveBeenCalledWith("p001", "approve", "Search manager", undefined, undefined);
    fireEvent.keyDown(screen.getByLabelText("Proposal p002"), { key: "e" }); // E: edit
    fireEvent.keyDown(screen.getByLabelText(/Briefing/), { key: "a" });
    expect(onDecide).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByLabelText("Proposal p002"), { key: "x" });
    expect(screen.getByLabelText("Why reject")).toBeInTheDocument();
  });

  it("after an approval, brings the next pending card to the top of the rail and focuses it", async () => {
    // jsdom has no layout: the rail scrolls (1000 px in 300), its top at 100 px; the next card's top is at 340 px
    const rect = (top: number) => ({ top, bottom: top + 200, left: 0, right: 300, width: 300, height: 200, x: 0, y: top, toJSON: () => ({}) });
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return rect(this.getAttribute("aria-label") === "Approvals rail" ? 100 : this.getAttribute("aria-label") === "Proposal p001" ? 340 : 0);
    });
    function Rail() {
      const [list, setList] = useState([p({ id: "p001", created_at: "2026-10-24T21:40:00Z" }), p({ id: "p002", created_at: "2026-10-24T21:45:00Z" })]);
      return (
        <div aria-label="Approvals rail" style={{ overflowY: "auto" }}>
          <ApprovalInbox
            proposals={list}
            teams={TEAMS}
            onDecide={(pid) => setList((l) => l.map((x) => (x.id === pid ? { ...x, status: "approved" as const } : x)))}
            imageUrl={(r) => r}
          />
        </div>
      );
    }
    render(<Rail />);
    const rail = screen.getByLabelText("Approvals rail");
    let top = 120; // scrolled down into p002's card
    Object.defineProperty(rail, "scrollHeight", { value: 1000 });
    Object.defineProperty(rail, "clientHeight", { value: 300 });
    Object.defineProperty(rail, "scrollTop", { get: () => top, set: (v: number) => void (top = v) });
    await userEvent.click(within(screen.getByLabelText("Proposal p002")).getByRole("button", { name: /Approve/ }));
    expect(screen.queryByLabelText("Proposal p002")).toBeNull();
    expect(top).toBe(120 + 240); // p001's top now meets the rail's top
    expect(document.activeElement).toBe(screen.getByLabelText("Proposal p001")); // A and X act on it next
    spy.mockRestore();
  });

  it("with nothing waiting, says what will appear and links the feed", () => {
    render(<ApprovalInbox proposals={[]} teams={TEAMS} onDecide={vi.fn()} imageUrl={(r) => r} feedHref="#m/demo/feed" />);
    const empty = screen.getByLabelText("Nothing waiting");
    expect(empty).toHaveTextContent("No proposals waiting.");
    expect(within(empty).getByRole("link", { name: "See what the agent is doing in the feed" })).toHaveAttribute("href", "#m/demo/feed");
  });

  it("decided proposals leave Needs you (the timeline says who decided and when)", () => {
    setup([
      p({ id: "p001", status: "approved", decided_by: "Dana", decided_at: AT }),
      p({ id: "p002", status: "rejected", decided_by: "Dana", decided_at: AT, decision_reason: "duplicate" }),
    ]);
    expect(screen.queryByLabelText(/^Proposal p00/)).toBeNull();
    expect(screen.queryByRole("link", { name: /feed/ })).toBeNull(); // no feed to link to
  });

  it('never says "clear"', () => {
    setup([p({})]);
    expect(document.body.textContent).not.toMatch(/\bclear(s|ed|ing)?\b/i);
  });
});

describe("a recall", () => {
  const URL = "https://weather.gc.ca/forecast/hourly/bc-74_metric_e.html";
  const QUOTE = "Wind southeast 30 km/h gusting to 50";
  const recall = (ref: string, caption: string) =>
    p({
      id: "p007", kind: "retask_drone", summary: "Recall Drone 2: fly home now (leaves sector C3, battery 62%)", briefing: null,
      reason: `Gusts 50 km/h ("${QUOTE}", weather.gc.ca, as of 20:05 UTC) > DJI Mavic 3E limit 43 km/h. Recall Drone 2 to its launch point, 2 min away.`,
      target: { drone: "D2", leg: "L009", home: "recall" },
      evidence: [{ kind: "conditions", ref, caption }, { kind: "leg", ref: "L009", caption: "home to the launch point" }],
    });
  const D2: Drone = { id: "D2", name: "Drone 2", simulated: true, position: { lat: 49.37712, lon: -122.93601 }, altitude_m: 50, speed_ms: 8,
    battery_pct: 62.4, max_wind_kmh: 43.2, status: "flying", leg_id: "L003" };

  it("shows the quoted fact, its page, and the drone's battery and position", async () => {
    const onDecide = vi.fn();
    render(<ApprovalInbox proposals={[recall(URL, QUOTE)]} teams={TEAMS} drones={[D2]} onDecide={onDecide} imageUrl={(r) => r} />);
    const card = screen.getByLabelText("Proposal p007");
    expect(within(card).getByText("Recall drone")).toBeInTheDocument();
    const why = within(card).getByLabelText("Why recall");
    expect(within(why).getByText(QUOTE).tagName).toBe("Q");
    expect(within(why).getByRole("link", { name: /weather\.gc\.ca/ })).toHaveAttribute("href", URL);
    expect(why).toHaveTextContent("Drone 2 now: battery 62%, flying at 49.37712, -122.93601");
    expect(within(card).queryByText("leg L009")).toBeNull(); // the facts block replaces the chips
    await userEvent.click(within(card).getByRole("button", { name: /Approve/ }));
    expect(onDecide).toHaveBeenCalledWith("p007", "approve", "Search manager", undefined, undefined);
    expect(document.body.textContent).not.toMatch(/\bclear(s|ed|ing)?\b/i);
  });

  it("labels the summary's battery 'at proposal' and puts the fleet's live value beside it", () => {
    const at97 = { ...recall(URL, QUOTE), summary: "Recall Drone 2: fly home now (leaves sector C3, battery 97%)" };
    render(<ApprovalInbox proposals={[at97]} teams={TEAMS} drones={[{ ...D2, battery_pct: 95.2 }]} onDecide={vi.fn()} imageUrl={(r) => r} />);
    const card = screen.getByLabelText("Proposal p007");
    expect(within(card).getByText("Recall Drone 2: fly home now (leaves sector C3, battery 97% at proposal, now 95%)")).toBeInTheDocument();
    expect(within(card).getByLabelText("Why recall")).toHaveTextContent("Drone 2 now: battery 95%");
    expect(recallSummary("Recall Drone 2: fly home now (battery 97%)")).toBe("Recall Drone 2: fly home now (battery 97% at proposal)");
  });

  it("says a demo override is not from Tavily, with no link", () => {
    render(<ApprovalInbox proposals={[recall("override (demo)", "gusts 50 km/h (override (demo), not from Tavily)")]} teams={TEAMS} onDecide={vi.fn()} imageUrl={(r) => r} />);
    const why = screen.getByLabelText("Why recall");
    expect(within(why).getByText("Demo override: not from Tavily")).toBeInTheDocument();
    expect(within(why).queryByRole("link")).toBeNull();
    expect(within(why).getByText("gusts 50 km/h")).toBeInTheDocument();
  });

  it("an ordinary re-task is still a re-task", () => {
    setup([p({ id: "p008", kind: "retask_drone", target: { drone: "D1", leg: "L002" }, briefing: null })]);
    expect(screen.getByText("Drone sent elsewhere")).toBeInTheDocument();
    expect(screen.queryByLabelText("Why recall")).toBeNull();
  });

  it("an assignment's card says which clues moved its sector, from the map log; other kinds don't", () => {
    const note = vi.fn((x: Proposal) => (x.target.sector === "B3" ? "c003 (blue water bottle) raised B3 from 3.1 % to 3.9 %" : null));
    render(
      <ApprovalInbox
        proposals={[p({ id: "p001" }), p({ id: "p002", kind: "promote_detection", target: { detection: "f0001-d01" }, created_at: "2026-10-24T21:41:00Z" })]}
        teams={TEAMS}
        onDecide={vi.fn()}
        imageUrl={(r) => r}
        clueNote={note}
      />,
    );
    expect(within(screen.getByLabelText("Proposal p001")).getByLabelText("Clues behind it")).toHaveTextContent(
      "Clues behind it, from the map log: “blue water bottle” raised B3 from 3.1 % to 3.9 %.",
    );
    expect(within(screen.getByLabelText("Proposal p002")).queryByLabelText("Clues behind it")).toBeNull();
  });

  it("no clue line when the reason already names its clues (the planner's evidence format)", () => {
    const note = vi.fn(() => "c003 (blue water bottle) raised B3 from 3.1 % to 3.9 %");
    const reason = "B3 · 3.9 % of remaining probability, up from 3.1 %: c003 (blue water bottle by the…) raised it; a ground team adds the most here.";
    render(<ApprovalInbox proposals={[p({ id: "p001", reason })]} teams={TEAMS} onDecide={vi.fn()} imageUrl={(r) => r} clueNote={note} />);
    const card = screen.getByLabelText("Proposal p001");
    expect(within(card).queryByLabelText("Clues behind it")).toBeNull();
    expect(card).toHaveTextContent("“blue water bottle by the…” raised it");
  });
});
