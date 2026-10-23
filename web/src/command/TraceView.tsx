// The Trace tab (Agentic Vision: observability and demonstration). Everything the agent did, as chains
// from what it saw to what a person approved: perception → decision → action → approval. Each step says
// its span type, the tool or model, what went in, what came out, how long it took, and which proposal it
// led to. A strip on top says which model did what. Built by lane A.
import { useState } from "react";
import type { TraceEntry } from "../contract";
import { ModeChip, StatusPill, type Tone } from "../shell/components";
import { useClock } from "../lib/time";
import {
  ACTOR_ROLE,
  chainModels,
  chains,
  deciderOf,
  imagesOf,
  inputSummary,
  isPlannerCall,
  modelName,
  modelUse,
  msOf,
  outputSummary,
  plannedProposals,
  plannerRanked,
  proposalIdOf,
  SPAN_WORDS,
  spanName,
  STAGE_WORDS,
  STAGES,
  stageOf,
  type Chain,
  type Ledger,
  type Outcome,
} from "./trace";

/** One trace file: a live mission's, or a recorded run shipped with the demo. */
export interface TraceRun {
  /** A recorded run's name and where it is in the repo; null for the live mission's own trace. */
  label: string | null;
  source: string | null;
  /** How the run is labelled: Recorded (a run copied from the repo, the default) or Demo (the demo mission's own, generated). */
  mode?: "replay" | "demo";
  entries: TraceEntry[];
}

const SPAN_TONE: Record<TraceEntry["kind"], Tone> = {
  tool_call: "neutral",
  model_call: "neutral",
  verdict: "ok",
  proposal: "neutral",
  decision: "ok",
  radio_turn: "neutral",
  note: "muted",
};

export const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

export function TraceView({ runs, imageUrl, empty }: { runs: readonly TraceRun[]; imageUrl?: (rel: string) => string | null; empty?: string }) {
  const all = runs.flatMap((r) => r.entries);
  if (all.length === 0) {
    return (
      <section aria-label="Trace" className="flex flex-col gap-2 rounded-lg border border-line bg-surface-solid p-6">
        <p className="text-body text-text">No trace yet.</p>
        <p className="text-small text-text-2">{empty ?? "Every tool call, model call, verdict, proposal and decision the agent makes is listed here as it happens."}</p>
      </section>
    );
  }
  return (
    <section aria-label="Trace" className="flex flex-col gap-4">
      <ModelStrip runs={runs} chainCount={runs.reduce((n, r) => n + chains(r.entries).length, 0)} />
      {runs.map((run, i) => (
        <RunView key={run.source ?? i} run={run} runKey={`r${i}`} imageUrl={imageUrl} />
      ))}
    </section>
  );
}

/**
 * Which run a trace is, in the visitor's words: "This flight" (the mission on screen: the live one's own
 * trace, or the demo mission's) or "Earlier run" (a run copied from the repo, such as the second look on
 * the val photo). Where each came from is the run's source path and the header's disclosure chip.
 */
export function runWords(run: TraceRun): string {
  return run.label === null || run.mode === "demo" ? "This flight" : "Earlier run";
}

/** Decisions by who made them, as roles: "10 by Search manager · 1 by Image reviewer". */
function decidedBy(entries: readonly TraceEntry[]): string {
  const by = new Map<string, number>();
  for (const e of entries) {
    if (e.kind !== "decision") continue;
    const who = deciderOf(e) ?? "a person";
    by.set(who, (by.get(who) ?? 0) + 1);
  }
  return [...by.entries()].sort((a, b) => b[1] - a[1]).map(([who, n]) => `${n} by ${who}`).join(" · ");
}

