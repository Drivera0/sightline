// The Trace tab: chains from perception to approval, one line per step, and which model did what.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { TraceEntry } from "../contract";
import { loadDemoTrace } from "./demoMission";
import { chains, inputSummary, modelUse, outputSummary, parseTrace, spanName, stageOf } from "./trace";
import { TraceView } from "./TraceView";

const entry = (over: Partial<TraceEntry>): TraceEntry => ({
  id: "t1", at: "2026-10-21T00:33:23.627Z", actor: "agent", kind: "note", summary: "", input: null, output: null,
  model: null, ms: null, tokens_in: null, tokens_out: null, refs: [], ...over,
});

describe("trace helpers", () => {
  it("reads the showcase chain as one chain, perception → decision → action → approval", async () => {
    const { runs } = await loadDemoTrace();
    const [showcase, conditions] = runs;
    expect(showcase!.entries).toHaveLength(6);
    const [c] = chains(showcase!.entries);
    expect(chains(showcase!.entries)).toHaveLength(1);
    expect(c!.stages).toEqual(["perception", "decision", "action", "approval"]);
    expect(c!.outcomes).toEqual([{ proposal: "p001", kind: "promote_detection", status: "approved", by: "Search manager (scripted approval for this demo run)", scripted: true }]);
    expect(c!.ms).toBe(1414); // the VL call; the verdict's own ms is not counted twice
    // the conditions lookup has no ids: its steps join on the actor
    expect(chains(conditions!.entries)).toHaveLength(1);
    expect(chains(conditions!.entries)[0]!.outcomes).toEqual([]);
  });

  it("says each step in one line", async () => {
    const { runs } = await loadDemoTrace();
    const [note, tool, model, verdict, proposal, decision] = runs[0]!.entries;
    expect(spanName(tool!)).toBe("zoom_native");
    expect(spanName(model!)).toBe("nvidia/Nemotron-3.5-Super-VL");
    expect(stageOf(model!)).toBe("perception"); // the VL model looks; the verdict decides
    expect(stageOf(verdict!)).toBe("decision");
    expect(inputSummary(model!)).toBe("prompt verify-v2 · 2 images · tools: zoom_native");
    expect(outputSummary(model!)).toMatch(/^person: yes · posture: lying/);
    expect(outputSummary(decision!)).toBe("p001 approved");
    expect(outputSummary(proposal!)).toMatch(/^p001 promote_detection: Detector confidence 0.18/);
    expect(inputSummary(note!)).toBe("photo train_ZRI_2061");
    const conditions = runs[1]!.entries;
    expect(spanName(conditions[0]!)).toBe("Tavily search (forecast)");
    expect(outputSummary(conditions[4]!)).toBe("wind_kmh 20 (“NW 20”) · gust_kmh 40 (“gusts 40”) · 0 alerts");
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
    // the showcase approval was scripted: amber, and it says so; it never reads as a person's decision
    const outcome = within(chain).getByText(/p001 promote_detection → approved by a script, not a person/);
    expect(outcome.closest("[data-tone]")).toHaveAttribute("data-tone", "caution");
    expect(within(chain).getByRole("listitem", { name: "Approval t000006" }).querySelector("[data-tone]")).toHaveAttribute("data-tone", "caution");
    expect(strip).toHaveTextContent("0 decided by a person · 1 scripted approval (demo run)");
    const step = within(chain).getByRole("listitem", { name: "Model t000003" });
    expect(step).toHaveTextContent("1.4 s");
    await userEvent.click(within(step).getByRole("button"));
    expect(within(step).getAllByRole("img")).toHaveLength(2); // the crop and the zoom it looked at
    expect(step).toHaveTextContent('"prompt": "verify-v2"');
    expect(screen.getAllByText("Recorded")).toHaveLength(2);
  });

  it("says so when there is nothing yet", () => {
    render(<TraceView runs={[{ label: null, source: null, entries: [] }]} />);
    expect(screen.getByLabelText("Trace")).toHaveTextContent("No trace yet.");
  });

  it('never says "clear"', async () => {
    const { runs } = await loadDemoTrace();
    render(<TraceView runs={runs} />);
    expect(document.body.textContent).not.toMatch(/\bclear(s|ed|ing)?\b/i);
  });
});
