// The AI items name their model and where it ran, from the mission's own record of its calls; the fixtures'
// calls are real Nemotron calls on Nebius Token Factory, with measured times, and the trace says the same.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Proposal, Team } from "../contract";
import type { ModelCall } from "../lib/fixtureExtras";
import { useMission } from "../lib/mission";
import { SecondLook, useSecondLook } from "../review/SecondLook";
import { ApprovalInbox } from "./ApprovalInbox";
import { SECOND_LOOK_ID, secondLookCard } from "./demoReview";
import demo from "./__fixtures__/demo_mission.json";
import trace from "./__fixtures__/demo_trace.jsonl?raw";
import { callCountWords, modelWords, ModelSource, onTokenFactory, proposalCall, sourceLine, tokenFactoryUse, traceTokenFactoryUse, verdictCall } from "./nebius";
import { parseTrace } from "./trace";
import { missionCallLine, TraceView } from "./TraceView";

const FIX = join(__dirname, "__fixtures__");
const calls = (demo as unknown as { model_calls: ModelCall[] }).model_calls;
const scenarios = readdirSync(join(FIX, "scenarios")).map((f) => [f, JSON.parse(readFileSync(join(FIX, "scenarios", f), "utf8")) as { model_calls?: ModelCall[]; proposals: Proposal[] }] as const);

describe("where the AI ran", () => {
  it("names the Nemotron models as people read them", () => {
    expect(modelWords("nvidia/Nemotron-3.5-Super-VL")).toBe("Nemotron 3.5 Super VL");
    expect(modelWords("recorded/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B")).toBe("Nemotron 3 Nano");
    expect(modelWords("nvidia/nemotron-3-super-120b-a12b")).toBe("Nemotron 3 Super");
    expect(modelWords("nvidia/Nemotron-3_5-Lightning")).toBe("Nemotron 3.5 Lightning");
    expect(sourceLine("recorded/nvidia/Nemotron-3.5-Super-VL", 1723)).toBe("Nemotron 3.5 Super VL · Nebius Token Factory · 1.7 s");
    expect(sourceLine("nvidia/Nemotron-3.5-Super-VL")).toBe("Nemotron 3.5 Super VL · Nebius Token Factory");
    expect(callCountWords(1)).toBe("1 Nemotron call on Nebius Token Factory in this mission");
  });

  it("never credits Token Factory with a stand-in", () => {
    expect(onTokenFactory("fake/nvidia/Nemotron-3.5-Super-VL")).toBe(false);
    expect(onTokenFactory("recorded/nvidia/Nemotron-3.5-Super-VL")).toBe(true);
    expect(onTokenFactory(null)).toBe(false);
    expect(tokenFactoryUse([{ model: "fake/nvidia/x-nemotron", ms: 0 }, { model: "nvidia/Nemotron-3.5-Super-VL", ms: 1200 }])).toEqual({ calls: 1, ms: 1200 });
  });

  it("finds the call behind a proposal: the briefing word for word, or the second look a promotion rests on", () => {
    const p = (demo.proposals as unknown as Proposal[]).filter((x) => x.kind === "assign_sector");
    for (const x of p) expect(proposalCall(calls, x)?.text).toBe(x.briefing);
    expect(proposalCall(calls, { ...p[0]!, briefing: `${p[0]!.briefing} (edited)` })).toBeNull();
    const promote = (demo.proposals as unknown as Proposal[]).find((x) => x.kind === "promote_detection")!;
    expect(proposalCall(calls, promote)).toBe(verdictCall(calls, promote.target.detection!));
    expect(proposalCall(undefined, promote)).toBeNull();
  });
});