function ModelStrip({ runs, chainCount }: { runs: readonly TraceRun[]; chainCount: number }) {
  const entries = runs.flatMap((r) => r.entries);
  const { tools } = modelUse(entries);
  // each model once per run, with the run it was called in
  const models = runs.flatMap((r, i) => modelUse(r.entries).models.map((m) => ({ ...m, run: runWords(r), key: `r${i}-${m.model}` })));
  const proposals = entries.filter((e) => e.kind === "proposal").length;
  const decisions = entries.filter((e) => e.kind === "decision").length;
  return (
    <div role="group" aria-label="Which model did what" className="flex flex-col gap-3 rounded-lg border border-line bg-surface-solid p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-small font-medium text-text">Which model did what</span>
        <span className="text-caption text-text-3">
          {entries.length} steps · {chainCount} {chainCount === 1 ? "chain" : "chains"} · {proposals} {proposals === 1 ? "proposal" : "proposals"} · {decisions}{" "}
          {decisions === 1 ? "decision" : "decisions"}
          {decisions > 0 && `: ${decidedBy(entries)}`}
        </span>
      </div>
      <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {models.map((m) => (
          <li key={m.key} data-run={m.run} className="flex flex-col gap-0.5 rounded-sm border border-line px-3 py-2">
            <span className="flex min-w-0 items-baseline justify-between gap-2">
              <span className="truncate text-small text-text" title={modelName(m.model)}>
                {modelName(m.model)}
              </span>
              <span className="shrink-0 rounded-full border border-line bg-surface-strong px-2 py-px text-caption text-text-2">{m.run}</span>
            </span>
            <span className="text-caption text-text-2">
              {m.actors.map((a) => `${a}: ${ACTOR_ROLE[a]}`).join("; ")}
            </span>
            <span className="text-caption text-text-3">
              {m.calls} {m.calls === 1 ? "call" : "calls"} · {seconds(m.ms)}
              {m.tokensIn + m.tokensOut > 0 && ` · ${m.tokensIn} → ${m.tokensOut} tokens`}
            </span>
          </li>
        ))}
        {models.length === 0 && <li className="text-caption text-text-3">No model calls yet.</li>}
      </ul>
      {tools.length > 0 && (
        <p className="text-caption text-text-2">
          <span className="text-text-3">Tools: </span>
          {tools.map((t) => `${t.name} ×${t.calls}`).join(" · ")}
        </p>
      )}
    </div>
  );
}

function RunView({ run, runKey, imageUrl }: { run: TraceRun; runKey: string; imageUrl?: (rel: string) => string | null }) {
  const cs = chains(run.entries).reverse(); // the latest chain on top
  return (
    <div role="group" className="flex flex-col gap-3" aria-label={run.label ?? "This mission's trace"}>
      {run.label && (
        <div className="flex flex-wrap items-center gap-2">
          <ModeChip mode={run.mode ?? "replay"}>{runWords(run)}</ModeChip>
          <span className="text-small text-text">{run.label}</span>
          {run.source && <code className="font-mono text-caption text-text-3">{run.source}</code>}
        </div>
      )}
      {cs.map((c) => (
        <ChainView key={c.id} chain={c} runKey={runKey} imageUrl={imageUrl} />
      ))}
    </div>
  );
}

function outcomeWords(o: Outcome): [Tone, string] {
  if (o.status === null) return ["action", `${o.proposal} ${o.kind}: waiting for a person`];
  // the role, as the console names it ("Search manager"); the full `by` stays in the decision step's output
  return [o.status === "approved" ? "ok" : "muted", `${o.proposal} ${o.kind} → ${o.status}${o.role ? ` by ${o.role}` : ""}`];
}

/** The element id of a step, for a link from the planner step to the proposal it produced. */
const stepAnchor = (runKey: string, e: TraceEntry) => `trace-${runKey}-${e.id}`;

function ChainView({ chain, runKey, imageUrl }: { chain: Chain; runKey: string; imageUrl?: (rel: string) => string | null }) {
  const title = chain.refs.length ? chain.refs.join(" · ") : `${chain.actors.join(", ")} · ${chain.entries.length} steps`;
  let lastStage: string | null = null;
  const { time } = useClock();
  return (
    <article aria-label={`Chain ${title}`} className="overflow-hidden rounded-lg border border-line bg-surface-solid">
      <header className="flex flex-col gap-1.5 border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-small text-text">{title}</span>
          <ol className="flex items-center gap-1 text-caption" aria-label="Stages">
            {STAGES.map((s, i) => (
              <li key={s} className={chain.stages.includes(s) ? "text-text-2" : "text-text-3 line-through decoration-text-3/50"}>
                {i > 0 && <span aria-hidden className="px-1 text-text-3">→</span>}
                {STAGE_WORDS[s]}
              </li>
            ))}
          </ol>
          <span className="ml-auto text-caption text-text-3">
            {time(chain.entries[0]!.at, true)} · {chain.entries.length} steps{chain.ms > 0 && ` · ${seconds(chain.ms)} in models and tools`}
          </span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-caption text-text-2">
          <span className="text-text-3">Led to:</span>
          {chain.outcomes.length === 0 ? (
            <span className="text-text-3">no proposal (context the agent and the map use)</span>
          ) : (
            chain.outcomes.map((o) => {
              const [tone, text] = outcomeWords(o);
              return (
                <StatusPill key={o.proposal} tone={tone} className="sl-pill-wrap">
                  {text}
                </StatusPill>
              );
            })
          )}
        </div>
        {chain.relook.length > 0 && <RelookRow chain={chain} />}
        {chain.ledger.length > 0 && (
          <div role="group" aria-label="Ledger" className="flex min-w-0 flex-wrap items-center gap-2 text-caption text-text-2">
            <span className="text-text-3" title="The ledger: the value the agent expected from each observation against the value it realised (agent.md, The ledger)">
              Did it help:
            </span>
            {chain.ledger.map((l, i) => (
              <LedgerChip key={`${l.kind}-${l.ref}-${i}`} l={l} />
            ))}
          </div>
        )}
      </header>
      <ol className="flex flex-col divide-y divide-line">
        {chain.entries.map((e) => {
          const stage = stageOf(e);
          const first = stage !== lastStage;
          lastStage = stage;
          const produced = isPlannerCall(e) ? plannedProposals(chain.entries, e).map((x) => ({ id: proposalIdOf(x), href: `#${stepAnchor(runKey, x)}` })) : [];
          return <Step key={e.id} e={e} anchor={stepAnchor(runKey, e)} stage={first ? STAGE_WORDS[stage] : null} produced={produced} imageUrl={imageUrl} />;
        })}
      </ol>
    </article>
  );
}

