// The Trace tab: chains from perception to approval, one line per step, and which model did what.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { TraceEntry } from "../contract";
import { loadDemoTrace } from "./demoMission";
import { chains, deciderOf, inputSummary, isPlannerCall, modelName, modelUse, outputSummary, parseTrace, plannedProposals, plannerRanked, roleOf, spanName, stageOf } from "./trace";
import { TraceView } from "./TraceView";

const entry = (over: Partial<TraceEntry>): TraceEntry => ({
  id: "t1", at: "2026-10-21T00:33:23.627Z", actor: "agent", kind: "note", summary: "", input: null, output: null,
  model: null, ms: null, tokens_in: null, tokens_out: null, refs: [], ...over,
});

describe("trace helpers", () => {
  it("reads the showcase chain as one chain, perception → decision → action → approval", async () => {
    const { runs } = await loadDemoTrace();
    const [, showcase, conditions] = runs; // the demo mission's own trace first
    expect(showcase!.entries).toHaveLength(6);
    const [c] = chains(showcase!.entries);
    expect(chains(showcase!.entries)).toHaveLength(1);
    expect(c!.stages).toEqual(["perception", "decision", "action", "approval"]);
    expect(c!.outcomes).toEqual([{ proposal: "p001", kind: "promote_detection", status: "approved", by: "Search manager (scripted approval for this demo run)", role: "Search manager", scripted: true }]);
    expect(c!.ms).toBe(1414); // the VL call; the verdict's own ms is not counted twice
    // the conditions lookup has no ids: its steps join on the actor
    expect(chains(conditions!.entries)).toHaveLength(1);
    expect(chains(conditions!.entries)[0]!.outcomes).toEqual([]);
  });

  it("names the decider by its role and the model by its name; the trace keeps its own strings", () => {
    expect(roleOf("Search manager (scripted for the demo fixture)")).toBe("Search manager");
    expect(roleOf("Image reviewer (scripted for the demo fixture)")).toBe("Image reviewer");
    expect(roleOf("Dana (IC)")).toBe("Dana (IC)");
    expect(modelName("fake/nvidia/Nemotron-3.5-Super-VL")).toBe("nvidia/Nemotron-3.5-Super-VL");
    expect(modelName("recorded/nvidia/Nemotron-3.5-Super-VL")).toBe("nvidia/Nemotron-3.5-Super-VL");
    // a recorded live answer is the model's own call; a fixture's stand-in is replayed, kept apart (judges 2026-10-23)
    const vl = (model: string) => entry({ kind: "model_call", actor: "verifier", model });
    expect(modelUse([vl("fake/nvidia/vl"), vl("recorded/nvidia/vl"), vl("nvidia/vl")]).models.map((m) => [m.model, m.calls, m.replayed])).toEqual([["nvidia/vl", 2, false], ["nvidia/vl", 1, true]]);
    const d = entry({ kind: "decision", actor: "human", output: { proposal: "p003", status: "approved", by: "Search manager (scripted for the demo fixture)" } });
    expect(spanName(d)).toBe("Search manager");
    expect(deciderOf(d)).toBe("Search manager");
    expect(d.output).toEqual({ proposal: "p003", status: "approved", by: "Search manager (scripted for the demo fixture)" });
    expect(spanName(entry({ kind: "model_call", actor: "agent", model: "fake/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B" }))).toBe("nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B");
  });

  it("says each step in one line", async () => {
    const { runs } = await loadDemoTrace();
    const [note, tool, model, verdict, proposal, decision] = runs[1]!.entries;
    expect(spanName(tool!)).toBe("zoom_native");
    expect(spanName(model!)).toBe("nvidia/Nemotron-3.5-Super-VL");
    expect(stageOf(model!)).toBe("perception"); // the VL model looks; the verdict decides
    expect(stageOf(verdict!)).toBe("decision");
    expect(inputSummary(model!)).toBe("prompt verify-v2 · 2 images · tools: zoom_native");
    expect(outputSummary(model!)).toMatch(/^person: yes · posture: lying/);
    expect(outputSummary(decision!)).toBe("p001 approved");
    expect(outputSummary(proposal!)).toMatch(/^p001 promote_detection: Detector confidence 0.18/);
    expect(inputSummary(note!)).toBe("photo train_ZRI_2061");
    const conditions = runs[2]!.entries;
    expect(spanName(conditions[0]!)).toBe("Tavily search (forecast)");
    expect(outputSummary(conditions[4]!)).toBe("wind_kmh 20 (“NW 20”) · gust_kmh 40 (“gusts 40”) · 0 alerts");
  });

  it("puts a planner tool_call under decision, with its ranking and the proposal it produced", async () => {
    const { runs } = await loadDemoTrace();
    const own = runs[0]!.entries;
    const planner = own.find((e) => e.id === "t000023")!;
    expect(isPlannerCall(planner)).toBe(true);
    expect(stageOf(planner)).toBe("decision");
    // a tool_call that only looks (an OpenCV zoom) stays perception
    expect(stageOf(runs[1]!.entries[1]!)).toBe("perception");
    // no "planner" actor, but a ranking and a choice: still the planner
    expect(stageOf(entry({ kind: "tool_call", actor: "agent", output: { ranked: [], chosen: [] } }))).toBe("decision");
    expect(plannerRanked(planner)!.map((r) => r.sector)).toEqual(["C2", "B2", "C3"]);
    expect(plannerRanked(entry({ kind: "tool_call", actor: "planner", output: { ranked: [{ sector: "B3", score_per_min: 0.02, evidence: "x" }], chosen: [] } }))).toEqual([
      { sector: "B3", score: 0.02, evidence: "x" },
    ]);
    expect(outputSummary(planner)).toBe("ranked C2 0.019, B2 0.017, C3 0.017");
    const chain = chains(own).find((c) => c.entries.includes(planner))!;
    expect(plannedProposals(chain.entries, planner).map((e) => e.id)).toEqual(["t000025"]);
    expect(chain.stages).toEqual(["perception", "decision", "action", "approval"]);
  });

  it("counts which model did what, and the tools", () => {
    const es = [
      entry({ id: "a", kind: "model_call", actor: "verifier", model: "nvidia/vl", ms: 1000, tokens_in: 10, tokens_out: 2 }),
      entry({ id: "b", kind: "model_call", actor: "verifier", model: "nvidia/vl", ms: 500, tokens_in: 5, tokens_out: 1 }),
      entry({ id: "c", kind: "model_call", actor: "conditions", model: "nvidia/nano", ms: 200 }),
      entry({ id: "d", kind: "tool_call", actor: "verifier", summary: "zoom_native on f1" }),
    ];
    const { models, tools } = modelUse(es);
    expect(models.map((m) => [m.model, m.calls, m.ms, m.tokensIn, m.tokensOut])).toEqual([["nvidia/vl", 2, 1500, 15, 3], ["nvidia/nano", 1, 200, 0, 0]]);
    expect(tools).toEqual([{ name: "zoom_native", calls: 1 }]);
  });

  it("skips a half-written last line", () => {
    expect(parseTrace('{"id":"t1","refs":[]}\n{"id":"t2"')).toHaveLength(1);
  });
});

