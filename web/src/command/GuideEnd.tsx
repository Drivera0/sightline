// The guided search's end screen, "What you did" (.documents/SIM_DESIGN.md §5): a no-fault hot wash. The
// outcome, each decision against the agent's, the map with every searched sector at its POD and the
// subject's true cell, every draw the engine made, one line per divergence, what went well and what to
// try; no claim about who found the subject. First, the score out of 100 (goals.ts: the mission goals and
// the time to find against the manual line), every part with how it is worked out, and the best on this
// scenario; then "You vs the agent" (compare.ts): the two lines' numbers side by side, the visitor's
// measured decision time, each decision against the agent's pick, a verdict; the detail sits below it,
// collapsed. Built by lane A.

import { useState } from "react";
import type { SectorNow } from "../lib/api";
import { clock, DEMO_TZ } from "../lib/time";
import { Button } from "../shell/components";
import { BY_EYE_S, DETECTOR_S, fmtDuration, fmtMin, REVIEWERS, type Column, type Comparison, type WithWithout } from "./compare";
import type { Score } from "./goals";
import type { HotWash } from "./guide";
import { CHECKPOINTS } from "./missionTime";
import type { Subject } from "./sim";

const REPO = "https://github.com/Drivera0/sightline/blob/main/docs/report";

/**
 * How long the find took, from the call (the time the score compares) and, when the mission was opened
 * earlier, from then too: the header's Elapsed counts from the opening (the cold test: "Elapsed 2 h 27 min"
 * over "2 h 23 min from the call", two clocks with nothing to say so).
 */
export function foundAfter(foundAt: number, opened: string | null, t: (ms: number) => string): string {
  const call = new Date(CHECKPOINTS[0]!.at).getTime();
  const fromCall = `${fmtMin((foundAt - call) / 60_000)} after the call at ${t(call)}`;
  const open = opened ? new Date(opened).getTime() : NaN;
  return Number.isFinite(open) && open < call ? `${fromCall} (${fmtMin((foundAt - open) / 60_000)} after the mission was opened at ${t(open)}, the Elapsed in the header)` : fromCall;
}

/** The sectors as a small map: searched ones shaded by POD, the subject's sector ringed green. */
function SectorMap({ sectors, searched, subject }: { sectors: readonly SectorNow[]; searched: ReadonlyMap<string, number>; subject: Subject | null }) {
  const rings = sectors.filter((s) => s.polygon?.length);
  if (!rings.length) return null;
  const pts = rings.flatMap((s) => s.polygon!);
  const [x0, x1] = [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0]))];
  const [y0, y1] = [Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))];
  const k = Math.cos((((y0 + y1) / 2) * Math.PI) / 180);
  const W = 320;
  const H = Math.max(120, Math.round((W * (y1 - y0)) / Math.max(1e-9, (x1 - x0) * k)));
  const X = (lon: number) => ((lon - x0) / (x1 - x0)) * W;
  const Y = (lat: number) => ((y1 - lat) / (y1 - y0)) * H;
  return (
    <svg viewBox={`-2 -2 ${W + 4} ${H + 4}`} className="w-full max-w-sm" role="img" aria-label="Sectors searched, with their POD, and where the subject was">
      {rings.map((s) => {
        const pod = searched.get(s.sector_id);
        const ring = s.polygon!;
        const cx = ring.slice(0, -1).reduce((n, p) => n + X(p[0]), 0) / Math.max(1, ring.length - 1);
        const cy = ring.slice(0, -1).reduce((n, p) => n + Y(p[1]), 0) / Math.max(1, ring.length - 1);
        const mine = subject?.sector === s.sector_id;
        return (
          <g key={s.sector_id}>
            <polygon
              points={ring.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}
              className={mine ? "stroke-ok" : "stroke-line"}
              strokeWidth={mine ? 2.5 : 1}
              fill={pod ? `rgba(60, 90, 140, ${0.25 + pod * 0.6})` : "transparent"}
            />
            <text x={cx} y={cy - 2} textAnchor="middle" className="fill-text-2 text-[10px]">
              {s.sector_id}
            </text>
            {pod ? (
              <text x={cx} y={cy + 10} textAnchor="middle" className="fill-text text-[9px]">
                POD {pod.toFixed(2)}
              </text>
            ) : null}
          </g>
        );
      })}
      {subject && <circle cx={X(subject.lon)} cy={Y(subject.lat)} r={4} className="fill-ok" />}
    </svg>
  );
}

