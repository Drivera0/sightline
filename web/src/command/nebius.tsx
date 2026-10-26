// Where the AI acts, which model it was and where it ran: each AI item (a suggestion card, the AI re-check's
// verdict, a radio briefing) carries one small line, "Nemotron 3.5 Super VL · Nebius Token Factory · 1.7 s",
// from the mission's own record of its model calls (`fixture.model_calls`, scripts/make_command_fixtures.py
// --live: every call made on Nebius Token Factory and kept word for word, with its measured time). Nothing
// here is invented: an item with no call on record gets no time, and a stand-in model gets no line. Built by
// lane A.
import type { Proposal, TraceEntry } from "../contract";
import type { ModelCall } from "../lib/fixtureExtras";

export const TOKEN_FACTORY = "Nebius Token Factory";

/** A Nemotron model id as people read it: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B" → "Nemotron 3 Nano". */
export function modelWords(model: string): string {
  const id = (model.replace(/^(?:fake|recorded)\//, "").split("/").at(-1) ?? model).replace(/^NVIDIA-/i, "");
  return id
    .split("-")
    .filter((p) => p && !/^a?\d+b$/i.test(p)) // the parameter counts (30B, A3B, 120b)
    .map((p) => p.replace(/^(\d+)_(\d+)$/, "$1.$2"))
    .map((p) => (/^vl$/i.test(p) ? "VL" : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(" ");
}

/** A model call made on Nebius Token Factory: a Nemotron model, never a fixture's stand-in (`fake/`). */
export const onTokenFactory = (model: string | null | undefined): model is string => !!model && !/^fake\//.test(model) && /nemotron/i.test(model);

/** "1.7 s": the call's measured time. */
export const callSeconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** The source line: "Nemotron 3.5 Super VL · Nebius Token Factory · 1.7 s" (no time when none is on record). */
export function sourceLine(model: string, ms?: number | null): string {
  return [modelWords(model), TOKEN_FACTORY, ms ? callSeconds(ms) : null].filter(Boolean).join(" · ");
}

/** The second look's call on a detection (the last one: a reply that was not JSON is asked again). */
export function verdictCall(calls: readonly ModelCall[] | undefined, detection: string): ModelCall | null {
  return calls?.filter((c) => c.kind === "vl" && c.detection === detection).at(-1) ?? null;
}

/** The call behind a proposal: the briefing it carries, word for word, or the second look a promotion rests on. */
export function proposalCall(calls: readonly ModelCall[] | undefined, p: Pick<Proposal, "id" | "kind" | "briefing" | "target">): ModelCall | null {
  if (!calls?.length) return null;
  if (p.kind === "promote_detection" && p.target.detection) return verdictCall(calls, p.target.detection);
  return (p.briefing && calls.find((c) => c.kind === "briefing" && c.text === p.briefing)) || null;
}

/** The mission's Nemotron calls on Nebius Token Factory: how many, and their measured time in all. */
export function tokenFactoryUse(calls: readonly Pick<ModelCall, "model" | "ms">[]): { calls: number; ms: number } {
  const on = calls.filter((c) => onTokenFactory(c.model));
  return { calls: on.length, ms: on.reduce((n, c) => n + (c.ms ?? 0), 0) };
}

/** The same count from a trace: its model calls on Token Factory (a fixture's `fake/` stand-ins left out). */
export function traceTokenFactoryUse(entries: readonly TraceEntry[]): { calls: number; ms: number } {
  return tokenFactoryUse(entries.filter((e) => e.kind === "model_call").map((e) => ({ model: e.model ?? "", ms: e.ms ?? 0 })));
}

/** "12 Nemotron calls on Nebius Token Factory in this mission". */
export function callCountWords(n: number, where = "in this mission"): string {
  return `${n} Nemotron ${n === 1 ? "call" : "calls"} on ${TOKEN_FACTORY} ${where}`;
}

/** The small line under an AI item. */
export function ModelSource({ model, ms, lead }: { model: string; ms?: number | null; lead?: string }) {
  return (
    <p data-model-source="" className="text-caption text-text-3">
      {lead && `${lead} `}
      {sourceLine(model, ms)}
    </p>
  );
}
