import { useId, type ReactNode } from "react";
import { WHAT_BREAKS_FIRST } from "../front/judges";
import type { Metrics } from "../contract";
import { Badge, Label } from "../shell/components";
import { Sourced } from "../shell/Popover";
import { ablationDisplayRows, count, deltaPts, duration, IN_USE_ROW, pct, seconds, speedup } from "./format";
import { useCountUp } from "./motion";
import { randomOrderBaseline } from "./randomOrder";
import { ResultsCharts } from "./ResultsCharts";

// `duration` lives in format.ts (the charts use it too); re-exported here for existing callers.
export { duration };

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
  surveyId,
}: {
  metrics: Metrics;
  /** The survey's id, for notes the docs make about one survey's runs (the seed). */
  surveyId?: string;
  /** The search grid's cell size, to turn simulated cells into ground area. */
  cellM?: number;
}) {
  const { detector, baseline_human: human, ranking, search_sim: sim } = metrics;
  const speed = shippedSpeed(detector);
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
    <section aria-label="Results" className="@container flex flex-col gap-5">
      <div className="sl-rise flex flex-col gap-2">
        <Label>Results · the detector and the map, measured</Label>
        {trivial ? (
          <>
            <h2 className="max-w-4xl text-title font-medium tracking-[-0.01em] @xl:text-headline">
              <Sourced source={rankingSource}>Every photo in this survey contains a person.</Sourced>
            </h2>
            <p className="max-w-3xl text-body text-text-2">
              There is nothing for Sightline to sort here, so the queue simply opens on the photo it is most
              sure shows a person. The Mount Seymour survey shows what the sorting saves.
            </p>
          </>
        ) : (
          <>
            <h2 className="max-w-4xl text-title font-medium tracking-[-0.01em] @xl:text-headline">
              All {ranking.n_positive} {photos} were in the{" "}
              <Sourced source={rankingSource}>first {ranked} photos</Sourced> of the queue.
            </h2>
            <p className="max-w-3xl text-body text-text-2">
              That is <span className="font-medium text-text">{share(ranked)}</span> of the {count(ranking.n_frames)} photos
              {random ? (
                <>
                  ; a random order needs{" "}
                  <Sourced source={randomSource}>
                    about <span className="text-text">{count(random.expectedAll)}</span>
                  </Sourced>
                  .
                </>
              ) : (
                " to reach everyone."
              )}
            </p>
          </>
        )}
      </div>

      {/* The page answers three questions a search team asks, in order (status first, detail last):
          does it find people faster, can we trust it, and where do we search next. */}
      <Part title="At a glance" lead="The three numbers that matter to a search team.">
        <div className="grid gap-4 @xl:grid-cols-3">
          <Card
            label="People found"
            value={detector.sar.recall}
            format={(v) => pct(v)}
            scoring="SAR-APD"
            scoringPlain="scored like the human study"
            // The same green "+22 pts better" as the details below: the difference is the point.
            headline={`${deltaPts(detector.sar.recall, human.recall)} ${detector.sar.recall >= human.recall ? "better" : "worse"}`}
            ours={detector.sar.recall}
            theirs={human.recall}
            oursLabel="Sightline"
            theirsLabel="People (by eye)"
            // "Strict VOC" is the name the figure is known by; the plain rule follows it in the same line.
            line="Share of people found in test photos the detector never saw in training."
            caveat={HUMAN_CAVEAT}
            note={`Strict VOC: ${pct(detector.voc.recall)}, when the box must match the person closely. The big figure is scored like the human study (SAR-APD, a looser rule). ${HUMAN_CAVEAT} The ${pct(human.recall)} is a reference figure quoted by ${human.source}, who do not say who the people were or whether they saw these ${detector.test_images} photos.`}
            source={`HERIDAL test set, ${detector.test_images} images, SAR-APD matching (metrics.detector.sar; VOC: metrics.detector.voc) vs ${human.source}`}
            delay={0}
          />
          <Card
            label="Time per full photo"
            value={speed.seconds}
            format={speed.format}
            headline={speedup(speed.seconds, human.seconds_per_image)}
            ours={speed.seconds}
            theirs={human.seconds_per_image}
            oursLabel="Sightline"
            theirsLabel="People (by eye)"
            lowerIsBetter
            line={`${seconds(human.seconds_per_image)} for a person looking by eye.`}
            caveat={speed.caveat}
            note={`For a whole 4000×3000 photo, 16 times the area of each photo here.${speed.note ? ` ${speed.note}` : ""}`}
            source={`${speed.source} vs ${human.source}`}
            delay={90}
          />
          {sightline && naive && inside ? (
            <Card
              label="Ground to search"
              value={sightline.median_cells}
              // Area first when the cell size is known: hectares are what a ground team plans in.
              format={(v) => (cellM ? hectares(v, cellM) : count(Math.round(v)))}
              headline={
                cellM
                  ? fewer(sightline.median_cells, naive.median_cells)?.replace("fewer", "less")
                  : fewer(sightline.median_cells, naive.median_cells)
              }
              ours={sightline.median_cells}
              theirs={naive.median_cells}
              oursLabel="Sightline"
              theirsLabel="Naive map"
              lowerIsBetter
              line="The naive map counts every photographed patch as already searched."
              note={
                cellM
                  ? `Typical (median) ground a team checks inside the photographed area before reaching the person: ${count(sightline.median_cells)} vs ${count(naive.median_cells)} cells of ${count(cellM)} m × ${count(cellM)} m.`
                  : "Typical (median) number of grid cells a ground team checks inside the photographed area."
              }
              source={`Simulated search, ${inside.trials} trials with the person in a photographed cell, seed ${sim.seed} (metrics.search_sim.in_survey; seed choice: docs/LANE_C_SEARCH.md)`}
              badge={<Badge kind="simulated">Simulated</Badge>}
              caveat={seedCaveat(surveyId, sightline.median_cells, naive.median_cells)}
              footnote={`${seedNote(sim.seed, surveyId, sightline.median_cells, naive.median_cells)}; each seed is one simulation run`}
              delay={180}
            />
          ) : (
            <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-solid p-5">
              <Label>Ground to search</Label>
              <span className="text-display leading-none text-text-3">—</span>
              <span className="text-small text-text-3">Not measured for this survey yet</span>
            </div>
          )}
        </div>
      </Part>

      {!trivial && (
        <Part title="How much looking it saves" lead="Photos a searcher looks at before every person in them is found.">
    <Race
              n={ranking.n_frames}
              source={rankingSource}
              // Sightline first: the result the page is about leads, the baselines follow.
              rows={[
                {
                  label: "Sightline ranked queue",
                  short: "likeliest photos first",
                  first: ranking.ranked.frames_to_first_hit,
                  all: ranked,
                  tone: "accent",
                },
                {
                  label: "This flight's order",
                  short: "in the order the drone took them",
                  note: "one layout, as flown",
                  plain: "photos in the order the drone took them",
                  first: ranking.flight_order.frames_to_first_hit,
                  all: flight,
                  tone: "muted",
                },
                ...(random
                  ? [
                      {
                        label: "Random order",
                        short: "average of shuffled orders",
                        note: `expected value; 10–90%: ${count(random.p10All)}–${count(random.p90All)}`,
                        plain: "on average; 8 in 10 shuffles finish in that range",
                        first: random.expectedFirst,
                        all: random.expectedAll,
                        band: [random.p10All, random.p90All] as [number, number],
                        approx: true,
                        tone: "muted" as const,
                        source: randomSource,
                      },
                    ]
                  : []),
              ]}
            />
        </Part>
      )}

      <Part title="What breaks first" lead="Where it fails, said before anyone asks: the same three lines as the report, the Devposts and the video.">
        <Limits />
      </Part>

      {/* Detail for judges and the curious, folded away so it doesn't compete with the answers above.
          Styled like the detail rows under it (MetricsView), which the shell labels "Full tables". */}
      <div className="mt-4 flex items-center gap-4">
        <Label>For judges: how we measured it</Label>
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
      </div>
      <details className="group rounded-lg border border-line bg-surface-solid">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-lg p-4 hover:bg-surface-strong lg:px-6 [&::-webkit-details-marker]:hidden">
          <span aria-hidden="true" className="font-mono text-text-3 transition-transform group-open:rotate-90 motion-reduce:transition-none">
            ›
          </span>
          <span className="text-body text-text">Charts: how the detector compares, and how the search map holds up</span>
        </summary>
        <div className="flex flex-col gap-4 px-4 pb-4 lg:px-6 lg:pb-6">
          <WhyResolution
            ablations={metrics.ablations}
            source={`HERIDAL test set, ${detector.test_images} images, same threshold rule for every row (metrics.ablations)`}
          />
          <ResultsCharts metrics={metrics} surveyId={surveyId} cellM={cellM} />
        </div>
      </details>
    </section>
  );
}