/** Time to find for each column, as bars on one scale (not found by last light: no bar). */
function FindBars({ columns }: { columns: readonly Column[] }) {
  const max = Math.max(0, ...columns.map((c) => c.findMin ?? 0));
  const tone = { manual: "bg-caution", you: "bg-accent", agent: "bg-text-3" } as const;
  return (
    <div className="flex flex-col gap-1" data-find-bars>
      <span className="text-small text-text-2">Time to find, mission minutes from the call at {clock(CHECKPOINTS[0]!.at, DEMO_TZ)}</span>
      {columns.map((c) => (
        <div key={c.key} className="grid grid-cols-[7rem_1fr_auto] items-center gap-2 sm:grid-cols-[11rem_1fr_auto]">
          <span className="text-caption text-text-3">{c.title}</span>
          <span className="h-2 rounded-full bg-surface-strong" aria-hidden="true">
            {c.findMin !== null && max > 0 ? <span className={`block h-2 rounded-full ${tone[c.key]}`} style={{ width: `${Math.max(2, (c.findMin / max) * 100)}%` }} /> : null}
          </span>
          <span className="min-w-[5rem] text-right font-mono text-small text-text">{c.findMin === null ? "last light" : fmtMin(c.findMin)}</span>
        </div>
      ))}
    </div>
  );
}

/** One cell: the value, and a small line under it. */
const cell = (v: string, sub = "") => ({ v, sub });

/** The rows of "Without Sightline vs with Sightline", one value per column. */
export function rowsOf(w: WithWithout): { key: string; label: string; cells: { v: string; sub: string }[] }[] {
  return [
    { key: "find", label: "Time to find", cells: w.columns.map((c) => (c.findMin === null ? cell("not found by last light") : cell(fmtMin(c.findMin), "from the call"))) },
    {
      key: "review",
      label: "Photo review, a person's time",
      cells: w.columns.map((c) =>
        c.key === "manual"
          ? c.personMs
            ? cell(fmtMin(c.personMs / 60_000), `${c.photos} × ${BY_EYE_S} s, ${REVIEWERS} reviewer`)
            : cell("no photos")
          : c.key === "agent"
            ? cell("—", "the AI's picks")
            : c.personMs !== null
              ? cell(fmtDuration(c.personMs), "yours, measured")
              : cell("—", "Watch instead answered"),
      ),
    },
    { key: "detector", label: "Detector's time", cells: w.columns.map((c) => (c.machineMs === null ? cell("none", c.key === "manual" ? "no detector" : "no photos") : cell(fmtMin(c.machineMs / 60_000), `${DETECTOR_S} s a photo, as they land`))) },
    { key: "photos", label: "Photos a person looks at", cells: w.columns.map((c) => cell(String(c.photos), c.key === "manual" ? "every photo" : c.answered !== null ? `ranked; you answered ${c.answered}` : "ranked")) },
    { key: "missed", label: "Photo sightings missed", cells: w.columns.map((c) => cell(String(c.missed), c.key === "manual" ? "not reviewed in time" : c.key === "you" ? "marked not a person" : "")) },
    { key: "sectors", label: "Sectors searched", cells: w.columns.map((c) => cell(String(c.sectors))) },
    { key: "hours", label: "Team-hours on passes", cells: w.columns.map((c) => cell(`${c.teamHours.toFixed(1)} h`)) },
  ];
}