/** A gain in a few digits: 0.493, 0.000097, 0. */
export function gainWords(v: number): string {
  if (v === 0) return "0";
  const a = Math.abs(v);
  return String(Number(a >= 0.01 ? a.toFixed(3) : a.toPrecision(2)));
}

/** "+0.507", "−0.493", "±0". */
export function deltaWords(v: number): string {
  if (v === 0) return "±0";
  return `${v > 0 ? "+" : "−"}${gainWords(v)}`;
}

const LEDGER_KIND: Record<string, string> = { second_look: "second look", leg: "leg" };

/** One ledger record as two numbers: "expected 0.493 → realised 1 (Δ +0.507)". */
function LedgerChip({ l }: { l: Ledger }) {
  const sign = (v: number) => (v < 0 ? "−" : "");
  return (
    <span
      data-ledger={l.ref}
      title={`${LEDGER_KIND[l.kind] ?? l.kind} ${l.ref} (${l.chainId}): expected gain ${l.expected}, realised ${l.realised}, delta ${l.delta}`}
      className="inline-flex max-w-full flex-wrap items-baseline gap-x-1.5 rounded-full border border-line bg-surface-strong px-2.5 py-px text-caption"
    >
      {/* text-2, not text-3: on the chip's strong surface text-3 is 4.47:1 */}
      <span className="text-text-2">
        {LEDGER_KIND[l.kind] ?? l.kind} {l.ref}
      </span>
      <span className="text-text-2">
        expected {sign(l.expected)}
        {gainWords(l.expected)} → realised {sign(l.realised)}
        {gainWords(l.realised)}
      </span>
      <span className={l.delta > 0 ? "text-ok" : l.delta < 0 ? "text-caution" : "text-text-2"}>(Δ {deltaWords(l.delta)})</span>
    </span>
  );
}