describe("TraceView", () => {
  it("shows the model strip, the chain with its outcome, and a step's full input on demand", async () => {
    const { runs, imageUrl } = await loadDemoTrace();
    render(<TraceView runs={runs} imageUrl={imageUrl} />);
    const strip = screen.getByLabelText("Which model did what");
    expect(strip).toHaveTextContent("nvidia/Nemotron-3.5-Super-VL");
    expect(strip).toHaveTextContent("verifier: second look at a crop");
    expect(strip).toHaveTextContent("nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B");
    expect(strip).toHaveTextContent("Tavily search ×3");
    const chain = screen.getByRole("article", { name: "Chain f0001-d01 · v0001 · p001" });
    // the decider is shown as its role; the trace's own string (with its provenance) stays in the step's output
    const outcome = within(chain).getByText("p001 promote_detection → approved by Search manager");
    expect(outcome.closest("[data-tone]")).toHaveAttribute("data-tone", "ok");
    const approval = within(chain).getByRole("listitem", { name: "Approval t000006" });
    expect(approval).toHaveTextContent("Search manager");
    expect(strip).toHaveTextContent("10 decisions: 10 by Search manager"); // the demo mission's 9 and the showcase's 1
    await userEvent.click(within(approval).getByRole("button"));
    expect(approval).toHaveTextContent('"by": "Search manager (scripted approval for this demo run)"');
    const step = within(chain).getByRole("listitem", { name: "Model t000003" });
    expect(step).toHaveTextContent("1.4 s");
    await userEvent.click(within(step).getByRole("button"));
    expect(within(step).getAllByRole("img")).toHaveLength(2); // the crop and the zoom it looked at
    expect(step).toHaveTextContent('"prompt": "verify-v2"');
    // the runs say which flight, not how they were made: this one, and two earlier runs
    expect(screen.getAllByText("This flight")).toHaveLength(3); // the run's chip and its two models, each called on Token Factory
    expect(within(strip).queryAllByText("Replayed")).toHaveLength(0); // the fixture has no stand-in left (make_command_fixtures.py --live)
    expect(strip).not.toHaveTextContent("no timing (replayed)");
    expect(within(strip).getByLabelText("Model calls in this mission")).toHaveTextContent(/^\d+ Nemotron calls on Nebius Token Factory in this mission · \d+\.\d s in all$/);
    expect(screen.getAllByText("Earlier run")).toHaveLength(4); // two runs' chips and their two models
    expect(screen.queryByText("Recorded")).toBeNull();
    // a model is named by the model: the trace's `recorded/` id stays in the data
    const models = within(strip).getAllByRole("listitem");
    expect(models.map((li) => [li.getAttribute("data-run"), li.querySelector("span span")!.textContent])).toEqual([
      ["This flight", "nvidia/Nemotron-3.5-Super-VL"],
      ["This flight", "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"],
      ["Earlier run", "nvidia/Nemotron-3.5-Super-VL"],
      ["Earlier run", "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"],
    ]);
    expect(strip).not.toHaveTextContent(/fake\/|scripted|simulated|recorded/i);
  });

  it("says so when there is nothing yet", () => {
    render(<TraceView runs={[{ label: null, source: null, entries: [] }]} />);
    expect(screen.getByLabelText("Trace")).toHaveTextContent("No trace yet.");
  });

  it("shows a planner step under Decision with its top three sectors and a link to the proposal it produced", async () => {
    const { runs } = await loadDemoTrace();
    render(<TraceView runs={runs} />);
    const step = screen.getByRole("listitem", { name: "Tool t000023" });
    expect(step).toHaveTextContent("Decision");
    const ranked = within(step).getAllByRole("listitem");
    expect(ranked.map((li) => li.getAttribute("data-sector"))).toEqual(["C2", "B2", "C3"]);
    expect(ranked[0]).toHaveTextContent("1. C2 score 0.0192: C2 · 3.5 % of remaining probability, up from 1.9 %: c001");
    const link = within(step).getByRole("link", { name: "p002" });
    const target = document.getElementById(link.getAttribute("href")!.slice(1));
    expect(target).toHaveAttribute("aria-label", "Proposal t000025");
  });

  it('never says "clear"', async () => {
    const { runs } = await loadDemoTrace();
    render(<TraceView runs={runs} />);
    expect(document.body.textContent).not.toMatch(/\bclear(s|ed|ing)?\b/i);
  });
});

