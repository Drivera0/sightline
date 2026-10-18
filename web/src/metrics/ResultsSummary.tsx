import type { ReactNode } from "react";
import type { Metrics } from "../contract";
import { Badge, Label } from "../shell/components";
import { count, pct, seconds, speedup } from "./format";
import { useCountUp } from "./motion";

/**
 * The finale: the one result to say out loud (how soon the ranked queue reaches every person),
 * drawn as a race against this flight's own order (one layout, not a baseline average), then three
 * cards with their comparisons. Every number is
 * from metrics.json and carries its source as a tooltip; the full tables follow below this.
 */
export function ResultsSummary({ metrics }: { metrics: Metrics }) {
  const { detector, baseline_human: human, ranking, search_sim: sim } = metrics;
  const inside = sim.in_survey;
  const byName = (name: string) => inside?.methods.find((m) => m.name.startsWith(name));
  const sightline = byName("Sightline");
  const naive = byName("Naive");
  const ranked = ranking.ranked.frames_to_all_hits;
  const flight = ranking.flight_order.frames_to_all_hits;
  const people = ranking.n_positive === 1 ? "person" : "people";
  const rankingSource = `Demo survey, ${ranking.n_frames} frames, ${ranking.n_positive} with people (metrics.ranking)`;

  return (
    <section aria-label="Results" className="flex flex-col gap-5">
      <div className="sl-rise flex flex-col gap-2">
        <Label>Results</Label>
        <h2 className="max-w-4xl text-[40px] font-semibold leading-[1.05]" title={rankingSource}>
          All {ranking.n_positive} {people} were in the first {ranked} photos of the queue.
        </h2>
        <p className="max-w-3xl text-title text-text-2" title={rankingSource}>
          The first person is photo {ranking.ranked.frames_to_first_hit}. Paging through this flight in the
          order it was flown (one layout, not an average) reaches the last person at photo {flight}.
        </p>
      </div>

      <Race
        n={ranking.n_frames}
        source={rankingSource}
        rows={[
          { label: "This flight's order", first: ranking.flight_order.frames_to_first_hit, all: flight, tone: "muted" },
          { label: "Sightline ranked queue", first: ranking.ranked.frames_to_first_hit, all: ranked, tone: "accent" },
        ]}
      />

      <div className="grid gap-4 md:grid-cols-3">
        <Card
          label="Recall"
          value={detector.voc.recall}
          format={(v) => pct(v)}
          ours={detector.voc.recall}
          theirs={human.recall}
          oursLabel="Sightline"
          theirsLabel="Human"
          note="People found on photos the detector never trained on"
          source={`HERIDAL test set, ${detector.test_images} images (metrics.detector) vs ${human.source}`}
          delay={0}
        />
        <Card
          label="Time per photo"
          value={detector.seconds_per_image}
          format={(v) => seconds(v)}
          headline={speedup(detector.seconds_per_image, human.seconds_per_image)}
          ours={detector.seconds_per_image}
          theirs={human.seconds_per_image}
          oursLabel="Sightline"
          theirsLabel="Human"
          lowerIsBetter
          note={`${seconds(human.seconds_per_image)} for a person looking by eye`}
          source={`metrics.detector.seconds_per_image vs ${human.source}`}
          delay={90}
        />
        {sightline && naive && inside ? (
          <Card
            label="Cells to search"
            value={sightline.median_cells}
            format={(v) => count(Math.round(v))}
            ours={sightline.median_cells}
            theirs={naive.median_cells}
            oursLabel="Sightline"
            theirsLabel="Naive map"
            lowerIsBetter
            note="Median cells a ground team checks inside the surveyed area"
            source={`Simulated search, ${inside.trials} trials with the person in a photographed cell (metrics.search_sim.in_survey)`}
            badge={<Badge kind="simulated">Simulated</Badge>}
            delay={180}
          />
        ) : (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-5">
            <Label>Cells to search</Label>
            <span className="font-mono text-[44px] leading-none text-text-3">—</span>
            <span className="text-small text-text-3">Not yet measured (needs a contract 1.1 cache)</span>
          </div>
        )}
      </div>
    </section>
  );
}

