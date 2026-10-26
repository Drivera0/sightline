// The Debrief as the mission report, once the subject is found (report.ts): the sections in order, then
// the exports a command post files (the report itself, ICS 204, 214 and 309, CalTopo) and Print, which
// lays the report out on paper (theme.css @media print). Built by lane A.
import { useMemo, useState } from "react";
import type { MissionData } from "../lib/mission";
import { useClock } from "../lib/time";
import { Label } from "../shell/components";
import { buildReport, lastSeenWords, pct1, reportMarkdown, wasSearched } from "./report";
import { flightLineNames } from "./terms";

const LINK = "sl-tap inline-flex items-center gap-1 rounded-full border border-border px-3 py-0.5 text-small text-text-2 hover:border-text-3 hover:text-text";

export function MissionReport({ data, now, missionUrl }: { data: Parameters<typeof buildReport>[0] & Pick<MissionData, "teams">; now: Date; missionUrl: string | null }) {
  const { time, tz } = useClock();
  const r = useMemo(() => buildReport(data, now), [data, now]);
  const lineNames = useMemo(() => flightLineNames(r.legList.map((l) => ({ id: l.leg, drone_id: l.drone }))), [r]);
  const [team, setTeam] = useState(data.teams[0]?.id ?? "");
  const live = missionUrl !== null;
  const download = () => {
    const blob = new Blob([reportMarkdown(r, tz)], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${r.incident.replace(/[^\w-]+/g, "-").toLowerCase()}-report.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const files: { label: string; href: string | null; title: string }[] = [
    { label: "ICS 204", href: live && team ? `${missionUrl}/ics204/${encodeURIComponent(team)}.md` : null, title: "Assignment list for the team picked" },
    { label: "ICS 214", href: live ? `${missionUrl}/ics214.md` : null, title: "Activity log" },
    { label: "ICS 309", href: live ? `${missionUrl}/ics309.md` : null, title: "Communications log" },
    { label: "CalTopo", href: live ? `${missionUrl}/caltopo.geojson` : null, title: "Sectors, searched areas, flight lines, teams and clues as GeoJSON" },
  ];
  return (
    <article aria-label="Mission report" className="sl-report flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <Label>After-action report</Label>
        <h1 className="text-title font-medium text-text">{r.incident}</h1>
        {r.found && (
          <p className="text-body text-ok">
            Found by {r.found.by} in {r.found.sector} at {time(r.found.at)}
          </p>
        )}
      </header>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-small">
        <dt className="text-text-3">Incident</dt>
        <dd className="text-text">
          {r.incident}
          {r.area ? `, ${r.area}` : ""}
        </dd>
        <dt className="text-text-3">Operational period</dt>
        <dd className="text-text">
          {time(r.period.from)} to {time(r.period.to)} · {r.period.minutes} min
        </dd>
        <dt className="text-text-3">Subject</dt>
        <dd className="text-text">{r.subject}</dd>
        {r.lastSeen && (
          <>
            <dt className="text-text-3">Last seen</dt>
            <dd className="text-text">{lastSeenWords(r, time)}</dd>
          </>
        )}
        <dt className="text-text-3">Last known point</dt>
        <dd className="font-mono text-caption text-text-2">{r.lkp}</dd>
        {r.found && (
          <>
            <dt className="text-text-3">Where found</dt>
            <dd className="font-mono text-caption text-text-2">{r.found.where}</dd>
          </>
        )}
      </dl>
      <section aria-label="Key events" className="flex flex-col gap-1.5">
        <h2 className="text-small font-medium text-text">Key events</h2>
        <ol className="flex flex-col gap-0.5 text-small">
          {r.events.map((e, i) => (
            <li key={`${e.at}-${i}`} className="flex gap-3">
              <span className="w-11 shrink-0 text-caption text-text-3">{time(e.at)}</span>
              <span className="text-text-2">{e.text}</span>
            </li>
          ))}
        </ol>
      </section>
      <section aria-label="Areas searched" className="flex flex-col gap-1.5">
        <h2 className="text-small font-medium text-text">Areas searched</h2>
        {r.searched.length === 0 ? (
          <p className="text-small text-text-3">None marked searched.</p>
        ) : (
          <table className="text-small">
            <thead className="text-caption text-text-3">
              <tr>
                <th className="py-1 pr-3 text-left font-normal">Sector</th>
                <th className="sl-num py-1 pr-3 font-normal">POD</th>
                <th className="py-1 pr-3 text-left font-normal">Team</th>
                <th className="py-1 text-left font-normal">Note</th>
              </tr>
            </thead>
            <tbody>
              {r.searched.map((s) => (
                <tr key={s.sector} className="border-t border-line">
                  <td className="py-1 pr-3 text-text">{s.sector}</td>
                  <td className="sl-num py-1 pr-3 text-text">{Math.round(s.pod * 100)} %</td>
                  <td className="py-1 pr-3 text-text-2">{s.team ?? ""}</td>
                  <td className="py-1 text-text-3">{s.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section aria-label="Every sector's final POD" className="flex flex-col gap-1.5">
        <h2 className="text-small font-medium text-text">Every sector's final POD</h2>
        <p className="text-caption text-text-3">Cumulative from every look (drone photos and ground teams), each sector's chance the subject would have been found there if inside.</p>
        {r.sectors.length === 0 ? (
          <p className="text-small text-text-3">No sectors recorded.</p>
        ) : (
          <table className="text-small">
            <thead className="text-caption text-text-3">
              <tr>
                <th className="py-1 pr-3 text-left font-normal">Sector</th>
                <th className="sl-num py-1 pr-3 font-normal">POA</th>
                <th className="sl-num py-1 pr-3 font-normal">Drone coverage</th>
                <th className="sl-num py-1 font-normal">Final POD</th>
              </tr>
            </thead>
            <tbody>
              {r.sectors.map((s) => (
                <tr key={s.sector} className="border-t border-line">
                  <td className="py-0.5 pr-3 text-text">{s.sector}</td>
                  <td className="sl-num py-0.5 pr-3 text-text-2">{pct1(s.poa)}</td>
                  <td className="sl-num py-0.5 pr-3 text-text-2">{Math.round(s.coverage * 100)} %</td>
                  <td className="sl-num py-0.5 text-text">{wasSearched(r, s.sector) ? pct1(s.pod) : <span className="text-text-3">not searched</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section aria-label="Drone flight lines" className="flex flex-col gap-1.5">
        <h2 className="text-small font-medium text-text">Drone flight lines</h2>
        {r.legList.length === 0 ? (
          <p className="text-small text-text-3">No drone flight lines flown.</p>
        ) : (
          <table className="text-small">
            <thead className="text-caption text-text-3">
              <tr>
                <th className="py-1 pr-3 text-left font-normal">Flight line</th>
                <th className="py-1 pr-3 text-left font-normal">Drone</th>
                <th className="py-1 pr-3 text-left font-normal">Sector</th>
                <th className="py-1 pr-3 text-left font-normal">Status</th>
                <th className="sl-num py-1 pr-3 font-normal">Minutes</th>
                <th className="sl-num py-1 font-normal">Photos</th>
              </tr>
            </thead>
            <tbody>
              {r.legList.map((l) => (
                <tr key={l.leg} className="border-t border-line">
                  <td className="py-0.5 pr-3 text-caption text-text-2" title={l.leg}>{lineNames.get(l.leg)?.replace(/^.* · /, "") ?? l.leg}</td>
                  <td className="py-0.5 pr-3 text-text">{l.drone}</td>
                  <td className="py-0.5 pr-3 text-text">{l.sector ?? ""}</td>
                  <td className="py-0.5 pr-3 text-text-2">{l.status}</td>
                  <td className="sl-num py-0.5 pr-3 text-text" title={`minutes as ${l.minutesFrom}`}>
                    {l.minutes.toFixed(1)} <span className="text-caption text-text-3">{l.minutesFrom}</span>
                  </td>
                  <td className="sl-num py-0.5 text-text">{l.photos}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section aria-label="Resources and traffic" className="grid grid-cols-2 gap-x-4 gap-y-1 text-small sm:grid-cols-3">
        {[
          ["Survey photos", r.photos.survey],
          ["Flight-line photos", r.photos.legs],
          ["Drone flight lines", `${r.legs.flown} · ${r.legs.minutes} min`],
          ["Radio turns", r.radioTurns],
          ["Clues", r.clues],
          ["Proposals accepted", r.proposals.accepted],
          ["Proposals rejected", r.proposals.rejected],
        ].map(([k, v]) => (
          <div key={String(k)} className="flex items-baseline justify-between gap-2 border-t border-line py-1">
            <span className="text-text-3">{k}</span>
            <span className="sl-num text-text">{v}</span>
          </div>
        ))}
      </section>
      <div role="group" aria-label="Report exports" className="flex flex-wrap items-center gap-2 print:hidden">
        {live ? (
          <a className={LINK} href={`${missionUrl}/report.md`} target="_blank" rel="noreferrer">
            Report
          </a>
        ) : (
          <button type="button" className={LINK} onClick={download}>
            Report
          </button>
        )}
        <select aria-label="Team for the ICS 204" value={team} disabled={!live} onChange={(e) => setTeam(e.target.value)} className="sl-tap rounded-full border border-line bg-surface-strong px-2 py-0.5 text-small text-text disabled:text-text-3">
          {data.teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.callsign}
            </option>
          ))}
        </select>
        {files.map((f) =>
          f.href ? (
            <a key={f.label} className={LINK} href={f.href} title={f.title} target="_blank" rel="noreferrer">
              {f.label}
            </a>
          ) : (
            <button key={f.label} type="button" disabled title={`${f.title}: written by the mission server on a live mission`} className={`${LINK} cursor-not-allowed opacity-50`}>
              {f.label}
            </button>
          ),
        )}
        <button type="button" className={LINK} onClick={() => window.print()}>
          Print
        </button>
      </div>
    </article>
  );
}
