// The guided search's end screen, "What you did" (.documents/SIM_DESIGN.md §5): a no-fault hot wash, not
// a grade. The outcome, each decision against the agent's, the map with every searched sector at its POD
// and the subject's true cell, every draw the engine made, one line per divergence, what went well and
// what to try. No score, and no claim about who found the subject. On top, "You vs the agent"
// (compare.ts): the two lines' numbers side by side, the visitor's measured decision time, each decision
// against the agent's pick, a verdict; the detail sits below it, collapsed. Built by lane A.

import type { SectorNow } from "../lib/api";
import { clock, DEMO_TZ } from "../lib/time";
import { Button } from "../shell/components";
import { fmtDuration, fmtMin, type Comparison, type SideStats } from "./compare";
import type { HotWash } from "./guide";
import type { Subject } from "./sim";

const REPO = "https://github.com/Drivera0/sightline/blob/main/docs/report";

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

/** Time to find for both lines, as two bars on one scale (last light: no bar). */
function FindBars({ you, agent }: { you: number | null; agent: number | null }) {
  const max = Math.max(you ?? 0, agent ?? 0);
  const row = (who: string, v: number | null, tone: string) => (
    <div className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-2 sm:grid-cols-[6.5rem_1fr_auto]">
      <span className="text-caption text-text-3">{who}</span>
      <span className="h-2 rounded-full bg-surface-strong" aria-hidden="true">
        {v !== null && max > 0 ? <span className={`block h-2 rounded-full ${tone}`} style={{ width: `${Math.max(2, (v / max) * 100)}%` }} /> : null}
      </span>
      <span className="min-w-[5rem] text-right font-mono text-small text-text">{v === null ? "last light" : fmtMin(v)}</span>
    </div>
  );
  return (
    <div className="flex flex-col gap-1" data-find-bars>
      <span className="text-small text-text-2">Time to find, mission minutes from the call</span>
      {row("Your search", you, "bg-accent")}
      {row("The AI's choices", agent, "bg-text-3")}
    </div>
  );
}

/** One line's headline card: the time to find, then the rest of its numbers. */
function SideCard({ title, s, mine }: { title: string; s: SideStats; mine: boolean }) {
  const rows: [string, string][] = [
    ["Sectors searched", String(s.sectors)],
    ["Team-hours on passes", `${s.teamHours.toFixed(1)} h`],
    ["Probability searched before the find", `${Math.round(s.covered * 100)} %`],
    ["Photos reviewed", String(s.candidates)],
    ["Decisions unlike the AI's", `${s.differed} of ${s.decisions}`],
  ];
  return (
    <div className={`flex flex-col gap-1 rounded-lg border p-3 ${mine ? "border-accent" : "border-line"}`} data-side={mine ? "you" : "agent"}>
      <span className="text-caption text-text-3">{title}</span>
      <span className="text-title font-medium text-text">{s.findMin === null ? "Suspended at last light" : fmtMin(s.findMin)}</span>
      <span className="text-caption text-text-3">{s.findMin === null ? "no find before last light" : "from the call to the find"}</span>
      <dl className="mt-1 flex flex-col">
        {rows.map(([k, val]) => (
          <div key={k} className="flex items-baseline justify-between gap-3 border-t border-line py-1">
            <dt className="text-small text-text-2">{k}</dt>
            <dd className="font-mono text-small text-text">{val}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** "You vs the agent": the two lines' numbers, your decision time, each decision, a verdict. */
function Versus({ v, onReplay, onWatchAgent, followed }: { v: Comparison; onReplay: () => void; onWatchAgent: () => void; followed: boolean }) {
  const maxThink = Math.max(1, ...v.times.map((t) => t.ms));
  const mine = v.times.length;
  const timeLine =
    mine > 0
      ? `You took ${fmtDuration(v.totalMs)} to make ${mine} decision${mine === 1 ? "" : "s"}${v.medianMs !== null && mine > 1 ? ` (median ${fmtDuration(v.medianMs)})` : ""}; the AI proposed each as the data landed.`
      : "Watch instead made every decision; the AI proposed each as the data landed.";
  return (
    <section aria-labelledby="guide-versus-title" className="flex flex-col gap-4" data-versus>
      <div className="flex flex-col gap-1">
        <h3 id="guide-versus-title" className="text-body font-medium text-text">
          You vs the agent
        </h3>
        <p className="text-body text-text" data-verdict>
          {v.verdict}
        </p>
        <p className="text-caption text-text-3">The AI's choices: this same scenario with every decision taken the AI's way, through the same engine.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <SideCard title="Your search" s={v.you} mine />
        <SideCard title="The AI's choices" s={v.agent} mine={false} />
      </div>

      <FindBars you={v.you.findMin} agent={v.agent.findMin} />
      <p className="text-caption text-text-3">
        Mission time, with every decision's minutes on the clock. Team-hours: each pass's walk and sweep, up to the find. Probability searched: the share of the agent's map that teams swept without a find, at POD 60 % a pass.
      </p>

      <div className="flex flex-col gap-2">
        <h4 className="text-small font-medium text-text-2">Your decision time</h4>
        <p className="text-small text-text" data-decision-time>
          {timeLine}
          {v.watched > 0 && mine > 0 ? ` Watch instead made ${v.watched} more for you.` : ""}
        </p>
        <p className="text-caption text-text-3">Measured on this device, from when each decision was shown to when you made it. The mission clock waits while you decide.</p>
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

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={onReplay}>
          Try again
        </Button>
        {!followed && <Button onClick={onWatchAgent}>Replay, following the agent</Button>}
        <Button href="#scenarios">Another scenario</Button>
      </div>
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
  onReport,
  onTrace,
  onClose,
}: {
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
  onReport: () => void;
  onTrace: () => void;
  onClose: () => void;
}) {
  const t = (ms: number) => clock(new Date(ms).toISOString(), DEMO_TZ);
  const o = wash.outcome;
  const outcome =
    o.foundAt !== null
      ? `Found at ${t(o.foundAt)} by ${callsign(o.team)} in ${o.sector}.`
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

        {versus && <Versus v={versus} onReplay={onReplay} onWatchAgent={onWatchAgent} followed={followed} />}

        <details className="group rounded-lg border border-line" open={!versus} data-details>
          <summary className="cursor-pointer list-none rounded-lg p-3 text-small font-medium text-text-2 hover:bg-surface-strong [&::-webkit-details-marker]:hidden">
            <span className="mr-1.5 inline-block transition-transform group-open:rotate-90" aria-hidden="true">
              ›
            </span>
            Show the details: every decision, the sectors and how each pass went
          </summary>
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
        </details>

        <footer className="flex flex-col gap-3 border-t border-line pt-4">
          <div className="flex flex-wrap gap-2">
            {!versus && (
              <>
                <Button variant="primary" onClick={onReplay}>
                  Try again
                </Button>
                {!followed && <Button onClick={onWatchAgent}>Replay, following the agent</Button>}
                <Button href="#scenarios">Another scenario</Button>
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
