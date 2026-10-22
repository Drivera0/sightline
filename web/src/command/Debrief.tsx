// The Debrief view: the story's ending (t5) and the console's last view. A panel beside the map, not a
// page: what this mission did so far, the numbers that matter with how each is measured (ResultsSummary),
// what breaks first, "Where to look, in order" for judges, and the links: the report, the trace, the code.

import { useEffect, useState } from "react";
import type { Metrics } from "../contract";
import type { MissionData } from "../lib/mission";
import { HONESTY, JUDGE_LINKS, JUDGES, REPORT_URL, REPO_URL } from "../front/judges";
import { FOOTER } from "../front/copy";
import { RadioClip } from "../front/RadioClip";
import { ResultsSummary } from "../metrics/ResultsSummary";
import { Label } from "../shell/components";

/** The mission so far, in one line: photos, candidates confirmed, sectors searched (with their POD), clues. */
export function missionSoFar(s: Pick<MissionData, "mapUpdates" | "tasks" | "clues" | "proposals">): string {
  const photos = s.mapUpdates.filter((u) => u.source === "frame").length;
  const searched = s.tasks.filter((t) => t.state === "searched");
  const decided = s.proposals.filter((p) => p.status !== "pending").length;
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  const pods = searched.map((t) => `${t.sector_id} at POD ${Math.round((t.pod ?? 0) * 100)} %`).join(", ");
  return [
    n(photos, "photo") + " on the map",
    n(decided, "proposal") + " decided by a person",
    searched.length ? `${n(searched.length, "sector")} searched (${pods})` : "no sector searched yet",
    n(s.clues.length, "clue"),
  ].join(" · ");
}

export function Debrief({
  missionName,
  so,
  metrics,
  cellM,
  surveyId,
  judgesOpen = false,
  traceHref,
  liveDebriefUrl,
}: {
  missionName: string;
  so: Pick<MissionData, "mapUpdates" | "tasks" | "clues" | "proposals">;
  /** The detector's and the map's measured results (the demo survey's metrics.json); null while loading. */
  metrics: Metrics | null;
  cellM?: number;
  surveyId?: string;
  judgesOpen?: boolean;
  traceHref: string;
  /** A live mission's own debrief (GET /missions/{id}/debrief.md). */
  liveDebriefUrl?: string;
}) {
  return (
    <section aria-label="Debrief" data-tour="debrief" className="sl-sheet flex flex-col gap-6 rounded-lg border border-line bg-surface-solid p-4 lg:p-5">
      <header className="flex flex-col gap-2">
        <Label>Debrief</Label>
        <h1 className="text-title font-medium text-text">{missionName}</h1>
        <p className="text-small text-text-2">{missionSoFar(so)}</p>
        {liveDebriefUrl && <LiveDebrief url={liveDebriefUrl} />}
      </header>

      {metrics ? <ResultsSummary metrics={metrics} cellM={cellM} surveyId={surveyId} /> : <p className="text-small text-text-3">Loading the measured results…</p>}

      <details open={judgesOpen} className="group rounded-lg border border-line" data-tour="judges">
        <summary className="flex cursor-pointer list-none items-center gap-3 rounded-lg p-3 hover:bg-surface-strong [&::-webkit-details-marker]:hidden">
          <span aria-hidden className="font-mono text-text-3 transition-transform group-open:rotate-90 motion-reduce:transition-none">
            ›
          </span>
          <span className="text-body text-text">For judges: where to look, in order</span>
        </summary>
        <div className="flex flex-col gap-4 px-3 pb-4">
          <p className="text-small text-text-2">{JUDGES.logline}</p>
          <ol className="flex flex-col divide-y divide-line">
            {JUDGE_LINKS.map((l, i) => (
              <li key={l.label} className="flex items-baseline gap-3 py-2 text-small">
                <span className="w-4 shrink-0 font-mono text-text-3">{i + 1}</span>
                <span className="flex min-w-0 flex-col">
                  <a
                    href={l.href}
                    {...(l.href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
                    className="text-text underline decoration-text-3 underline-offset-2 hover:decoration-text"
                  >
                    {l.label}
                  </a>
                  <span className="text-text-2">{l.proves}</span>
                </span>
                {l.time && <span className="ml-auto shrink-0 font-mono text-caption text-text-3">{l.time}</span>}
              </li>
            ))}
          </ol>
          <div className="grid gap-3 @container sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label>Simulated</Label>
              <ul className="list-disc pl-4 text-small text-text-2">
                {HONESTY.simulated.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
            <div className="flex flex-col gap-1">
              <Label>Real</Label>
              <ul className="list-disc pl-4 text-small text-text-2">
                {HONESTY.real.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          </div>
          <p className="text-caption text-text-3">
            {JUDGES.built} ·{" "}
            <a className="underline underline-offset-2" href={JUDGES.changedUrl} target="_blank" rel="noreferrer">
              what changed
            </a>
          </p>
        </div>
      </details>

      <footer className="flex flex-col gap-3 border-t border-line pt-4 text-small text-text-3">
        <p className="flex flex-wrap gap-x-4 gap-y-1">
          <a className="text-text-2 underline underline-offset-2 hover:text-text" href={REPORT_URL} target="_blank" rel="noreferrer">
            Report
          </a>
          <a className="text-text-2 underline underline-offset-2 hover:text-text" href={traceHref}>
            The agent's trace
          </a>
          <a className="text-text-2 underline underline-offset-2 hover:text-text" href={REPO_URL} target="_blank" rel="noreferrer">
            {FOOTER.code}
          </a>
          <a className="text-text-2 underline underline-offset-2 hover:text-text" href="#about">
            About Sightline
          </a>
        </p>
        <RadioClip />
        <p>{FOOTER.data}</p>
      </footer>
    </section>
  );
}

/** A live mission's debrief as the server writes it (markdown, shown as text), with the file to keep. */
function LiveDebrief({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(url).then(
      (r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))).then((t) => live && setText(t)),
      () => live && setText(null),
    );
    return () => {
      live = false;
    };
  }, [url]);
  return (
    <div className="flex flex-col gap-2">
      <a className="self-start text-small text-accent-soft underline" href={url} target="_blank" rel="noreferrer">
        This mission's debrief (markdown)
      </a>
      {text && <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-sm bg-surface-strong p-3 font-mono text-caption text-text-2">{text}</pre>}
    </div>
  );
}