/** Two bars racing to "everyone found", with a tick where the first person turns up. */
function Race({
  n,
  rows,
  source,
}: {
  n: number;
  rows: { label: string; first: number; all: number; tone: "muted" | "accent" }[];
  source: string;
}) {
  return (
    <div className="sl-rise flex flex-col gap-4 rounded-lg border border-border bg-surface p-5" style={{ animationDelay: "60ms" }} title={source}>
      <div className="flex items-baseline justify-between gap-4">
        <Label>Photos looked at before every person is found</Label>
        <span className="font-mono text-label text-text-3">of {n}</span>
      </div>
      {rows.map((row, i) => (
        <RaceRow key={row.label} n={n} row={row} delay={250 + i * 200} />
      ))}
    </div>
  );
}

function RaceRow({
  n,
  row,
  delay,
}: {
  n: number;
  row: { label: string; first: number; all: number; tone: "muted" | "accent" };
  delay: number;
}) {
  const shown = useCountUp(row.all, 1400);
  const accent = row.tone === "accent";
  return (
    <div className="grid grid-cols-[11rem_minmax(0,1fr)_4.5rem] items-center gap-4">
      <span className={"text-small " + (accent ? "text-text" : "text-text-2")}>{row.label}</span>
      <div className="relative h-3 rounded-full bg-surface-strong">
        <span
          className={"sl-grow absolute inset-y-0 left-0 rounded-full " + (accent ? "bg-accent shadow-[0_0_18px_-2px_var(--accent)]" : "bg-text-3/60")}
          style={{ width: `${Math.max(1.2, (row.all / n) * 100)}%`, animationDelay: `${delay}ms` }}
        />
        <span
          className="absolute -top-1 h-5 w-0.5 rounded-full bg-text"
          style={{ left: `${(row.first / n) * 100}%` }}
          title={`First person at photo ${row.first}`}
        />
      </div>
      <span className={"text-right font-mono text-title " + (accent ? "text-accent-soft" : "text-text-2")}>
        {Math.round(shown)}
      </span>
    </div>
  );
}

function Card({
  label,
  value,
  format,
  headline,
  ours,
  theirs,
  oursLabel,
  theirsLabel,
  lowerIsBetter = false,
  note,
  source,
  badge,
  delay,
}: {
  label: string;
  value: number;
  format: (v: number) => string;
  headline?: string;
  ours: number;
  theirs: number;
  oursLabel: string;
  theirsLabel: string;
  lowerIsBetter?: boolean;
  note: string;
  source: string;
  badge?: ReactNode;
  delay: number;
}) {
  const shown = useCountUp(value, 1100);
  const max = Math.max(ours, theirs) || 1;
  return (
    <div
      className="sl-rise flex flex-col gap-3 rounded-lg border border-border bg-surface p-5 [box-shadow:inset_0_1px_0_0_var(--surface-strong)]"
      style={{ animationDelay: `${delay}ms` }}
      title={source}
    >
      <div className="flex items-center justify-between gap-2">
        <Label>{label}</Label>
        {badge}
      </div>
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-[44px] leading-none text-text">{format(shown)}</span>
        {headline && <span className="text-small text-accent-soft">{headline}</span>}
      </div>
      <div className="flex flex-col gap-1.5">
        <Bar label={oursLabel} value={format(ours)} width={(ours / max) * 100} accent />
        <Bar label={theirsLabel} value={format(theirs)} width={(theirs / max) * 100} />
      </div>
      <span className="text-small text-text-3">
        {note}
        {lowerIsBetter ? " (lower is better)" : ""}
      </span>
    </div>
  );
}

function Bar({ label, value, width, accent = false }: { label: string; value: string; width: number; accent?: boolean }) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)_3.5rem] items-center gap-2 text-label">
      <span className={accent ? "text-text" : "text-text-3"}>{label}</span>
      <span className="h-1.5 rounded-full bg-surface-strong">
        <span
          className={"sl-grow block h-full rounded-full " + (accent ? "bg-accent" : "bg-text-3/60")}
          style={{ width: `${Math.max(2, width)}%` }}
        />
      </span>
      <span className={"text-right font-mono " + (accent ? "text-text" : "text-text-3")}>{value}</span>
    </div>
  );
}