/** Without Sightline vs with Sightline: the headline, the columns, and how each number is worked out. */
function WithoutWith({ w }: { w: WithWithout }) {
  const rows = rowsOf(w);
  const grid = w.columns.length === 3 ? "grid-cols-[minmax(5.5rem,1.3fr)_1fr_1fr_1fr]" : "grid-cols-[minmax(5.5rem,1.3fr)_1fr_1fr]";
  return (
    <section aria-labelledby="guide-with-title" className="flex flex-col gap-3" data-with-without>
      <div className="flex flex-col gap-1">
        <h3 id="guide-with-title" className="text-body font-medium text-text">
          Without Sightline vs with Sightline
        </h3>
        <p className="text-body text-text" data-headline>
          {w.headline}
        </p>
        {w.followedNote && (
          <p className="text-caption text-text-3" data-followed>
            {w.followedNote}
          </p>
        )}
        {w.timeMatters && (
          <p className="text-small text-text-2" data-time-matters>
            {w.timeMatters.text}{" "}
            <a href={w.timeMatters.href} target="_blank" rel="noreferrer" className="sl-tap underline underline-offset-2 hover:text-text">
              {w.timeMatters.source}
            </a>
          </p>
        )}
      </div>
      <div role="table" aria-label="Without Sightline vs with Sightline" className="flex flex-col text-small">
        <div role="row" className={`grid ${grid} gap-x-2 pb-1 sm:gap-x-3`}>
          <span role="columnheader">
            <span className="sr-only">Measure</span>
          </span>
          {w.columns.map((c) => (
            <span key={c.key} role="columnheader" className={`text-caption font-medium ${c.key === "you" ? "text-accent-soft" : "text-text-3"}`} data-column={c.key}>
              {c.title}
            </span>
          ))}
        </div>
        {rows.map((r) => (
          <div key={r.key} role="row" className={`grid ${grid} gap-x-2 border-t border-line py-1.5 sm:gap-x-3`} data-measure={r.key}>
            <span role="rowheader" className="text-text-2">
              {r.label}
            </span>
            {r.cells.map((c, i) => (
              <span key={w.columns[i]!.key} role="cell" className="flex min-w-0 flex-col">
                <span className="font-mono text-text">{c.v}</span>
                {c.sub && <span className="text-caption text-text-3">{c.sub}</span>}
              </span>
            ))}
          </div>
        ))}
      </div>
      {w.missedNotes.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-caption text-text-3">
          {w.missedNotes.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      <FindBars columns={w.columns} />
      <div className="flex flex-col gap-1">
        <h4 className="text-small font-medium text-text-2">How this is worked out</h4>
        <ul className="flex flex-col gap-1 text-caption text-text-2" data-assumptions>
          {w.assumptions.map((a) => (
            <li key={a.text}>
              {a.text}{" "}
              <a className="text-accent-soft underline" href={a.href} target="_blank" rel="noreferrer">
                Source: {a.source}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** The score's parts, worked out in the open, and the best kept on this scenario. */
export interface EndScore {
  score: Score;
  /** The best before this run (null: none yet). */
  best: number | null;
  /** This run set a new best. */
  beat: boolean;
  /** Kept as a best at all (Watch instead's runs are the AI's, not kept). */
  kept: boolean;
}

function ScoreCard({ s, onReplay, onWatchAgent, followed }: { s: EndScore; onReplay: () => void; onWatchAgent: () => void; followed: boolean }) {
  const { score } = s;
  const bestLine = !s.kept
    ? "Watch instead made the decisions: this score is the AI's, not kept as yours."
    : s.beat
      ? s.best === null
        ? "Your first score on this scenario: the one to beat."
        : `A new best on this scenario (was ${s.best}).`
      : `Your best on this scenario: ${s.best}.`;
  return (
    <section aria-labelledby="guide-score-title" data-score className="flex flex-col gap-3 rounded-lg border border-line p-3 sm:p-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 id="guide-score-title" className="text-body font-medium text-text-2">
          Score
        </h3>
        <p className="font-mono text-title text-text tabular-nums" data-score-total>
          {score.total} <span className="text-body text-text-3">/ {score.max}</span>
        </p>
        <p className={`text-small ${s.beat && s.kept ? "text-ok" : "text-text-2"}`} data-best>
          {bestLine}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <h4 className="text-small font-medium text-text-2">How the score is worked out</h4>
        <ul className="flex flex-col" aria-label="Score parts">
          {score.parts.map((p) => (
            <li key={p.id} data-part={p.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-t border-line py-1.5">
              <span className="min-w-0 flex-1 text-small text-text sm:w-56 sm:flex-none">{p.label}</span>
              <span className="order-last w-full text-caption text-text-3 sm:order-none sm:w-auto sm:min-w-0 sm:flex-1">{p.how}</span>
              <span className="ml-auto shrink-0 text-right font-mono text-small text-text tabular-nums">
                {Number.isInteger(p.points) ? p.points : p.points.toFixed(1)} / {p.max}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={onReplay}>
          Beat your score
        </Button>
        <Button href="#scenarios">Try another scenario</Button>
        {!followed && <Button onClick={onWatchAgent}>Replay, following the agent</Button>}
      </div>
    </section>
  );
}

/** "You vs the agent": the two lines' numbers, your decision time, each decision, a verdict. */
function Versus({ v, onReplay, onWatchAgent, followed, free = false, actions = true }: { v: Comparison; onReplay: () => void; onWatchAgent: () => void; followed: boolean; free?: boolean; actions?: boolean }) {
  const maxThink = Math.max(1, ...v.times.map((t) => t.ms));
  const mine = v.times.length;
  const timeLine =
    mine > 0
      ? `You took ${fmtDuration(v.totalMs)} to make ${mine} decision${mine === 1 ? "" : "s"}${v.medianMs !== null && mine > 1 ? ` (median ${fmtDuration(v.medianMs)})` : ""}; the AI proposed each as the data landed.`
      : "Watch instead made every decision; the AI proposed each as the data landed.";
  return (
    <section aria-labelledby="guide-versus-title" className="flex flex-col gap-4" data-versus>
      <WithoutWith w={v.sightline} />

      <div className="flex flex-col gap-1 border-t border-line pt-3">
        <h3 id="guide-versus-title" className="text-body font-medium text-text">
          You vs the agent
        </h3>
        <p className="text-small text-text" data-verdict>
          {v.verdict}
        </p>
        <p className="text-caption text-text-3">The AI's choices: this same scenario with every decision taken the AI's way, through the same engine.</p>
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-small font-medium text-text-2">Your decision time</h4>
        <p className="text-small text-text" data-decision-time>
          {timeLine}
          {v.watched > 0 && mine > 0 ? ` Watch instead made ${v.watched} more for you.` : ""}
        </p>
        <p className="text-caption text-text-3">{free ? "Measured on this device, from when each item reached Needs you to when you acted on it. The mission clock ran on meanwhile." : "Measured on this device, from when each decision was shown to when you made it. The mission clock waits while you decide."}</p>
        <ol className="flex flex-col" aria-label="Each decision">
          {v.rows.map((r) => (
            <li key={r.key} className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 border-t border-line py-1.5 sm:grid-cols-[9rem_1fr_4.5rem_9rem]" data-row={r.key} data-same={r.same}>
              <span className="text-small text-text-2">{r.label}</span>
              <span className="text-right font-mono text-caption text-text-2 sm:order-3">{r.costMin ? `+${r.costMin} min` : "+0 min"}</span>
              <span className={`col-span-2 text-small sm:order-2 sm:col-span-1 ${r.same ? "text-text" : "text-caution"}`}>
                {r.same ? (
                  <>✓ {r.you}</>
                ) : (
                  <>
                    {r.you} <span className="text-text-3">(AI's pick: {r.agent})</span>
                  </>
                )}
              </span>
              <span className="col-span-2 flex items-center gap-2 sm:order-4 sm:col-span-1">
                {r.thinkMs !== null ? (
                  <>
                    <span className="h-1.5 flex-1 rounded-full bg-surface-strong" aria-hidden="true">
                      <span className="block h-1.5 rounded-full bg-accent" style={{ width: `${Math.max(3, (r.thinkMs / maxThink) * 100)}%` }} />
                    </span>
                    <span className="w-14 text-right font-mono text-caption text-text-2">{fmtDuration(r.thinkMs)}</span>
                  </>
                ) : (
                  <span className="text-caption text-text-3">Watch instead</span>
                )}
              </span>
            </li>
          ))}
        </ol>
        <p className="text-caption text-text-3">✓ the AI's pick. + min: mission minutes the choice put on the clock. The bar: how long you took.</p>
      </div>

      {actions && (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={onReplay}>
            Beat your score
          </Button>
          {!followed && <Button onClick={onWatchAgent}>Replay, following the agent</Button>}
          <Button href="#scenarios">Try another scenario</Button>
        </div>
      )}
    </section>
  );
}

export function GuideEnd({
  wash,
  versus = null,
  sectors,
  subject,
  scenario,
  seed,
  callsign,
  onReplay,
  onWatchAgent,
  followed = false,
  free = false,
  onReport,
  onTrace,
  onClose,
  score = null,
  opened = null,
}: {
  /** When the mission was opened (the header's Elapsed counts from it), ISO; null: not known. */
  opened?: string | null;
  wash: HotWash;
  /** You vs the agent (compare.ts); the details stay below it, collapsed. */
  versus?: Comparison | null;
  sectors: readonly SectorNow[];
  subject: Subject | null;
  scenario: string;
  seed: string;
  callsign: (id: string | null) => string;
  onReplay: () => void;
  onWatchAgent: () => void;
  /** Every decision was the agent's already: no "Replay, following the agent". */
  followed?: boolean;
  /** Free play: the clock ran on while the visitor decided. */
  free?: boolean;
  onReport: () => void;
  onTrace: () => void;
  onClose: () => void;
  /** The score out of 100 and the best on this scenario (goals.ts). */
  score?: EndScore | null;
}) {
  const t = (ms: number) => clock(new Date(ms).toISOString(), DEMO_TZ);
  const o = wash.outcome;
  const [detailsOpen, setDetailsOpen] = useState(!versus);
  const outcome =
    o.foundAt !== null
      ? `Found at ${t(o.foundAt)} by ${callsign(o.team)} in ${o.sector}, ${foundAfter(o.foundAt, opened, t)}.`
      : "Search suspended at last light. Operational period 2 begins at first light; the map carries over.";
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="guide-end-title" className="fixed inset-0 z-50 overflow-y-auto bg-bg/90 p-3 backdrop-blur sm:p-6">
      <div className="mx-auto flex max-w-4xl flex-col gap-5 rounded-lg border border-border bg-surface-solid p-4 sm:p-6">
        <header className="flex flex-col gap-1">
          <h2 id="guide-end-title" className="text-title font-medium text-text">
            What you did
          </h2>
          <p className="text-body text-text">{outcome}</p>
          <p className="text-small text-text-3">
            {scenario}. The subject's position is the scenario's{subject ? `: sector ${subject.sector}` : ""}, fixed before the search began and shown only now.
          </p>
        </header>

        {score && <ScoreCard s={score} onReplay={onReplay} onWatchAgent={onWatchAgent} followed={followed} />}

        {versus && <Versus v={versus} onReplay={onReplay} onWatchAgent={onWatchAgent} followed={followed} free={free} actions={!score} />}

        <details className="group rounded-lg border border-line" open={detailsOpen} onToggle={(e) => setDetailsOpen((e.currentTarget as HTMLDetailsElement).open)} data-details>
          <summary className="cursor-pointer list-none rounded-lg p-3 text-small font-medium text-text-2 hover:bg-surface-strong [&::-webkit-details-marker]:hidden">
            <span className="mr-1.5 inline-block transition-transform group-open:rotate-90" aria-hidden="true">
              ›
            </span>
            Show the details: every decision, the sectors and how each pass went
          </summary>
          {/* the details render when opened: the sheet's first paint stays small */}
          {detailsOpen && (
          <div className="flex flex-col gap-5 p-3 pt-1">
            <section aria-label="Decisions" className="flex flex-col gap-2">
              <h3 className="text-small font-medium text-text-2">Your decisions and the AI's</h3>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[36rem] text-left text-small">
                  <thead className="text-caption text-text-3">
                    <tr>
                      <th className="py-1 pr-3 font-normal">Time</th>
                      <th className="py-1 pr-3 font-normal">Decision</th>
                      <th className="py-1 pr-3 font-normal">You</th>
                      <th className="py-1 pr-3 font-normal">The AI's choice</th>
                      <th className="py-1 font-normal">What changed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wash.rows.map((r, i) => (
                      <tr key={i} className="border-t border-line align-top">
                        <td className="py-1.5 pr-3 font-mono text-caption text-text-2">{t(r.at)}</td>
                        <td className="py-1.5 pr-3 text-text-2">{r.label}</td>
                        <td className={`py-1.5 pr-3 ${r.same ? "text-text" : "text-caution"}`}>{r.you}</td>
                        <td className="py-1.5 pr-3 text-text-2">{r.agent}</td>
                        <td className="py-1.5 text-text-3">{r.changed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {wash.lines.length > 0 && (
                <ul className="flex flex-col gap-1 text-small text-text">
                  {wash.lines.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-label="The ground" className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <h3 className="text-small font-medium text-text-2">Sectors searched, and where the subject was</h3>
                <SectorMap sectors={sectors} searched={wash.searched} subject={subject} />
                <p className="text-caption text-text-3">Shaded: searched without a find, at the POD shown. Green: the subject's sector and position.</p>
              </div>
              <div className="flex flex-col gap-2">
                <h3 className="text-small font-medium text-text-2">How each pass went</h3>
                <p className="text-caption text-text-3">A pass finds the subject when its sector holds them, with the chance its POD gives. That chance is fixed for this scenario ({seed}) and each pass: the same choices give the same result.</p>
                <ul className="flex flex-col gap-0.5 font-mono text-caption text-text-2">
                  {wash.draws.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </div>
            </section>

            {(wash.strengths.length > 0 || wash.tryNext.length > 0) && (
              <section aria-label="Hot wash" className="grid gap-4 sm:grid-cols-2">
                <div>
                  <h3 className="text-small font-medium text-text-2">What went well</h3>
                  <ul className="mt-1 flex flex-col gap-1 text-small text-text">{wash.strengths.length ? wash.strengths.map((l) => <li key={l}>{l}</li>) : <li className="text-text-3">Nothing to single out this run.</li>}</ul>
                </div>
                <div>
                  <h3 className="text-small font-medium text-text-2">Things to try</h3>
                  <ul className="mt-1 flex flex-col gap-1 text-small text-text">{wash.tryNext.length ? wash.tryNext.map((l) => <li key={l}>{l}</li>) : <li className="text-text-3">Try another scenario: the subject is somewhere else.</li>}</ul>
                </div>
              </section>
            )}

          </div>
          )}
        </details>

        <footer className="flex flex-col gap-3 border-t border-line pt-4">
          <div className="flex flex-wrap gap-2">
            {!versus && (
              <>
                <Button variant="primary" onClick={onReplay}>
                  Beat your score
                </Button>
                {!followed && <Button onClick={onWatchAgent}>Replay, following the agent</Button>}
                <Button href="#scenarios">Try another scenario</Button>
              </>
            )}
            <Button variant="ghost" onClick={onClose}>
              Stay on the console
            </Button>
          </div>
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-small">
            <button type="button" className="text-accent-soft underline" onClick={onReport}>
              The after-action report
            </button>
            <button type="button" className="text-accent-soft underline" onClick={onTrace}>
              The agent's trace
            </button>
            <a className="text-accent-soft underline" href={`${REPO}/PLANNER_V2.md`} target="_blank" rel="noreferrer">
              How the planner is evaluated
            </a>
            <a className="text-accent-soft underline" href={`${REPO}/POD.md`} target="_blank" rel="noreferrer">
              How POD is measured
            </a>
          </p>
        </footer>
      </div>
    </div>
  );
}
