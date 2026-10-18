import type { ReactNode } from "react";
import type { Metrics } from "../contract";
import { ResetReview } from "../review/ResetReview";
import { useReview, type Answer } from "../review/store";
import { Badge, Label } from "../shell/components";
import { ablationDisplayRows, count, pct, seconds, speedup } from "./format";
import { useCountUp } from "./motion";
import { randomOrderBaseline } from "./randomOrder";

/** "4 min", "3 h 5 min": a span of time a person would spend. */
export function duration(totalSeconds: number): string {
  const mins = Math.round(totalSeconds / 60);
  if (mins < 1) return `${Math.round(totalSeconds)} s`;
  if (mins < 90) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * The finale: the one result to say out loud (how soon the ranked queue reaches every person),
 * drawn as a race against the honest baseline (a uniformly random order: its expected value and
 * 10th-90th percentile, computed exactly from metrics.ranking's N and k) and against this flight's
 * own order (one layout, not an average), then three cards with their comparisons. Every number is
 * from metrics.json or derived from it, and carries its source as a tooltip; the full tables
 * follow below this.
 */
export function ResultsSummary({
  metrics,
  cellM,
  candidateIds = [],
  surveyId,
}: {
  metrics: Metrics;
  /** The survey's id, for notes the docs make about one survey's runs (the seed). */
  surveyId?: string;
  /** The search grid's cell size, to turn simulated cells into ground area. */
  cellM?: number;
  /** The review queue's detections, for the live "your review" summary. */
  candidateIds?: readonly string[];
}) {
  const { detector, baseline_human: human, ranking, search_sim: sim } = metrics;
  const inside = sim.in_survey;
  const byName = (name: string) => inside?.methods.find((m) => m.name.startsWith(name));
  const sightline = byName("Sightline");
  const naive = byName("Naive");
  const ranked = ranking.ranked.frames_to_all_hits;
  const flight = ranking.flight_order.frames_to_all_hits;
  const photos = ranking.n_positive === 1 ? "photo with a person" : "photos with a person";
  const rankingSource = `This survey, ${ranking.n_frames} frames, ${ranking.n_positive} with a person (metrics.ranking)`;
  // When every photo has a person there is nothing for the ranking to reorder: say so, skip the race.
  const trivial = ranking.n_positive >= ranking.n_frames;
  // No minutes here: the survey's photos are 1000×750 sections of 4000×3000 HERIDAL photos, and the
  // published human time (metrics.baseline_human.seconds_per_image) is per full photo. The saving is
  // said in photos and as a share of the survey instead.
  const share = (photosLooked: number) => pct(photosLooked / ranking.n_frames, 1);
  const random = randomOrderBaseline(ranking.n_frames, ranking.n_positive);
  const randomSource = `Expected position of the last of k = ${ranking.n_positive} photos with a person among N = ${ranking.n_frames} in a uniformly random order: k(N+1)/(k+1); spread is the exact 10th-90th percentile (metrics.ranking)`;

  return (
    <section aria-label="Results" className="flex flex-col gap-5">
      <div className="sl-rise flex flex-col gap-2">
        <Label>Results</Label>
        {trivial ? (
          <>
            <h2 className="max-w-4xl text-[30px] font-semibold leading-[1.05] sm:text-[40px]" title={rankingSource}>
              Every photo in this survey contains a person.
            </h2>
            <p className="max-w-3xl text-title text-text-2" title={rankingSource}>
              There is nothing for the ranking to reorder here, so the queue simply opens on the most
              confident detection. The Mount Seymour survey shows what ranking buys.
            </p>
          </>
        ) : (
          <>
            <h2 className="max-w-4xl text-[30px] font-semibold leading-[1.05] sm:text-[40px]" title={rankingSource}>
              All {ranking.n_positive} {photos} were in the first {ranked} photos of the queue.
            </h2>
            <p className="max-w-3xl text-title text-text-2" title={rankingSource}>
              That is <span className="text-accent-soft">{share(ranked)}</span> of the {count(ranking.n_frames)} photos
              to reach everyone.{" "}
              {random && (
                <span title={randomSource}>
                  A random order needs about <span className="text-text">{count(random.expectedAll)}</span> on average
                  (9 in 10 random orders need at least {count(random.p10All)}).{" "}
                </span>
              )}
              This flight in the order it was flown (one layout, not an average) needed{" "}
              <span className="text-text">{count(flight)}</span>. The first person is photo{" "}
              {ranking.ranked.frames_to_first_hit} of the queue.
            </p>
          </>
        )}
      </div>

      {!trivial && (
        <Race
          n={ranking.n_frames}
          source={rankingSource}
          rows={[
            ...(random
              ? [
                  {
                    label: "Random order",
                    note: `expected value; 10–90%: ${count(random.p10All)}–${count(random.p90All)}`,
                    first: random.expectedFirst,
                    all: random.expectedAll,
                    band: [random.p10All, random.p90All] as [number, number],
                    approx: true,
                    time: share(random.expectedAll),
                    tone: "muted" as const,
                    source: randomSource,
                  },
                ]
              : []),
            {
              label: "This flight's order",
              note: "one layout, as flown",
              first: ranking.flight_order.frames_to_first_hit,
              all: flight,
              time: share(flight),
              tone: "muted",
            },
            {
              label: "Sightline ranked queue",
              note: "this survey",
              first: ranking.ranked.frames_to_first_hit,
              all: ranked,
              time: share(ranked),
              tone: "accent",
            },
          ]}
        />
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Card
          label="Recall"
          value={detector.sar.recall}
          format={(v) => pct(v)}
          ours={detector.sar.recall}
          theirs={human.recall}
          oursLabel="Sightline"
          theirsLabel="Human"
          note={`People found on photos the detector never trained on, scored as in the human study (SAR-APD); ${pct(detector.voc.recall)} under strict VOC`}
          source={`HERIDAL test set, ${detector.test_images} images, SAR-APD matching (metrics.detector.sar; VOC: metrics.detector.voc) vs ${human.source}`}
          delay={0}
        />
        <Card
          label="Time per full photo"
          value={detector.seconds_per_image}
          format={(v) => seconds(v)}
          headline={speedup(detector.seconds_per_image, human.seconds_per_image)}
          ours={detector.seconds_per_image}
          theirs={human.seconds_per_image}
          oursLabel="Sightline"
          theirsLabel="Human"
          lowerIsBetter
          note={`For a whole 4000×3000 photo (16 of the survey's sections): ${seconds(human.seconds_per_image)} for a person looking by eye`}
          source={`metrics.detector.seconds_per_image vs ${human.source}`}
          delay={90}
        />
        {sightline && naive && inside ? (
          <Card
            label="Cells to search"
            value={sightline.median_cells}
            format={(v) => count(Math.round(v))}
            headline={fewer(sightline.median_cells, naive.median_cells)}
            ours={sightline.median_cells}
            theirs={naive.median_cells}
            oursLabel="Sightline"
            theirsLabel="Naive map"
            lowerIsBetter
            note={
              cellM
                ? `Median ${count(cellM)} m cells a ground team checks inside the surveyed area: about ${hectares(sightline.median_cells, cellM)} of ground against ${hectares(naive.median_cells, cellM)}`
                : "Median cells a ground team checks inside the surveyed area"
            }
            source={`Simulated search, ${inside.trials} trials with the person in a photographed cell, seed ${sim.seed} (metrics.search_sim.in_survey)`}
            badge={<Badge kind="simulated">Simulated</Badge>}
            footnote={seedNote(sim.seed, surveyId, sightline.median_cells, naive.median_cells)}
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

      <div className="grid gap-4 lg:grid-cols-2">
        <YourReview candidateIds={candidateIds} />
        <WhyTiling
          ablations={metrics.ablations}
          source={`HERIDAL test set, ${detector.test_images} images, same threshold rule for every row (metrics.ablations)`}
        />
      </div>

      <Limits />
    </section>
  );
}

/** Median seconds between consecutive timestamps (ms); null with fewer than two. */
export function medianGapSeconds(atMs: readonly number[]): number | null {
  if (atMs.length < 2) return null;
  const sorted = [...atMs].sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((t, i) => (t - sorted[i]!) / 1000).sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  return gaps.length % 2 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2;
}

/**
 * "20% fewer": how much lower ours is than theirs, for lower-is-better counts. Only when the
 * percentage means something: on small counts (11 vs 13 cells is "15% fewer") it says nothing, so
 * both must be at least 30 or the gap at least 10.
 */
export function fewer(ours: number, theirs: number): string | undefined {
  if (theirs <= 0 || ours >= theirs) return undefined;
  const meaningful = (ours >= 30 && theirs >= 30) || theirs - ours >= 10;
  if (!meaningful) return undefined;
  return `${Math.round((1 - ours / theirs) * 100)}% fewer`;
}

/**
 * Which seed the headline search run is, where the docs say so. docs/LANE_C_SEARCH.md (5 m
 * re-run): "The demo's 1,213 vs 1,743 is seed 7 at the default noise, again the best of the three
 * seeds."
 */
const SEED_NOTES: Record<string, { ours: number; theirs: number; note: string }> = {
  // Only for that exact run: a regenerated cache with other numbers gets no note.
  "seymour-demo": { ours: 1213, theirs: 1743, note: "the best of 3 seeds tried (docs/LANE_C_SEARCH.md)" },
};

/** "Seed 7, the best of 3 seeds tried (...)" when the docs describe this run, else "Seed 7". */
export function seedNote(seed: number, surveyId: string | undefined, ours: number, theirs: number): string {
  const known = surveyId ? SEED_NOTES[surveyId] : undefined;
  return known && known.ours === ours && known.theirs === theirs ? `Seed ${seed}, ${known.note}` : `Seed ${seed}`;
}

/** Cells of `cellM` metres as ground area: 98 cells of 20 m -> "3.9 ha". */
function hectares(cells: number, cellM: number): string {
  const ha = (cells * cellM * cellM) / 10_000;
  return `${ha >= 10 ? Math.round(ha) : ha.toFixed(1)} ha`;
}

const ANSWER_ROWS: [Answer, string, string][] = [
  ["person", "Confirmed people", "bg-accent"],
  ["not_person", "Not a person", "bg-text-3"],
  ["unsure", "Unsure", "bg-warn"],
];

/**
 * The reviewer's own session, from this browser's saved answers: how many candidates they
 * answered, what they said, and how long it took them. Measured live, never stored in the cache.
 */
function YourReview({ candidateIds }: { candidateIds: readonly string[] }) {
  const answers = useReview((s) => s.answers);
  const history = useReview((s) => s.history);
  const ids = new Set(candidateIds);
  const mine = history.filter((h) => ids.has(h.detectionId));
  const answered = candidateIds.filter((id) => answers[id] !== undefined);
  const tally = (a: Answer) => answered.filter((id) => answers[id] === a).length;
  // The median gap between answers: a pause (or a break between sessions) doesn't inflate it.
  const gapS = medianGapSeconds(mine.map((h) => h.at));
  const total = candidateIds.length;

  return (
    <div
      className="sl-rise flex flex-col gap-4 rounded-lg border border-border bg-surface p-5"
      style={{ animationDelay: "240ms" }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <Label>Your review</Label>
        <span className="flex items-center gap-2 text-label text-text-3">
          answers saved in this browser
          <ResetReview />
        </span>
      </div>
      {total === 0 ? (
        <p className="text-small text-text-3">This survey has no candidates to review.</p>
      ) : answered.length === 0 ? (
        <p className="text-body text-text-2">
          You haven&apos;t answered any of the {total} candidates yet. Press <span className="font-mono">3</span> to
          review them; your answers will be summarised here.
        </p>
      ) : (
        <>
          <p className="text-title text-text">
            {answered.length === total ? "All" : answered.length} of {total} candidates answered
            {gapS !== null && (
              <span className="text-text-2">, a median of {seconds(gapS)} per answer</span>
            )}
          </p>
          <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-strong" role="img" aria-label="Answers by kind">
            {ANSWER_ROWS.map(([a, , tone]) => (
              <span key={a} className={`sl-grow h-full ${tone}`} style={{ width: `${(tally(a) / total) * 100}%` }} />
            ))}
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-small sm:grid-cols-4">
            {ANSWER_ROWS.map(([a, label, tone]) => (
              <div key={a} className="flex flex-col gap-0.5">
                <dt className="flex items-center gap-1.5 text-text-3">
                  <span aria-hidden="true" className={`size-2 rounded-full ${tone}`} />
                  {label}
                </dt>
                <dd className="font-mono text-title text-text">{tally(a)}</dd>
              </div>
            ))}
            <div className="flex flex-col gap-0.5">
              <dt className="text-text-3">Not answered</dt>
              <dd className="font-mono text-title text-text-2">{total - answered.length}</dd>
            </div>
          </dl>
          <p className="text-small text-text-3">
            Confirmed people are pinned on the map; each &ldquo;Not a person&rdquo; updated the search map where the
            drone looked.
          </p>
        </>
      )}
    </div>
  );
}

/** Recall by technique, as bars: the jump tiling makes is the story of the detector. */
function WhyTiling({ ablations, source }: { ablations: Metrics["ablations"]; source: string }) {
  const rows = ablationDisplayRows(ablations).flatMap((r) => (r.measured ? [r] : []));
  if (rows.length === 0) return null;
  const best = rows.reduce((b, r, i) => (r.voc.ap50 > rows[b]!.voc.ap50 ? i : b), 0);
  return (
    <div
      className="sl-rise flex flex-col gap-4 rounded-lg border border-border bg-surface p-5"
      style={{ animationDelay: "300ms" }}
      title={source}
    >
      <div className="flex items-baseline justify-between gap-3">
        <Label>Why tiling matters</Label>
        <span className="text-label text-text-3">test set: recall, precision</span>
      </div>
      <p className="text-small text-text-2">
        A person is a few dozen pixels in a full-size photo. Shrinking the photo to the model&apos;s input loses them;
        reading it in overlapping tiles keeps them.
      </p>
      <div className="flex flex-col gap-2.5">
        {rows.map((r, i) => (
          <div key={r.name} className="grid grid-cols-[minmax(0,10.5rem)_minmax(0,1fr)_3rem_3rem] items-center gap-3">
            <span className={"truncate text-small " + (i === best ? "text-text" : "text-text-2")} title={r.name}>
              {r.name}
            </span>
            <span className="h-2 rounded-full bg-surface-strong">
              <span
                className={"sl-grow block h-full rounded-full " + (i === best ? "bg-accent" : "bg-text-3/60")}
                style={{ width: `${Math.max(2, r.voc.recall * 100)}%`, animationDelay: `${350 + i * 120}ms` }}
              />
            </span>
            <span className={"text-right font-mono text-small " + (i === best ? "text-accent-soft" : "text-text-2")}>
              {pct(r.voc.recall)}
            </span>
            <span className="text-right font-mono text-small text-text-3" title="Precision">
              {pct(r.voc.precision)}
            </span>
          </div>
        ))}
      </div>
      <p className="text-label text-text-3">
        Bars show recall; the grey figure is precision. The highlighted row, the best AP50, is the detector in use:
        hard negatives found slightly more people but raised more false alarms.
      </p>
    </div>
  );
}

/** Where the detector still fails, from docs/DETECTOR_LIMITS.md: said up front, not buried. */
function Limits() {
  const items = [
    ["Groups", "people standing close together, where one box covers the group and a neighbour is missed"],
    ["Camouflage", "white or grey clothing on pale limestone, dark clothing on dark rock"],
    ["Posture", "people sitting on benches or beside objects, or lying down"],
  ];
  return (
    <div
      className="sl-rise flex flex-col gap-3 rounded-lg border border-border bg-surface/60 p-5"
      style={{ animationDelay: "360ms" }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <Label>Where it still misses</Label>
        <span className="text-label text-text-3">docs/DETECTOR_LIMITS.md</span>
      </div>
      <ul className="grid gap-3 md:grid-cols-3">
        {items.map(([title, body]) => (
          <li key={title} className="flex flex-col gap-1 border-l-2 border-warn/50 pl-3">
            <span className="text-body text-text">{title}</span>
            <span className="text-small text-text-2">{body}</span>
          </li>
        ))}
      </ul>
      <p className="text-small text-text-3">
        That is why Sightline ranks photos for a person to check instead of deciding on its own, and why the search map
        never marks ground as cleared.
      </p>
    </div>
  );
}

interface RaceRowData {
  label: string;
  /** A short qualifier under the label ("expected value", "one layout"). */
  note?: string;
  first: number;
  all: number;
  /** A spread to draw behind the bar, e.g. the 10th-90th percentile of a random order. */
  band?: [number, number];
  /** Show "≈" before the count: an expected value, not an observed one. */
  approx?: boolean;
  /** The count as a share of the survey's photos. */
  time: string;
  tone: "muted" | "accent";
  source?: string;
}

/** Bars racing to "everyone found", with a tick where the first person turns up. */
function Race({ n, rows, source }: { n: number; rows: RaceRowData[]; source: string }) {
  return (
    <div className="sl-rise flex flex-col gap-4 rounded-lg border border-border bg-surface p-5" style={{ animationDelay: "60ms" }} title={source}>
      <div className="flex items-baseline justify-between gap-4">
        <Label>Photos looked at before every person is found</Label>
        <span className="font-mono text-label text-text-3">of {n}</span>
      </div>
      {rows.map((row, i) => (
        <RaceRow key={row.label} n={n} row={row} delay={250 + i * 200} />
      ))}
      <p className="text-label text-text-3">
        The white tick marks the first person.
        {rows.some((r) => r.band) &&
          " The dashed box is where 8 in 10 random orders reach the last photo with a person (10th to 90th percentile, computed exactly)."}
      </p>
    </div>
  );
}

function RaceRow({ n, row, delay }: { n: number; row: RaceRowData; delay: number }) {
  const shown = useCountUp(row.all, 1400);
  const accent = row.tone === "accent";
  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 sm:grid-cols-[13rem_minmax(0,1fr)_9rem]"
      title={row.source}
    >
      <span className="flex flex-col">
        <span className={"text-small " + (accent ? "text-text" : "text-text-2")}>{row.label}</span>
        {row.note && <span className="text-label text-text-3">{row.note}</span>}
      </span>
      <div className="relative order-last col-span-2 h-3 rounded-full bg-surface-strong sm:order-none sm:col-span-1">
        {row.band && (
          <span
            className="absolute -inset-y-1 rounded-sm border border-dashed border-text-3/60"
            style={{ left: `${(row.band[0] / n) * 100}%`, width: `${((row.band[1] - row.band[0]) / n) * 100}%` }}
            title={`10th to 90th percentile: ${row.band[0]} to ${row.band[1]} photos`}
            aria-hidden="true"
          />
        )}
        <span
          className={"sl-grow absolute inset-y-0 left-0 rounded-full " + (accent ? "bg-accent shadow-[0_0_18px_-2px_var(--accent)]" : "bg-text-3/60")}
          style={{ width: `${Math.max(1.2, (row.all / n) * 100)}%`, animationDelay: `${delay}ms` }}
        />
        <span
          className="absolute -top-1 h-5 w-0.5 rounded-full bg-text"
          style={{ left: `${(row.first / n) * 100}%` }}
          title={`First person at photo ${row.approx ? "≈" : ""}${Math.round(row.first)}`}
        />
      </div>
      <span className="flex items-baseline justify-end gap-2">
        <span className={"font-mono text-title " + (accent ? "text-accent-soft" : "text-text-2")}>
          {row.approx ? "≈" : ""}
          {Math.round(shown)}
        </span>
        <span className="w-12 text-right text-small text-text-3">{row.time}</span>
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
  footnote,
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
  /** A plain qualifier under the note, e.g. which seed a simulated run used. */
  footnote?: string;
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
      {footnote && <span className="font-mono text-label text-text-3">{footnote}</span>}
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