describe("the fixtures' model calls", () => {
  it("are real Nemotron calls on Token Factory, each with its measured time, tokens and answer", () => {
    for (const [name, fx] of [["demo_mission.json", demo as unknown as { model_calls?: ModelCall[] }] as const, ...scenarios]) {
      expect(fx.model_calls?.length, name).toBeGreaterThan(0);
      for (const c of fx.model_calls ?? []) {
        expect(onTokenFactory(c.model), `${name} ${c.model}`).toBe(true);
        expect(c.ms, name).toBeGreaterThan(0);
        expect(c.tokens_in + c.tokens_out, name).toBeGreaterThan(0);
        expect(c.text.length, name).toBeGreaterThan(0);
        expect(c.called_at, name).toMatch(/^\d{4}-\d\d-\d\dT/);
      }
    }
  });

  it("every briefing in a fixture is the model's own words, on record", () => {
    for (const [name, fx] of [["demo_mission.json", demo as unknown as { model_calls?: ModelCall[]; proposals: Proposal[] }] as const, ...scenarios])
      for (const p of fx.proposals.filter((x) => x.briefing)) expect(proposalCall(fx.model_calls, p), `${name} ${p.id}`).not.toBeNull();
  });

  it("match the story's trace: every model call in it is one of them, none a stand-in", () => {
    const entries = parseTrace(trace);
    const modelCalls = entries.filter((e) => e.kind === "model_call");
    expect(modelCalls.every((e) => e.model?.startsWith("recorded/"))).toBe(true);
    expect(traceTokenFactoryUse(entries)).toEqual(tokenFactoryUse(calls));
    expect(modelCalls.map((e) => (e.output as { text: string }).text)).toEqual(calls.map((c) => c.text));
  });

  it("are counted in the Trace view's strip, from the mission's own record", () => {
    const entries = parseTrace(trace);
    const runs = [{ label: "This mission's trace", source: null, mode: "demo" as const, entries }];
    const { calls: n, ms } = tokenFactoryUse(calls);
    const line = `${n} Nemotron calls on Nebius Token Factory in this mission · ${(ms / 1000).toFixed(1)} s in all`;
    expect(missionCallLine(runs)).toBe(line);
    expect(missionCallLine([{ ...runs[0]!, mode: "replay" as const }])).toBeNull(); // an earlier run is not this mission
    render(<TraceView runs={runs} missionCalls={calls} />);
    expect(screen.getByLabelText("Model calls in this mission")).toHaveTextContent(line);
  });

  it("show as one small line under the AI item", () => {
    render(<ModelSource lead="Briefing by" model="recorded/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B" ms={2081} />);
    expect(screen.getByText("Briefing by Nemotron 3 Nano · Nebius Token Factory · 2.1 s")).toBeInTheDocument();
  });
});

describe("the AI items on screen", () => {
  afterEach(() => {
    cleanup();
    useMission.setState({ model_calls: [] });
    useSecondLook.getState().reset();
  });
  const props = demo.proposals as unknown as Proposal[];
  const teams = (demo.teams as unknown as Team[]).map((t) => ({ ...t, status: "standby" as const }));

  it("a suggestion card's briefing names the model that wrote it, while it is the model's words", () => {
    useMission.setState({ model_calls: calls });
    const assign = { ...props.find((x) => x.kind === "assign_sector")!, status: "pending" as const };
    const call = proposalCall(calls, assign)!;
    render(<ApprovalInbox proposals={[assign]} teams={teams} onDecide={vi.fn()} imageUrl={(r) => r} />);
    expect(screen.getByText(`Briefing by ${sourceLine(call.model, call.ms)}`)).toBeInTheDocument();
  });

  it("a promotion card and the AI re-check name the VL model and the call's time", () => {
    useMission.setState({ model_calls: calls });
    const promote = props.find((x) => x.kind === "promote_detection")!;
    const call = verdictCall(calls, promote.target.detection!)!;
    render(<ApprovalInbox proposals={[promote]} teams={teams} onDecide={vi.fn()} imageUrl={(r) => r} />);
    expect(screen.getByText(sourceLine(call.model, call.ms))).toBeInTheDocument();
    cleanup();
    useSecondLook.setState({ runs: { [SECOND_LOOK_ID]: { stage: "done" } } });
    render(<SecondLook c={secondLookCard()} large />);
    expect(screen.getByText("Nemotron 3.5 Super VL · Nebius Token Factory · 1.7 s")).toBeInTheDocument();
  });

  it("with no call on record, no line (and never a time it does not have)", () => {
    const promote = props.find((x) => x.kind === "promote_detection")!;
    render(<ApprovalInbox proposals={[promote]} teams={teams} onDecide={vi.fn()} imageUrl={(r) => r} />);
    expect(screen.queryByText(/Nebius Token Factory/)).toBeNull();
  });
});