// A re-look chain with its ledger (docs/architecture/agent.md: `note` entries whose output.type is
// "ledger" or "relook", the chain id in refs), built from that schema.
describe("ledger and re-look chains", () => {
  const load = async () => parseTrace((await import("./__fixtures__/trace_relook.jsonl?raw")).default);

  it("groups the re-look steps and the ledger records on their chain", async () => {
    const cs = chains(await load());
    expect(cs).toHaveLength(2); // the re-look chain and an unrelated lookup
    const [c, other] = cs;
    expect(c!.relook.map((r) => r.step)).toEqual(["unclear", "leg", "photo", "verdict", "outcome"]);
    expect(c!.relook.map((r) => r.words)).toEqual([
      "unclear: 21 px from 50 m",
      "L004 by D3 at 25 m, 4× pixels",
      "photo f0002 from 25 m: f0002-d01, 43 px",
      "v0002: person yes",
      "outcome: resolved",
    ]);
    expect(c!.ledger.map((l) => [l.kind, l.ref, l.expected, l.realised, l.delta])).toEqual([
      ["second_look", "f0001-d01", 0.4933, 0, -0.4933],
      ["second_look", "f0002-d01", 0.4933, 1, 0.5067],
      ["leg", "L004", 0.000097, 0.000051, -0.000046],
    ]);
    expect(c!.outcomes.map((o) => [o.proposal, o.status])).toEqual([
      ["p004", "approved"],
      ["p005", null],
    ]);
    expect(other!.ledger).toEqual([]);
    expect(other!.relook).toEqual([]);
  });

  it("a ledger note joins its chain by the chain id in its output, even with no refs", () => {
    const es = [
      entry({ id: "a", kind: "verdict", actor: "verifier", refs: ["d1", "v1"] }),
      entry({ id: "b", kind: "note", actor: "agent", refs: ["relook-d1", "d1"], output: { type: "relook", chain_id: "relook-d1", step: "skipped", why: "no drone is idle or flying" } }),
      entry({ id: "c", kind: "note", actor: "pipeline", refs: [], output: { type: "ledger", chain_id: "relook-d1", kind: "second_look", ref: "d1", expected: { gain: 0.7 }, realised: { gain: 1 }, delta: 0.3 } }),
    ];
    const cs = chains(es);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.relook[0]!.words).toBe("no leg: no drone is idle or flying");
    expect(cs[0]!.ledger[0]!.delta).toBe(0.3);
  });

  it("shows each ledger record as a two-number chip and the re-look as a chain with its model chips", async () => {
    render(<TraceView runs={[{ label: null, source: null, entries: await load() }]} />);
    const [other, chain] = screen.getAllByRole("article"); // the latest chain on top
    expect(chain).toHaveAccessibleName(/^Chain f0001-d01 · v0001 · relook-f0001-d01 · /);
    const ledger = within(chain!).getByLabelText("Ledger");
    expect([...ledger.querySelectorAll("[data-ledger]")].map((c) => c.textContent)).toEqual([
      "second look f0001-d01expected 0.493 → realised 0(Δ −0.493)",
      "second look f0002-d01expected 0.493 → realised 1(Δ +0.507)",
      "leg L004expected 0.000097 → realised 0.000051(Δ −0.000046)",
    ]);
    const relook = within(chain!).getByLabelText("Re-look relook-f0001-d01");
    expect([...relook.querySelectorAll("[data-step]")].map((s) => s.getAttribute("data-step"))).toEqual(["unclear", "leg", "photo", "verdict", "outcome"]);
    expect(within(relook).getByLabelText("Models")).toHaveTextContent("Nemotron-3.5-Super-VL");
    expect(within(relook).getByLabelText("Models")).toHaveTextContent("zoom_native");
    // the other kinds keep their own lines: every step is still listed, the notes among them
    expect(within(chain!).getAllByRole("listitem", { name: /^Note / })).toHaveLength(9);
    expect(within(chain!).getByRole("listitem", { name: "Approval t000009" })).toBeInTheDocument();
    expect(within(chain!).getByText("p004 retask_drone → approved by Dana")).toHaveAttribute("data-tone", "ok");
    // the unrelated chain has neither row
    expect(within(other!).queryByLabelText("Ledger")).toBeNull();
    expect(within(other!).queryByLabelText(/^Re-look/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/\bclear(s|ed|ing)?\b/i);
  });
});
