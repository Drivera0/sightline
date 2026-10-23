// The agent's trace, for the Trace tab (Agentic Vision: observability and demonstration). Pure helpers:
// read a trace.jsonl, group its entries into chains (perception → decision → action → approval) by the ids
// they share, and say each step in one line: span type, tool or model, input, output, ms. Built by lane A.
import type { TraceEntry } from "../contract";

export type Stage = "perception" | "decision" | "action" | "approval";
export const STAGES: readonly Stage[] = ["perception", "decision", "action", "approval"];
export const STAGE_WORDS: Record<Stage, string> = { perception: "Perception", decision: "Decision", action: "Action", approval: "Approval" };

/** The span type in words (after the OpenAI Agents SDK's: function, generation, guardrail, handoff). */
export const SPAN_WORDS: Record<TraceEntry["kind"], string> = {
  tool_call: "Tool",
  model_call: "Model",
  verdict: "Verdict",
  proposal: "Proposal",
  decision: "Approval",
  radio_turn: "Radio",
  note: "Note",
};

/** What each actor uses its model for: the "which model did what" strip. */
export const ACTOR_ROLE: Record<TraceEntry["actor"], string> = {
  verifier: "second look at a crop",
  agent: "proposes the next move",
  planner: "plans drone legs and team sectors",
  conditions: "reads weather and closure pages",
  radio: "talks with the teams",
  pipeline: "detector",
  human: "approves or rejects",
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** One entry per non-empty line; a line that isn't JSON is skipped (a trace is appended while it is read). */
export function parseTrace(jsonl: string): TraceEntry[] {
  const out: TraceEntry[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as TraceEntry);
    } catch {
      /* a half-written last line */
    }
  }
  return out;
}

/** A planner step (agent.md, "The planner as a tool call"): a tool_call by the planner, or one that returns a ranking and a choice. */
export function isPlannerCall(e: TraceEntry): boolean {
  if (e.kind !== "tool_call") return false;
  const o = e.output;
  return e.actor === "planner" || (isObj(o) && Array.isArray(o.ranked) && "chosen" in o);
}

export interface RankedSector {
  sector: string;
  /** `score` for teams (POA × (1 − drone POD)), `score_per_min` for drone legs. */
  score: number | null;
  evidence: string | null;
}

/** The planner's best sectors, top `n` (3 by default), or null when the entry is not a planner call. */
export function plannerRanked(e: TraceEntry, n = 3): RankedSector[] | null {
  const o = e.output;
  if (!isPlannerCall(e) || !isObj(o) || !Array.isArray(o.ranked)) return null;
  return o.ranked
    .filter(isObj)
    .slice(0, n)
    .map((r) => {
      const score = typeof r.score === "number" ? r.score : typeof r.score_per_min === "number" ? r.score_per_min : null;
      return { sector: String(r.sector ?? "?"), score, evidence: typeof r.evidence === "string" ? r.evidence : null };
    });
}

/**
 * The proposals a planner step produced: the proposal entries after it in its chain, up to the next
 * planner step, that share one of its refs (the picked teams or drones, their sectors, the cause).
 */
export function plannedProposals(entries: readonly TraceEntry[], planner: TraceEntry): TraceEntry[] {
  const i = entries.indexOf(planner);
  if (i < 0 || !isPlannerCall(planner)) return [];
  const own = new Set(planner.refs);
  const out: TraceEntry[] = [];
  for (const e of entries.slice(i + 1)) {
    if (isPlannerCall(e)) break;
    if (e.kind === "proposal" && e.refs.some((r) => own.has(r))) out.push(e);
  }
  return out;
}

/** A proposal entry's id ("p003"). */
export function proposalIdOf(e: TraceEntry): string {
  const o = e.output;
  return isObj(o) && typeof o.proposal === "string" ? o.proposal : (e.refs.find((r) => /^p\d/.test(r)) ?? e.id);
}

export function stageOf(e: TraceEntry): Stage {
  if (isPlannerCall(e)) return "decision"; // the planner chooses; it does not look
  switch (e.kind) {
    case "proposal":
      return "action";
    case "decision":
      return "approval";
    case "verdict":
      return "decision";
    case "model_call":
      // a model that looks (the verifier's VL, the conditions reader) is perception; one that chooses is decision
      return e.actor === "agent" || e.actor === "planner" ? "decision" : "perception";
    default:
      return "perception";
  }
}