/** A re-look chain (relook_leg.py): its steps as chips in order, then the models and tools it used. */
function RelookRow({ chain }: { chain: Chain }) {
  const models = chainModels(chain.entries);
  const id = chain.relook[0]!.chainId;
  return (
    <div role="group" aria-label={`Re-look ${id}`} className="flex min-w-0 flex-col gap-1.5 text-caption text-text-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <span className="pr-1 text-text-3">Re-look:</span>
        <ol className="contents" aria-label="Re-look steps">
        {chain.relook.map((r, i) => (
          <li key={r.id} data-step={r.step} className="flex min-w-0 items-center gap-1">
            {i > 0 && (
              <span aria-hidden className="text-text-3">
                →
              </span>
            )}
            <StatusPill tone={r.step === "unclear" || r.step === "skipped" ? "caution" : r.step === "outcome" ? "ok" : "neutral"} dot={false} className="sl-pill-wrap">
              {r.words}
            </StatusPill>
          </li>
        ))}
        </ol>
      </div>
      {models.length > 0 && (
        <span className="flex flex-wrap items-center gap-1" aria-label="Models">
          <span className="pr-1 text-text-3">Models:</span>
          {models.map((m) => (
            <span key={m} className="rounded-full border border-line bg-surface-strong px-2 py-px text-caption text-text-2">
              {m}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

/** A planner step's best three sectors (score and the evidence line) and the proposals it led to. */
function PlannerRanked({ e, produced }: { e: TraceEntry; produced: readonly { id: string; href: string }[] }) {
  const ranked = plannerRanked(e) ?? [];
  if (!ranked.length && !produced.length) return null;
  return (
    <div role="group" aria-label="Planner ranking" className="flex flex-col gap-1 px-4 pb-2 text-caption md:pl-[7.25rem]">
      {ranked.length > 0 && (
        <ol className="flex flex-col gap-0.5" aria-label="Ranked sectors">
          {ranked.map((r, i) => (
            <li key={`${r.sector}-${i}`} data-sector={r.sector} className="text-text-2">
              <span className="text-text">
                {i + 1}. {r.sector}
              </span>{" "}
              <span className="text-text-3">score {r.score === null ? "–" : String(Number(r.score.toPrecision(3)))}</span>
              {r.evidence && <span>: {r.evidence}</span>}
            </li>
          ))}
        </ol>
      )}
      {produced.length > 0 && (
        <p className="text-text-2">
          <span className="text-text-3">Led to: </span>
          {produced.map((p, i) => (
            <span key={p.id}>
              {i > 0 && ", "}
              <a href={p.href} className="font-mono text-accent underline">
                {p.id}
              </a>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

function Step({
  e,
  anchor,
  stage,
  produced = [],
  imageUrl,
}: {
  e: TraceEntry;
  anchor?: string;
  stage: string | null;
  /** For a planner step: the proposals it produced, with links to their steps. */
  produced?: readonly { id: string; href: string }[];
  imageUrl?: (rel: string) => string | null;
}) {
  const [open, setOpen] = useState(false);
  const ms = msOf(e);
  const images = imageUrl ? imagesOf(e).map((rel) => [rel, imageUrl(rel)] as const).filter((x): x is readonly [string, string] => !!x[1]) : [];
  return (
    <li id={anchor} aria-label={`${SPAN_WORDS[e.kind]} ${e.id}`} className="scroll-mt-4 text-small">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="sl-tap grid w-full grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-0.5 px-4 py-2 text-left hover:bg-surface md:grid-cols-[6.5rem_5.5rem_minmax(0,12rem)_minmax(0,1fr)_minmax(0,1fr)_4rem]"
      >
        <span className="text-caption text-text-3">{stage ?? ""}</span>
        <span>
          <StatusPill tone={SPAN_TONE[e.kind]} dot={false} title={deciderOf(e) ?? undefined}>
            {SPAN_WORDS[e.kind]}
          </StatusPill>
        </span>
        <span className="truncate font-mono text-caption text-text" title={spanName(e)}>
          {spanName(e)}
        </span>
        <span className="truncate text-caption text-text-2" title={inputSummary(e)}>
          <span className="text-text-3 md:hidden">in: </span>
          {inputSummary(e)}
        </span>
        <span className="truncate text-caption text-text" title={outputSummary(e)}>
          <span className="text-text-3 md:hidden">out: </span>
          {outputSummary(e)}
        </span>
        <span className="text-right text-caption text-text-2">{ms === null ? "–" : seconds(ms)}</span>
      </button>
      {isPlannerCall(e) && <PlannerRanked e={e} produced={produced} />}
      {open && (
        <div className="flex flex-col gap-2 px-4 pb-3 md:pl-[7.25rem]">
          <p className="text-caption text-text-2">
            {e.summary} <span className="text-text-3">· {e.actor} · {e.at}</span>
            {e.refs.length > 0 && <span className="font-mono text-text-3"> · {e.refs.join(", ")}</span>}
          </p>
          {images.length > 0 && (
            <div className="flex gap-2">
              {images.map(([rel, src]) => (
                <figure key={rel} className="flex w-28 flex-col gap-1">
                  <img loading="lazy" decoding="async" src={src} alt={rel} className="aspect-square w-28 rounded-sm object-cover" />
                  <figcaption className="truncate font-mono text-caption text-text-3">{rel.split("/").pop()}</figcaption>
                </figure>
              ))}
            </div>
          )}
          <div className="grid gap-2 md:grid-cols-2">
            <Json label="Input" value={e.input} />
            <Json label="Output" value={e.output} />
          </div>
          {e.tokens_in !== null && (
            <p className="text-caption text-text-3">
              {e.tokens_in} tokens in · {e.tokens_out ?? 0} out
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-caption text-text-3">{label}</span>
      <pre className="max-h-56 overflow-auto rounded-sm border border-line bg-bg p-2 font-mono text-caption whitespace-pre-wrap text-text-2">
        {value === null ? "none" : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
