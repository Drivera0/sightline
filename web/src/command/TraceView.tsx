// The Trace tab (Agentic Vision: observability and demonstration). Everything the agent did, as chains
// from what it saw to what a person approved: perception → decision → action → approval. Each step says
// its span type, the tool or model, what went in, what came out, how long it took, and which proposal it
// led to. A strip on top says which model did what. Built by lane A.
import { useState } from "react";
import type { TraceEntry } from "../contract";
import { ModeChip, StatusPill, type Tone } from "../shell/components";
import {
  ACTOR_ROLE,
  chains,
  imagesOf,
  inputSummary,
  isScripted,
  modelUse,
  msOf,
  outputSummary,
  SPAN_WORDS,
  spanName,
  STAGE_WORDS,
  STAGES,
  stageOf,
  type Chain,
  type Outcome,
} from "./trace";

/** One trace file: a live mission's, or a recorded run shipped with the demo. */
export interface TraceRun {
  /** A recorded run's name and where it is in the repo; null for the live mission's own trace. */
  label: string | null;
  source: string | null;
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
const clock = (iso: string) => iso.slice(11, 19);

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
      <ModelStrip entries={all} chainCount={runs.reduce((n, r) => n + chains(r.entries).length, 0)} />
      {runs.map((run, i) => (
        <RunView key={run.source ?? i} run={run} imageUrl={imageUrl} />
      ))}
    </section>
  );
}

function ModelStrip({ entries, chainCount }: { entries: readonly TraceEntry[]; chainCount: number }) {
  const { models, tools } = modelUse(entries);
  const proposals = entries.filter((e) => e.kind === "proposal").length;
  const decided = entries.filter((e) => e.kind === "decision" && !isScripted(e)).length;
  const scripted = entries.filter(isScripted).length;
  return (
    <div aria-label="Which model did what" className="flex flex-col gap-3 rounded-lg border border-line bg-surface-solid p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-small font-medium text-text">Which model did what</span>
        <span className="text-caption text-text-3">
          {entries.length} steps · {chainCount} {chainCount === 1 ? "chain" : "chains"} · {proposals} {proposals === 1 ? "proposal" : "proposals"} · {decided} decided by a person
          {scripted > 0 && <span className="text-caution"> · {scripted} scripted approval{scripted === 1 ? "" : "s"} (demo run)</span>}
        </span>
      </div>
      <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {models.map((m) => (
          <li key={m.model} className="flex flex-col gap-0.5 rounded-sm border border-line px-3 py-2">
            <span className="truncate font-mono text-small text-text" title={m.model}>
              {m.model}
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

function RunView({ run, imageUrl }: { run: TraceRun; imageUrl?: (rel: string) => string | null }) {
  const cs = chains(run.entries).reverse(); // the latest chain on top
  return (
    <div className="flex flex-col gap-3" aria-label={run.label ?? "This mission's trace"}>
      {run.label && (
        <div className="flex flex-wrap items-center gap-2">
          <ModeChip mode="replay" />
          <span className="text-small text-text">{run.label}</span>
          {run.source && <code className="font-mono text-caption text-text-3">{run.source}</code>}
        </div>
      )}
      {cs.map((c) => (
        <ChainView key={c.id} chain={c} imageUrl={imageUrl} />
      ))}
    </div>
  );
}

function outcomeWords(o: Outcome): [Tone, string] {
  if (o.status === null) return ["action", `${o.proposal} ${o.kind}: waiting for a person`];
  // a scripted approval (a demo run) is amber, so it never reads as a person's decision
  if (o.scripted) return ["caution", `${o.proposal} ${o.kind} → ${o.status} by a script, not a person: ${o.by}`];
  return [o.status === "approved" ? "ok" : "muted", `${o.proposal} ${o.kind} → ${o.status}${o.by ? ` by ${o.by}` : ""}`];
}

function ChainView({ chain, imageUrl }: { chain: Chain; imageUrl?: (rel: string) => string | null }) {
  const title = chain.refs.length ? chain.refs.join(" · ") : `${chain.actors.join(", ")} · ${chain.entries.length} steps`;
  let lastStage: string | null = null;
  return (
    <article aria-label={`Chain ${title}`} className="overflow-hidden rounded-lg border border-line bg-surface-solid">
      <header className="flex flex-col gap-1.5 border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-small text-text">{title}</span>
          <ol className="flex items-center gap-1 text-caption" aria-label="Stages">
            {STAGES.map((s, i) => (
              <li key={s} className={chain.stages.includes(s) ? "text-text-2" : "text-text-3 line-through decoration-text-3/50"}>
                {i > 0 && <span aria-hidden className="px-1 text-text-3">→</span>}
                {STAGE_WORDS[s]}
              </li>
            ))}
          </ol>
          <span className="ml-auto text-caption text-text-3">
            {clock(chain.entries[0]!.at)} · {chain.entries.length} steps{chain.ms > 0 && ` · ${seconds(chain.ms)} in models and tools`}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-caption text-text-2">
          <span className="text-text-3">Led to:</span>
          {chain.outcomes.length === 0 ? (
            <span className="text-text-3">no proposal (context the agent and the map use)</span>
          ) : (
            chain.outcomes.map((o) => {
              const [tone, text] = outcomeWords(o);
              return (
                <StatusPill key={o.proposal} tone={tone}>
                  {text}
                </StatusPill>
              );
            })
          )}
        </div>
      </header>
      <ol className="flex flex-col divide-y divide-line">
        {chain.entries.map((e) => {
          const stage = stageOf(e);
          const first = stage !== lastStage;
          lastStage = stage;
          return <Step key={e.id} e={e} stage={first ? STAGE_WORDS[stage] : null} imageUrl={imageUrl} />;
        })}
      </ol>
    </article>
  );
}

function Step({ e, stage, imageUrl }: { e: TraceEntry; stage: string | null; imageUrl?: (rel: string) => string | null }) {
  const [open, setOpen] = useState(false);
  const ms = msOf(e);
  const images = imageUrl ? imagesOf(e).map((rel) => [rel, imageUrl(rel)] as const).filter((x): x is readonly [string, string] => !!x[1]) : [];
  return (
    <li aria-label={`${SPAN_WORDS[e.kind]} ${e.id}`} className="text-small">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="sl-tap grid w-full grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-0.5 px-4 py-2 text-left hover:bg-surface md:grid-cols-[6.5rem_5.5rem_minmax(0,12rem)_minmax(0,1fr)_minmax(0,1fr)_4rem]"
      >
        <span className="text-caption text-text-3">{stage ?? ""}</span>
        <span>
          <StatusPill tone={isScripted(e) ? "caution" : SPAN_TONE[e.kind]} dot={false} title={isScripted(e) ? "Scripted approval for a demo run, not a person's decision" : undefined}>
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
        <span className="text-right font-mono text-caption text-text-2">{ms === null ? "–" : seconds(ms)}</span>
      </button>
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
                  <img src={src} alt={rel} className="aspect-square w-28 rounded-sm object-cover" />
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
