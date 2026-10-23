// The guided search's end screen, "What you did" (.documents/SIM_DESIGN.md §5): a no-fault hot wash, not
// a grade. The outcome, each decision against the agent's, the map with every searched sector at its POD
// and the subject's true cell, every draw the engine made, one line per divergence, what went well and
// what to try. No score, and no claim about who found the subject. Built by lane A.

import type { SectorNow } from "../lib/api";
import { clock, DEMO_TZ } from "../lib/time";
import { Button } from "../shell/components";
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

export function GuideEnd({
  wash,
  sectors,
  subject,
  scenario,
  seed,
  callsign,
  onReplay,
  onWatchAgent,
  onReport,
  onTrace,
  onClose,
}: {
  wash: HotWash;
  sectors: readonly SectorNow[];
  subject: Subject | null;
  scenario: string;
  seed: string;
  callsign: (id: string | null) => string;
  onReplay: () => void;
  onWatchAgent: () => void;
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
            {scenario}, seed {seed}. The subject's position is the scenario's{subject ? `: sector ${subject.sector}` : ""}, fixed before the search began and shown only now.
          </p>
        </header>

        <section aria-label="Decisions" className="flex flex-col gap-2">
          <h3 className="text-small font-medium text-text-2">Your decisions and the agent's</h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-small">
              <thead className="text-caption text-text-3">
                <tr>
                  <th className="py-1 pr-3 font-normal">Time</th>
                  <th className="py-1 pr-3 font-normal">Decision</th>
                  <th className="py-1 pr-3 font-normal">You</th>
                  <th className="py-1 pr-3 font-normal">Agent's line</th>
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
            <h3 className="text-small font-medium text-text-2">Every draw</h3>
            <p className="text-caption text-text-3">A pass detects the subject when its sector holds them and its draw is under its POD. The draws are fixed by the seed and the pass: the same choices give the same result.</p>
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

        <footer className="flex flex-col gap-3 border-t border-line pt-4">
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={onReplay}>
              Replay this seed
            </Button>
            <Button href="#">Try another scenario</Button>
            <Button onClick={onWatchAgent}>Watch the agent's line</Button>
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