const words = (s: string) => s.replace(/^nvidia\//, "");
const short = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * A model as the visitor reads it: "nvidia/Nemotron-3.5-Super-VL". The trace keeps its own id (the demo
 * fixture's stand-in is "fake/<model>", a live answer it replays "recorded/<model>", and a step's output
 * still shows them); the header's disclosure chip, the Debrief and About say what is simulated, so a step
 * names the model.
 */
export const modelName = (m: string) => m.replace(/^(?:fake|recorded)\//, "");

/**
 * Who decided, as the console names the role ("Search manager", the operator chip's word). The demo
 * fixture's decider is "Search manager (scripted for the demo fixture)" in the trace, and that string stays
 * there (a step's output shows it); the view shows the role.
 */
export function roleOf(by: string): string {
  return by.replace(/\s*\([^()]*\bscripted\b[^()]*\)\s*$/i, "").trim() || by;
}

/** A decision's decider as a role ("Search manager"), or null when the entry does not say. */
export function deciderOf(e: TraceEntry): string | null {
  const o = e.output;
  return e.kind === "decision" && isObj(o) && typeof o.by === "string" ? roleOf(o.by) : null;
}

/** The tool or model a step used: "zoom_native", "Tavily search (forecast)", "nvidia/Nemotron-3.5-Super-VL". */
export function spanName(e: TraceEntry): string {
  const o = isObj(e.output) ? e.output : {};
  if (e.kind === "model_call") return e.model ? modelName(e.model) : e.actor;
  if (e.kind === "tool_call") return e.summary.split(/ on |: /)[0] ?? e.summary;
  if (e.kind === "verdict") return typeof o.model === "string" ? modelName(o.model) : e.actor;
  if (e.kind === "proposal") return typeof o.kind === "string" ? o.kind : "proposal";
  if (e.kind === "decision") return typeof o.by === "string" ? roleOf(o.by) : e.actor;
  return e.actor;
}

function compact(v: unknown, depth = 0): string {
  if (v === null || v === undefined) return "–";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x !== "object" || x === null) && v.length <= 4) return `[${v.map((x) => compact(x)).join(", ")}]`;
    return `${v.length} items`;
  }
  if (isObj(v)) {
    if (depth > 0) return "{…}";
    return Object.entries(v)
      .map(([k, x]) => `${k}: ${compact(x, depth + 1)}`)
      .join(" · ");
  }
  return String(v);
}

/** What went in, in one line. */
export function inputSummary(e: TraceEntry): string {
  const i = e.input;
  if (!isObj(i)) return e.kind === "proposal" || e.kind === "decision" || e.kind === "verdict" ? "from the step before" : "–";
  const parts: string[] = [];
  if (typeof i.query === "string") parts.push(`“${i.query}”`);
  if (typeof i.detection === "string") parts.push(i.detection);
  if (typeof i.photo === "string") parts.push(`photo ${i.photo}`);
  if (typeof i.prompt === "string") parts.push(`prompt ${i.prompt}`);
  if (Array.isArray(i.images)) parts.push(`${i.images.length} image${i.images.length === 1 ? "" : "s"}`);
  if (Array.isArray(i.urls)) parts.push(`${i.urls.length} page${i.urls.length === 1 ? "" : "s"}`);
  if (Array.isArray(i.documents)) parts.push(`${i.documents.length} documents`);
  if (Array.isArray(i.tools) && i.tools.length) parts.push(`tools: ${i.tools.join(", ")}`);
  if (Array.isArray(i.domains)) parts.push(`on ${i.domains.join(", ")}`);
  if (isObj(i.heuristics)) parts.push(compact(i.heuristics));
  return short(parts.length ? parts.join(" · ") : compact(i));
}

/** What came out, in one line. */
export function outputSummary(e: TraceEntry): string {
  const o = e.output;
  if (!isObj(o)) return e.kind === "note" ? short(e.summary) : "–";
  if (e.kind === "verdict") return short([`person: ${compact(o.person)}`, o.posture && `posture: ${compact(o.posture)}`, o.reason && compact(o.reason)].filter(Boolean).join(" · "));
  if (e.kind === "proposal") return short(`${compact(o.proposal)} ${compact(o.kind)}${typeof o.reason === "string" ? `: ${o.reason}` : ""}`);
  if (e.kind === "decision") return `${compact(o.proposal)} ${compact(o.status)}`;
  if (typeof o.text === "string") {
    try {
      const parsed: unknown = JSON.parse(o.text);
      if (isObj(parsed)) return short(compact(parsed));
    } catch {
      /* free text */
    }
    return short(o.text.replace(/\s+/g, " "));
  }
  if (isObj(o.fields)) {
    const f = Object.entries(o.fields).map(([k, x]) => (isObj(x) ? `${k} ${compact(x.value)} (“${compact(x.quote)}”)` : `${k} ${compact(x)}`));
    return short(f.join(" · ") + (Array.isArray(o.alerts) ? ` · ${o.alerts.length} alerts` : ""));
  }
  if (Array.isArray(o.results)) {
    const first = o.results[0];
    return short(`${o.results.length} results${isObj(first) && typeof first.title === "string" ? `: ${first.title}` : ""}`);
  }
  if (typeof o.image === "string") return o.image;
  const ranked = plannerRanked(e);
  if (ranked) return short(`ranked ${ranked.map((r) => `${r.sector} ${r.score === null ? "?" : compact(r.score)}`).join(", ")}`);
  return short(compact(o));
}

