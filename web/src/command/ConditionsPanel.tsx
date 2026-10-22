// The Conditions panel (Tavily, made visible): opens from the console header's conditions line (or W). Each
// fact the agent uses with its value, the quote it was read from and the page, when it was fetched, and
// the model that read the pages; the flyability gate with the wind limit it was checked against. Built by
// lane A.
import type { ReactNode } from "react";
import type { Conditions } from "../contract";
import { ModeChip, StatusPill } from "../shell/components";
import { conditionsFacts, domain, flyGate, isOverride, OVERRIDE_SOURCE, type Fact, type Lookup } from "./conditions";

export interface ConditionsData {
  conditions: Conditions;
  /** The latest lookup from the trace (the quotes, the searches, the model), or null when none is traced. */
  lookup: Lookup | null;
  /** A recorded run shown instead of live data: its label. */
  recorded: string | null;
  /** The demo mission: its own conditions are a fixture (no pages read); this says so. */
  fixture?: string;
  /** A real recorded lookup shown under them, folded, to show how sources are read (its own time and verdict). */
  example?: ConditionsData;
  /** The fleet's lowest drone wind limit and that drone's name; null without a fleet. */
  limitKmh: number | null;
  drone: string | null;
}

const minutes = (from: string, now: Date) => Math.max(0, Math.round((now.getTime() - new Date(from).getTime()) / 60000));

function Ext({ url, children }: { url: string; children?: ReactNode }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" className="text-text-2 underline decoration-text-3 underline-offset-2 hover:text-text" title={url}>
      {children ?? domain(url)} <span aria-hidden>↗</span>
    </a>
  );
}

function Source({ f, lookup }: { f: Fact; lookup: Lookup | null }) {
  const s = f.source;
  if (s.kind === "computed" || s.kind === "heuristic") return <span className="text-text-3">{s.how}</span>;
  if (s.kind === "missing") return <span className="text-text-3">{f.value === "not on the pages read" ? "left empty, not guessed" : "no quote in the trace"}</span>;
  const page = s.url ?? lookup?.extracted[0] ?? null;
  return (
    <span className="flex flex-col gap-0.5">
      <q className="font-mono text-text">{s.quote}</q>
      <span className="text-text-3">
        {s.url ? (
          <>
            from <Ext url={s.url} />
          </>
        ) : (
          <>
            verified word for word in one of the {lookup?.documents.length ?? "?"} pages read
            {page && (
              <>
                ; read in full: <Ext url={page} />
              </>
            )}
          </>
        )}
      </span>
    </span>
  );
}