/** One section of the page: a short question-like title, one plain line, then its content. */
function Part({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 pt-4">
      <div className="flex flex-col gap-0.5">
        <h3 id={id} className="text-title font-semibold text-text">
          {title}
        </h3>
        <p className="text-small text-text-2">{lead}</p>
      </div>
      {children}
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
const SEED_NOTES: Record<string, { ours: number; theirs: number; note: string; caveat: string }> = {
  // Only for that exact run: a regenerated cache with other numbers gets no note. The caveat is
  // README.md:44 and report §6.2 (docs/report/OPENCV_REPORT.md:648-650): 28–30 % fewer cells at the
  // default noise, 19–23 % with noise matching the canopy estimate's measured error (3 seeds × 5 noise levels).
  "seymour-demo": { ours: 1213, theirs: 1743, note: "the best of 3 seeds tried", caveat: "Best of three seeds; 19–30% less across seeds and noise." },
};

/** The line on the search card's face when the docs describe this run: which seed, and the spread. */
export function seedCaveat(surveyId: string | undefined, ours: number, theirs: number): string | undefined {
  const known = surveyId ? SEED_NOTES[surveyId] : undefined;
  return known && known.ours === ours && known.theirs === theirs ? known.caveat : undefined;
}

/**
 * The human figure's caveat, as the README says it (README.md:40, "a reference point, not a
 * head-to-head"; report §3.9, docs/report/OPENCV_REPORT.md:303).
 */
export const HUMAN_CAVEAT = "Scored like the human study; not a head-to-head on the same photos.";

/**
 * The shipped detector path's time per photo, where the docs measured it. metrics.json carries the
 * Torch evaluation run (detector_metrics.json: 0.251 s on an RTX 4080 SUPER), but Sightline runs the
 * detector on OpenCV 5 `cv2.dnn`: 0.303 ± 0.012 s per photo on CUDA FP32 on the same GPU, mean of 5
 * runs (docs/report/CV2_CUDA.md:143; report §3.4, docs/report/OPENCV_REPORT.md:218), and about 1.9 s
 * on a CPU (report §3.1). Only for that model and that Torch number: another cache keeps its own figure.
 */
const SHIPPED_SPEED: Record<string, { torch: number; seconds: number; caveat: string; note: string; source: string }> = {
  "yolo11s-heridal-tiled-run2": {
    torch: 0.251,
    seconds: 0.303,
    caveat: "OpenCV 5 cv2.dnn on a GPU, the path Sightline ships.",
    note: "Measured on the shipped path, OpenCV 5 cv2.dnn on CUDA (FP32, RTX 4080 SUPER): 0.303 s per photo, mean of 5 runs. Torch on the same GPU takes 0.25 s; cv2.dnn on a CPU about 1.9 s.",
    source: "OpenCV 5 cv2.dnn, CUDA FP32, RTX 4080 SUPER, 5 runs (docs/report/CV2_CUDA.md)",
  },
};

/** The time per photo the card shows: the shipped `cv2.dnn` path where the docs measured it, else metrics.json's. */
export function shippedSpeed(detector: Metrics["detector"]): {
  seconds: number;
  format: (v: number) => string;
  caveat?: string;
  note?: string;
  source: string;
} {
  const known = SHIPPED_SPEED[detector.model];
  if (known && Math.abs(known.torch - detector.seconds_per_image) < 0.0005) {
    const { seconds: s, caveat, note, source } = known;
    return { seconds: s, format: (v) => (v < 1 ? `${v.toFixed(3)} s` : seconds(v)), caveat, note, source };
  }
  return { seconds: detector.seconds_per_image, format: (v) => seconds(v), source: "metrics.detector.seconds_per_image" };
}

/** "Simulation seed 7, the best of 3 seeds tried" when the docs describe this run, else "Simulation seed 7". */
export function seedNote(seed: number, surveyId: string | undefined, ours: number, theirs: number): string {
  const known = surveyId ? SEED_NOTES[surveyId] : undefined;
  const label = `Simulation seed ${seed}`;
  return known && known.ours === ours && known.theirs === theirs ? `${label}, ${known.note}` : label;
}

/** Cells of `cellM` metres as ground area: 98 cells of 20 m -> "3.9 ha". */
function hectares(cells: number, cellM: number): string {
  const ha = (cells * cellM * cellM) / 10_000;
  return `${ha >= 10 ? Math.round(ha) : ha.toFixed(1)} ha`;
}

const RESOLUTION_BARS: readonly [name: string, short: string][] = [
  ["Stock model, no tiling", "Stock, shrunk photo"],
  ["Fine-tuned on tiles, run on shrunk photos", "Fine-tuned, shrunk photo"],
  ["Trained and run on whole photos", "Trained on 1920 px photos"],
  [IN_USE_ROW, "Fine-tuned + tiling"],
  ["Fine-tuned on tiles, full-resolution photo", "Fine-tuned, one 4000 px pass"],
];

/** Recall by how the photo is read, as bars: working at native resolution is the story of the detector. */
function WhyResolution({ ablations, source }: { ablations: Metrics["ablations"]; source: string }) {
  const measured = new Map(
    ablationDisplayRows(ablations).flatMap((r) => (r.measured ? [[r.name, r] as const] : [])),
  );
  const rows = RESOLUTION_BARS.flatMap(([name, short]) => {
    const row = measured.get(name);
    return row ? [{ ...row, short }] : [];
  });
  if (rows.length === 0) return null;
  const singlePass = measured.has("Fine-tuned on tiles, full-resolution photo");
  return (
    <div
      className="sl-rise flex flex-col gap-4 rounded-lg border border-line bg-surface-solid p-5"
      style={{ animationDelay: "300ms" }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <Sourced source={source}>
          <Label>Why resolution matters</Label>
        </Sourced>
        <span className="text-label text-text-3">test photos, strict scoring</span>
      </div>
      <p className="text-small text-text-2">
        A person is only about 70 pixels wide in a full 4000×3000 photo. Shrink the whole photo to the size the
        detector takes in, and every model loses them. What pays off is keeping full detail: Sightline cuts each photo
        into small tiles and checks them one by one, and its detector was trained on tiles like these. A model trained
        on whole photos shrunk to 1920 pixels wide finds fewer people.
        {singlePass && (
          <>
            {" "}
            Checking the whole 4000-pixel photo in one go with the same detector works too, but{" "}
            <Sourced source="5.7 GB against 0.28 GB for 1024 px tiles, timed on the same 101 test photos (scripts/README.md, data/work/detect/inference_cost.json)">
              needs about 20× the GPU memory
            </Sourced>{" "}
            (the memory on the computer&apos;s graphics card).
          </>
        )}
      </p>
      {/* Column heads, so the two numbers per row explain themselves. */}
      <div
        data-testid="resolution-headers"
        className="grid grid-cols-[minmax(0,11.5rem)_minmax(0,1fr)_3rem_4rem] items-end gap-3 border-b border-border pb-1.5 text-label text-text-3"
      >
        <span>How the photo is read</span>
        <span aria-hidden="true" />
        <span className="text-right">Recall</span>
        <span className="text-right">Precision</span>
      </div>
      <ul className="flex flex-col gap-2.5" aria-label="Recall by how the photo is read">
        {rows.map((r, i) => {
          const inUse = r.name === IN_USE_ROW;
          return (
            <li key={r.name} data-in-use={inUse || undefined} className="grid grid-cols-[minmax(0,11.5rem)_minmax(0,1fr)_3rem_4rem] items-center gap-3">
              <span className={"flex min-w-0 flex-col text-small " + (inUse ? "text-text" : "text-text-2")} title={r.name}>
                <span className="truncate">{r.short}</span>
                {inUse && <span className="font-mono text-label uppercase tracking-label text-text-2">in use</span>}
              </span>
              <span className="h-2 rounded-full bg-surface-strong">
                <span
                  className={"sl-grow block h-full rounded-full " + (inUse ? "bg-accent" : "bg-text-3/60")}
                  style={{ width: `${Math.max(2, r.voc.recall * 100)}%`, animationDelay: `${350 + i * 120}ms` }}
                />
              </span>
              <span className={"text-right font-mono text-small " + (inUse ? "font-medium text-text" : "text-text-2")}>
                {pct(r.voc.recall)}
              </span>
              <span className="text-right font-mono text-small text-text-2" title="Precision">
                {pct(r.voc.precision)}
              </span>
            </li>
          );
        })}
      </ul>
      {/* A key for the columns and the bar labels' words. Lowercase "recall" on purpose: the column head is
          the page's one capitalised "Recall". */}
      <p className="text-label text-text-3">
        Each row: people found (recall), then alerts that are real people (precision). Stock is the detector as
        downloaded; fine-tuned is further trained on drone photos of people. The orange row is the detector the app
        runs: it checks each photo tile by tile, which fits on a small graphics card.
        {singlePass && " The single full-resolution pass is not the model in use."} Every row is in the details below.
      </p>
    </div>
  );
}

/** Where the detector still fails, from docs/DETECTOR_LIMITS.md: said up front, not buried. */
function Limits() {
  return (
    <div className="sl-rise flex flex-col gap-3 rounded-lg border border-line bg-surface-solid p-5" style={{ animationDelay: "360ms" }}>
      <div className="flex flex-wrap items-baseline justify-end gap-3">
        <Sourced source="docs/submission/WHAT_BREAKS_FIRST.md, with each line's source in the report" align="end">
          <span className="text-label text-text-3">From the report</span>
        </Sourced>
      </div>
      <ol aria-label="What breaks first" className="flex flex-col gap-3">
        {WHAT_BREAKS_FIRST.map((l, i) => (
          <li key={l.lead} className="flex gap-3 border-l-2 border-warn/50 pl-3">
            <span className="font-mono text-small text-text-3">{i + 1}</span>
            <span className="text-small text-text-2">
              <span className="font-medium text-text">{l.lead}</span> {l.rest}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-small text-text-3">
        That is why Sightline ranks photos for a person to check instead of deciding on its own, and why the search map
        never marks ground as cleared.
      </p>
    </div>
  );
}

interface RaceRowData {
  label: string;
  /** The plain qualifier under the label ("likeliest photos first"). */
  short: string;
  /** The exact statistic, kept in the "Exact figures" fold ("expected value; 10–90%: 342–492"). */
  note?: string;
  /** That statistic in plain words, beside it in the fold. */
  plain?: string;
  first: number;
  all: number;
  /** A spread to draw behind the bar, e.g. the 10th-90th percentile of a random order. */
  band?: [number, number];
  /** Show "≈" before the count: an expected value, not an observed one. */
  approx?: boolean;
  tone: "muted" | "accent";
  source?: string;
}

/**
 * Axis ticks from 0 to `max`: a whole step of 1, 2 or 5 × a power of ten giving at most six
 * intervals, and no tick past `max` (500 -> 0, 100 … 500; 37 -> 0, 10, 20, 30).
 */
export function axisTicks(max: number): number[] {
  if (max <= 0) return [0];
  const base = 10 ** Math.floor(Math.log10(max));
  // Photos and cells are whole numbers, so the step is never below 1.
  const step =
    [0.1, 0.2, 0.5, 1, 2, 5, 10].map((f) => f * base).find((s) => s >= 1 && max / s <= 6) ?? base * 10;
  const ticks: number[] = [];
  for (let t = 0; t <= max + 1e-9; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
  return ticks;
}

/** The race's three columns: label, bars, count. The axis uses the same grid so its ticks line up. */
const RACE_GRID = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 sm:grid-cols-[13rem_minmax(0,1fr)_9rem]";

/** Bars racing to "everyone found", with a tick where the first person turns up. */
function Race({ n, rows, source }: { n: number; rows: RaceRowData[]; source: string }) {
  const hasBand = rows.some((r) => r.band);
  const ticks = axisTicks(n);
  return (
    <div className="sl-rise flex flex-col gap-4 rounded-lg border border-line bg-surface-solid p-5" style={{ animationDelay: "60ms" }}>
      <div className="flex flex-wrap items-baseline justify-end gap-x-6 gap-y-2">
        {/* A legend for the two marks that aren't bars, in place of a paragraph explaining them. */}
        <ul aria-label="Chart legend" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-label text-text-3">
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-3.5 w-0.5 rounded-full bg-text" />
            First person found
          </li>
          {hasBand && (
            <li className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-3 w-4 rounded-sm bg-text-3/25" />
              <Sourced source="10th to 90th percentile of a uniformly random order, computed exactly">
                8 in 10 random orders finish here
              </Sourced>
            </li>
          )}
        </ul>
      </div>
      {rows.map((row, i) => (
        <RaceRow key={row.label} n={n} row={row} delay={250 + i * 200} />
      ))}
      {/* The scale the bars are read against: photos looked at, out of the survey's n. */}
      <div className={RACE_GRID} aria-hidden="true">
        <span className="hidden text-label text-text-3 sm:block">photos looked at</span>
        <div data-testid="race-axis" className="relative order-last col-span-2 h-4 border-t border-border sm:order-none sm:col-span-1">
          {ticks.map((t, i) => (
            <span
              key={t}
              data-tick
              className={
                "absolute top-1 font-mono text-label tabular-nums text-text-3 " +
                (i === 0 ? "" : t === n ? "-translate-x-full" : "-translate-x-1/2")
              }
              style={{ left: `${(t / n) * 100}%` }}
            >
              {count(t)}
            </span>
          ))}
        </div>
        <span />
      </div>
      {/* The exact statistics and the source, for anyone who wants them, folded under the chart. */}
      <details className="group/more text-small text-text-3">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 hover:text-text-2 [&::-webkit-details-marker]:hidden">
          <span aria-hidden="true" className="transition-transform group-open/more:rotate-90 motion-reduce:transition-none">
            ›
          </span>
          Exact figures
        </summary>
        <ul className="flex flex-col gap-1 pb-1">
          {rows.flatMap((r) =>
            r.note
              ? [
                  <li key={r.label}>
                    <p>
                      {r.label}: <span>{r.note}</span> ({r.plain})
                    </p>
                  </li>,
                ]
              : [],
          )}
          <li>Source: {source}</li>
        </ul>
      </details>
    </div>
  );
}

function RaceRow({ n, row, delay }: { n: number; row: RaceRowData; delay: number }) {
  const shown = useCountUp(row.all, 1400);
  const accent = row.tone === "accent";
  return (
    <div className={RACE_GRID} title={row.source} data-race-row={row.label}>
      <span className="flex flex-col">
        <span className={"text-small " + (accent ? "font-medium text-text" : "text-text-2")}>{row.label}</span>
        <span className="text-small text-text-3">{row.short}</span>
      </span>
      <div className="relative order-last col-span-2 h-3 rounded-full bg-surface-strong sm:order-none sm:col-span-1">
        {row.band && (
          // A solid, faint range: dashed outlines read as a projection or a threshold.
          <span
            data-band
            className="absolute -inset-y-1 rounded-sm bg-text-3/25"
            style={{ left: `${(row.band[0] / n) * 100}%`, width: `${((row.band[1] - row.band[0]) / n) * 100}%` }}
            title={`10th to 90th percentile: ${row.band[0]} to ${row.band[1]} photos`}
            aria-hidden="true"
          />
        )}
        <span
          className={"sl-grow absolute inset-y-0 left-0 rounded-full " + (accent ? "bg-accent" : "bg-text-3/40")}
          style={{ width: `${Math.max(1.2, (row.all / n) * 100)}%`, animationDelay: `${delay}ms` }}
        />
        {accent && (
          // A short bar is easy to miss: a dot with a surface ring marks where it ends.
          <span
            data-end-dot
            aria-hidden="true"
            className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-bg"
            style={{ left: `${Math.max(1.2, (row.all / n) * 100)}%` }}
          />
        )}
        {accent && (
          // The result, said right where the eye lands: beside the dot.
          <span
            className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap pl-3 text-small font-semibold text-text"
            style={{ left: `${Math.max(1.2, (row.all / n) * 100)}%` }}
          >
            {Math.round(row.all)} photos
          </span>
        )}
        <span
          className="absolute -top-1 h-5 w-0.5 rounded-full bg-text"
          style={{ left: `${(row.first / n) * 100}%` }}
          title={`First person at photo ${row.approx ? "≈" : ""}${Math.round(row.first)}`}
        />
      </div>
      <span className="flex items-baseline justify-end gap-2">
        <span data-count className={"font-mono text-title " + (accent ? "font-medium text-text" : "text-text-2")}>
          {row.approx ? "≈" : ""}
          {Math.round(shown)}
        </span>
      </span>
    </div>
  );
}

function Card({
  label,
  value,
  format,
  headline,
  scoring,
  scoringPlain,
  ours,
  theirs,
  oursLabel,
  theirsLabel,
  lowerIsBetter = false,
  line,
  note,
  source,
  badge,
  caveat,
  footnote,
  delay,
}: {
  label: string;
  value: number;
  format: (v: number) => string;
  headline?: string;
  /** The scoring scheme of the big figure, shown right next to it ("SAR-APD"). */
  scoring?: string;
  /** The scoring scheme in plain words, after its name ("scored like the human study"). */
  scoringPlain?: string;
  ours: number;
  theirs: number;
  oursLabel: string;
  theirsLabel: string;
  lowerIsBetter?: boolean;
  /** The one plain line on the card face. */
  line: string;
  /** How the number is measured: folded under "How it's measured". */
  note: string;
  source: string;
  badge?: ReactNode;
  /** One line on the card face, read without opening the fold: what the comparison is and is not. */
  caveat?: string;
  /** A plain qualifier under the note, e.g. which seed a simulated run used. */
  footnote?: string;
  delay: number;
}) {
  const shown = useCountUp(value, 1100);
  const max = Math.max(ours, theirs) || 1;
  // Green when Sightline beats the comparison, amber when it doesn't (the details use the same pair).
  const better = lowerIsBetter ? ours < theirs : ours > theirs;
  const labelId = useId();
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className="sl-rise flex flex-col gap-3 rounded-lg border border-line bg-surface-solid p-5 [box-shadow:inset_0_1px_0_0_var(--surface-strong)]"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex flex-col gap-0.5">
          <Label id={labelId}>{label}</Label>
          {/* Which way is good, said where the number is read, not at the end of a footnote. */}
          <span className="text-small text-text-3">{lowerIsBetter ? "lower is better" : "higher is better"}</span>
        </span>
        {badge}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {/* The body sans with proportional digits: tabular monospace looks loose at display size. */}
        <Sourced source={source}>
          <span className="text-display font-semibold leading-none tracking-tight text-text">{format(shown)}</span>
        </Sourced>
        {scoring && <span className="font-mono text-label uppercase tracking-label text-text-2">{scoring}</span>}
        {scoringPlain && <span className="text-label text-text-3">{scoringPlain}</span>}
        {headline && <span className={"text-small font-medium " + (better ? "text-ok" : "text-warn")}>{headline}</span>}
      </div>
      <div className="flex flex-col gap-1.5">
        <Bar label={oursLabel} value={format(ours)} width={(ours / max) * 100} accent />
        <Bar label={theirsLabel} value={format(theirs)} width={(theirs / max) * 100} />
      </div>
      <span className="text-small text-text-2">{line}</span>
      {caveat && (
        <span className="text-caption text-text-3" data-caveat="">
          {caveat}
        </span>
      )}
      {/* The scoring and simulation detail, one click away, so the card face stays scannable. */}
      <details className="group/more -mb-2 text-small text-text-3">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 hover:text-text-2 [&::-webkit-details-marker]:hidden">
          <span aria-hidden="true" className="transition-transform group-open/more:rotate-90 motion-reduce:transition-none">
            ›
          </span>
          How it&apos;s measured
        </summary>
        <span className="flex flex-col gap-1 pb-2">
          <span>{note}</span>
          {footnote && <span>{footnote}</span>}
        </span>
      </details>
    </div>
  );
}

function Bar({ label, value, width, accent = false }: { label: string; value: string; width: number; accent?: boolean }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)_4rem] items-center gap-2 text-small">
      <span className={accent ? "text-text" : "text-text-3"}>{label}</span>
      <span className="h-1.5 rounded-full bg-surface-strong">
        <span
          className={"sl-grow block h-full rounded-full " + (accent ? "bg-accent" : "bg-text-3/60")}
          style={{ width: `${Math.max(2, width)}%` }}
        />
      </span>
      <span className={"text-right tabular-nums " + (accent ? "text-text" : "text-text-3")}>{value}</span>
    </div>
  );
}