/** Milliseconds the step took, when it says. */
export function msOf(e: TraceEntry): number | null {
  if (typeof e.ms === "number") return e.ms;
  const o = e.output;
  return isObj(o) && typeof o.ms === "number" && o.ms > 0 ? o.ms : null;
}

/** Image files a step looked at or made (relook crops), for thumbnails. */
export function imagesOf(e: TraceEntry): string[] {
  const out: string[] = [];
  const i = e.input;
  const o = e.output;
  if (isObj(i) && Array.isArray(i.images)) out.push(...i.images.filter((x): x is string => typeof x === "string"));
  if (isObj(o) && typeof o.image === "string") out.push(o.image);
  return [...new Set(out)];
}

const SCRIPTED = /\bscripted\b/i;

export interface Outcome {
  proposal: string;
  kind: string;
  status: string | null;
  by: string | null;
  /** `by` as the role the visitor reads ("Search manager"). */
  role: string | null;
  /** Decided by a script for a demo run: the data says so in `by`; the view shows the role. */
  scripted: boolean;
}

/** One ledger record (agent.md, "The ledger"): a `note` whose output.type is "ledger". */
export interface Ledger {
  chainId: string;
  kind: string;
  /** The detection (a second look) or the leg. */
  ref: string;
  expected: number;
  realised: number;
  delta: number;
}

/** A ledger record's numbers, or null when the entry is not one. */
export function ledgerOf(e: TraceEntry): Ledger | null {
  const o = e.output;
  if (e.kind !== "note" || !isObj(o) || o.type !== "ledger") return null;
  const gain = (side: unknown) => (isObj(side) && typeof side.gain === "number" ? side.gain : null);
  const [expected, realised] = [gain(o.expected), gain(o.realised)];
  if (expected === null || realised === null) return null;
  return {
    chainId: String(o.chain_id ?? ""),
    kind: String(o.kind ?? ""),
    ref: String(o.ref ?? ""),
    expected,
    realised,
    delta: typeof o.delta === "number" ? o.delta : realised - expected,
  };
}

/** One step of a re-look chain (agent.md; relook_leg.py): a `note` whose output.type is "relook". */
export interface RelookStep {
  id: string;
  chainId: string;
  step: string;
  /** The step in a few words, for its chip. */
  words: string;
}

const metres = (v: unknown) => (typeof v === "number" ? `${Math.round(v)} m` : "?");
const RELOOK_OUTCOME: Record<string, string> = { resolved: "resolved", unclear: "still unclear", not_redetected: "not seen again" };

/** A re-look step in a few words, or null when the entry is not one. */
export function relookOf(e: TraceEntry): RelookStep | null {
  const o = e.output;
  if (e.kind !== "note" || !isObj(o) || o.type !== "relook") return null;
  const step = String(o.step ?? "");
  const px = typeof o.box_long_px === "number" ? `${o.box_long_px} px` : null;
  let w: string;
  switch (step) {
    case "unclear":
      w = `unclear: ${px ?? "a box"} from ${metres(o.altitude_m)}`;
      break;
    case "leg":
      w = `${compact(o.leg)} by ${compact(o.drone)} at ${metres(o.altitude_m)}${typeof o.pixel_factor === "number" ? `, ${compact(o.pixel_factor)}× pixels` : ""}`;
      break;
    case "photo":
      w = `photo ${compact(o.frame)} from ${metres(o.altitude_m)}${o.detection ? `: ${compact(o.detection)}${px ? `, ${px}` : ""}` : ", nothing near the spot"}`;
      break;
    case "verdict":
      w = `${compact(o.verdict)}: person ${compact(o.person)}`;
      break;
    case "outcome":
      w = `outcome: ${RELOOK_OUTCOME[String(o.outcome)] ?? compact(o.outcome)}`;
      break;
    case "skipped":
      w = `no leg: ${compact(o.why)}`;
      break;
    default:
      w = step || "step";
  }
  return { id: e.id, chainId: String(o.chain_id ?? ""), step, words: w };
}

/** The models and tools a chain used, short ("Nemotron-3.5-Super-VL", "zoom_native"): its model chips. */
export function chainModels(entries: readonly TraceEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (e.kind === "model_call" && e.model) out.push(words(e.model));
    if (e.kind === "tool_call") out.push(spanName(e).replace(/ \(.*\)$/, ""));
  }
  return [...new Set(out)];
}