export function ConditionsPanel({
  id,
  data,
  now,
  time,
  label = "Conditions",
  subordinate = false,
}: {
  id: string;
  data: ConditionsData;
  now: Date;
  time: (iso: string) => string;
  label?: string;
  /**
   * Another evening's lookup folded under the mission's own (the demo): its verdict is plain muted text
   * with its time, never a chip beside the mission's, so only one verdict reads as "now".
   */
  subordinate?: boolean;
}) {
  const { conditions: c } = data;
  const override = isOverride(c);
  const lookup = override ? null : data.lookup; // an override is never shown with a lookup's quotes
  const gate = flyGate(c, data.limitKmh, data.drone, time);
  const age = minutes(c.fetched_at, now);
  const facts = conditionsFacts(c, lookup, now);
  const alertDomains = [...new Set((lookup?.searches ?? []).filter((x) => x.label === "alerts" || x.label === "warnings").flatMap((x) => x.results.map((r) => domain(r.url))))];
  return (
    <section id={id} aria-label={label} className={`flex flex-col gap-3 rounded-lg border border-line p-4 ${subordinate ? "bg-surface-strong/40" : "bg-surface-solid"}`}>
      {subordinate && (
        <p className="text-caption text-text-3" data-verdict="example">
          Its verdict then, at {time(c.fetched_at)}, not now: {gate.text}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {!subordinate && <StatusPill tone={gate.tone}>{gate.text}</StatusPill>}
        {override && (
          <StatusPill tone="caution" dot={false}>
            Demo override: not from Tavily
          </StatusPill>
        )}
        {data.fixture ? (
          <span className="flex items-center gap-2 text-caption text-text-2">
            <ModeChip mode="demo" />
            {data.fixture}
          </span>
        ) : data.recorded ? (
          <span className="flex items-center gap-2 text-caption text-text-2">
            <ModeChip mode="replay" />
            {data.recorded}
          </span>
        ) : (
          <span className={`text-caption ${age > 60 ? "text-caution" : "text-text-2"}`}>
            as of {time(c.fetched_at)}, {age} min ago{c.stale && " (stale: the last lookup failed)"}
          </span>
        )}
        {lookup && (
          <span className="text-caption text-text-3">
            Tavily: {lookup.searches.length} searches, {lookup.extracted.length} page{lookup.extracted.length === 1 ? "" : "s"} extracted · read by{" "}
            <span className="font-mono text-text-2">{lookup.model ?? "a model"}</span>
            {lookup.ms !== null && ` in ${(lookup.ms / 1000).toFixed(1)} s`}
            {lookup.tokensIn !== null && ` (${lookup.tokensIn.toLocaleString("en")} tokens in)`}
          </span>
        )}
      </div>

      <dl className="grid gap-x-6 gap-y-3 md:grid-cols-2 xl:grid-cols-3">
        {facts.map((f) => (
          <div key={f.id} className="flex flex-col gap-0.5 border-t border-line pt-2 text-caption" aria-label={f.label}>
            <dt className="text-text-3">{f.label}</dt>
            <dd className="font-mono text-small text-text">{f.value}</dd>
            <dd>
              <Source f={f} lookup={lookup} />
            </dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-col gap-1.5 text-caption" aria-label="Alerts and closures">
        <span className="text-text-3">Alerts and closures</span>
        {c.alerts.length === 0 ? (
          <span className="text-text-2">
            None found on the pages searched{alertDomains.length ? ` (${alertDomains.join(", ")})` : ""}.
          </span>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {c.alerts.map((a) => {
              const quote = lookup?.alertQuotes.find((q) => q.title === a.title)?.quote;
              return (
                <li key={a.title} className="flex flex-wrap items-baseline gap-2">
                  <StatusPill tone="caution" dot={false}>
                    {a.kind}
                  </StatusPill>
                  <span className="text-text">{a.title}</span>
                  <span className="text-text-2">{a.text}</span>
                  {quote && <q className="font-mono text-text-2">{quote}</q>}
                  {a.url && <Ext url={a.url} />}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {lookup && lookup.searches.length > 0 && (
        <details className="text-caption">
          <summary className="cursor-pointer text-text-2">Searches and pages read ({lookup.documents.length})</summary>
          <ul className="mt-2 flex flex-col gap-2">
            {lookup.searches.map((s) => (
              <li key={s.label} className="flex flex-col gap-0.5">
                <span className="text-text-2">
                  {s.label}: <q>{s.query}</q>
                </span>
                <span className="flex flex-wrap gap-x-3 gap-y-0.5">
                  {s.results.map((r) => (
                    <Ext key={r.url} url={r.url}>
                      {r.title.length > 60 ? `${r.title.slice(0, 59)}…` : r.title}
                    </Ext>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {override && (
        <p className="text-caption text-text-3">
          Set by hand for a demo ({OVERRIDE_SOURCE}), not looked up: the next conditions lookup replaces it whole.
        </p>
      )}
      {!lookup && !override && !data.fixture && <p className="text-caption text-text-3">No conditions lookup in this mission's trace yet: the values above have no quotes to show.</p>}
      {data.example && (
        <details className="rounded-lg border border-line text-caption" aria-label="A recorded live lookup">
          <summary className="cursor-pointer px-3 py-2 text-text-3">
            Another evening's live lookup, for the sources
            <span className="text-text-3"> · {data.example.recorded ?? "a recorded lookup"}: its own values and verdict, not this mission's</span>
          </summary>
          <div className="p-2">
            <ConditionsPanel
              id={`${id}-example`}
              label="Recorded conditions lookup"
              data={data.example}
              now={new Date(data.example.conditions.fetched_at)}
              time={time}
              subordinate
            />
          </div>
        </details>
      )}
    </section>
  );
}