export interface Chain {
  id: string;
  /** The ids this chain is about: a detection, a verdict, a proposal. */
  refs: string[];
  actors: TraceEntry["actor"][];
  entries: TraceEntry[];
  stages: Stage[];
  outcomes: Outcome[];
  ms: number;
  /** The chain's ledger records: expected against realised value of each second look and leg. */
  ledger: Ledger[];
  /** The chain's re-look steps, in trace order (unclear → leg → photo → verdict → outcome). */
  relook: RelookStep[];
}

/**
 * Entries that share an id (a detection, a verdict, a proposal) are one chain; an entry with no ids
 * joins the step just before it when the same actor made both (the conditions reader's searches and its
 * extraction). Chains come oldest first, each in trace order.
 */
export function chains(entries: readonly TraceEntry[]): Chain[] {
  const parent = entries.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const union = (a: number, b: number) => {
    const [x, y] = [find(a), find(b)];
    if (x !== y) parent[Math.max(x, y)] = Math.min(x, y);
  };
  const byRef = new Map<string, number>();
  entries.forEach((e, i) => {
    // a ledger or re-look note names its chain in its output too
    const o = e.output;
    const own = isObj(o) && (o.type === "ledger" || o.type === "relook") && typeof o.chain_id === "string" ? [o.chain_id] : [];
    for (const r of new Set([...e.refs, ...own])) {
      const j = byRef.get(r);
      if (j === undefined) byRef.set(r, i);
      else union(i, j);
    }
    if (e.refs.length === 0 && i > 0 && entries[i - 1]!.actor === e.actor) union(i, i - 1);
  });
  const groups = new Map<number, TraceEntry[]>();
  entries.forEach((e, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), e]);
  });
  return [...groups.values()].map((es) => {
    const refs = [...new Set(es.flatMap((e) => e.refs))];
    const outcomes: Outcome[] = es
      .filter((e) => e.kind === "proposal" && isObj(e.output))
      .map((e) => {
        const o = e.output as Obj;
        const pid = String(o.proposal ?? e.refs.find((r) => /^p\d/.test(r)) ?? "");
        const d = es.find((x) => x.kind === "decision" && isObj(x.output) && (x.output as Obj).proposal === pid)?.output as Obj | undefined;
        const by = d && typeof d.by === "string" ? d.by : null;
        return { proposal: pid, kind: String(o.kind ?? ""), status: d ? String(d.status) : null, by, role: by === null ? null : roleOf(by), scripted: by !== null && SCRIPTED.test(by) };
      });
    return {
      id: es[0]!.id,
      refs,
      actors: [...new Set(es.map((e) => e.actor))],
      entries: es,
      stages: STAGES.filter((s) => es.some((e) => stageOf(e) === s)),
      outcomes,
      // time in models and tools (a verdict's own ms already includes its model call)
      ms: es.filter((e) => e.kind === "model_call" || e.kind === "tool_call").reduce((n, e) => n + (msOf(e) ?? 0), 0),
      ledger: es.map(ledgerOf).filter((x): x is Ledger => x !== null),
      relook: es.map(relookOf).filter((x): x is RelookStep => x !== null),
    };
  });
}

export interface ModelUse {
  model: string;
  name: string;
  calls: number;
  actors: TraceEntry["actor"][];
  ms: number;
  tokensIn: number;
  tokensOut: number;
}

/** Which model did what: each model's calls, who called it, time and tokens. Tools are counted too. */
export function modelUse(entries: readonly TraceEntry[]): { models: ModelUse[]; tools: { name: string; calls: number }[] } {
  const models = new Map<string, ModelUse>();
  const tools = new Map<string, number>();
  for (const e of entries) {
    if (e.kind === "model_call" && e.model) {
      const id = modelName(e.model); // a fixture's fake/ and recorded/ calls of one model count as that model
      const m = models.get(id) ?? { model: id, name: words(id), calls: 0, actors: [], ms: 0, tokensIn: 0, tokensOut: 0 };
      m.calls += 1;
      if (!m.actors.includes(e.actor)) m.actors.push(e.actor);
      m.ms += e.ms ?? 0;
      m.tokensIn += e.tokens_in ?? 0;
      m.tokensOut += e.tokens_out ?? 0;
      models.set(id, m);
    }
    if (e.kind === "tool_call") {
      const name = spanName(e).replace(/ \(.*\)$/, "");
      tools.set(name, (tools.get(name) ?? 0) + 1);
    }
  }
  return {
    models: [...models.values()].sort((a, b) => b.calls - a.calls),
    tools: [...tools.entries()].map(([name, calls]) => ({ name, calls })).sort((a, b) => b.calls - a.calls),
  };
}
