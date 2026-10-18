import type { ReactNode } from "react";
import type { Metrics } from "../contract";
import { useCache } from "../lib/cache";
import { Badge, EmptyState, Panel, Stat } from "../shell/components";
import {
  ablationDisplayRows,
  ablationSubLabel,
  count,
  deltaPts,
  IN_USE_ROW,
  pct,
  seconds,
  speedup,
  uniqueMinIndex,
} from "./format";
import { useCountUp } from "./motion";
import { AIR_CITATION, AIR_ROWS, AIR_TUNING_NOTE } from "./publishedSota";
import { randomOrderBaseline } from "./randomOrder";

/**
 * Lane A's screen (LANE_A_ML.md §9): detector vs. the human baseline, the ablation table,
 * D's ranking result and C's search simulation. Reads `metrics.json` only. Every number
 * carries its source as a tooltip, and the panel footer repeats it.
 *
 * Look: D's tokens only. The panels get a one-pixel lit top edge (the "rim" of glass kits such
 * as Space UI), numbers are tabular mono, colour is always paired with a word (HIG), and the
 * headline numbers count up once unless the viewer prefers reduced motion.
 */
export function MetricsView({ metrics }: { metrics?: Metrics }) {
  const loaded = useCache((s) => s.data);
  const m = metrics ?? loaded?.metrics;
  if (!m) {
    return (
      <Panel className="h-full">
        <EmptyState title="Metrics">No metrics.json loaded yet.</EmptyState>
      </Panel>
    );
  }
  return <MetricsBody m={m} />;
}

/** The plain gloss that goes wherever AP or AP50 is shown. */
const AP_GLOSS =
  "Overall score (AP): one number that combines people found and real alerts across every confidence cut-off; higher is better.";

/** Lit top edge on a glass panel, from the surface-strong token. */
const RIM = "[box-shadow:inset_0_1px_0_0_var(--surface-strong)]";

function MetricsBody({ m }: { m: Metrics }) {
  const {
    detector,
    baseline_human: human,
    ablations,
    ranking,
    search_sim: sim,
  } = m;

  const detectorSource = `HERIDAL test set, ${detector.test_images} images, ${
    detector.tiled ? "tiled" : "untiled"
  } inference at threshold ${detector.threshold} (metrics.detector)`;
  const humanSource = `Human baseline: ${human.source}`;
  // The human study scored with the paper's loose SAR-APD matching, so the headline compares like
  // for like with ours (metrics.detector.sar); the strict VOC scores sit underneath.
  const sarSource = `${detectorSource}, SAR-APD loose matching as in the human study (metrics.detector.sar)`;
  const random = randomOrderBaseline(ranking.n_frames, ranking.n_positive);
  const isSample = detector.model === "SAMPLE";

  return (
    <div
      className="flex h-full flex-col gap-3 overflow-y-auto"
      data-testid="metrics"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-title font-medium">
          Detector vs. the human baseline
        </h2>
        {isSample && <Badge kind="placeholder">Sample numbers</Badge>}
        <span className="text-small text-text-3">
          model <span className="font-mono text-text-2">{detector.model}</span>
        </span>
      </div>

      {/* Headline row: recall, precision, speed. Each tile: value, label, comparison, bars. */}
      <Section
        title="People found, real alerts and speed, against the human study"
        plain="Sightline's detector against people searching drone photos by eye in a published study, scored the way that study scored people, so the two compare directly."
      >
        <div className="grid gap-6 sm:grid-cols-3 sm:gap-0 sm:divide-x sm:divide-border">
          <Headline
            value={pct(detector.sar.recall)}
            animate={detector.sar.recall}
            format={(v) => pct(v)}
            label="People found"
            source={sarSource}
            compare={
              <>
                <Num source={humanSource}>{pct(human.recall)}</Num> people (by eye) ·{" "}
                <Delta value={detector.sar.recall} baseline={human.recall} />
              </>
            }
            bars={{ ours: detector.sar.recall, human: human.recall }}
          />
          <Headline
            value={pct(detector.sar.precision)}
            animate={detector.sar.precision}
            format={(v) => pct(v)}
            label="Alerts that are real people"
            source={sarSource}
            compare={
              <>
                <Num source={humanSource}>{pct(human.precision)}</Num> people (by eye) ·{" "}
                <Delta
                  value={detector.sar.precision}
                  baseline={human.precision}
                />
              </>
            }
            bars={{ ours: detector.sar.precision, human: human.precision }}
          />
          <Headline
            value={seconds(detector.seconds_per_image)}
            animate={detector.seconds_per_image}
            format={seconds}
            label="Time per full photo"
            source={`${detectorSource}; time per full 4000×3000 photo (metrics.detector.seconds_per_image), the same unit as the human baseline`}
            compare={
              <>
                <Num source={humanSource}>
                  {seconds(human.seconds_per_image)}
                </Num>{" "}
                people (by eye) ·{" "}
                <span className="text-ok">
                  {speedup(detector.seconds_per_image, human.seconds_per_image)}
                </span>
              </>
            }
            bars={{
              ours:
                detector.seconds_per_image /
                Math.max(human.seconds_per_image, 1e-9),
              human: 1,
              lowerIsBetter: true,
            }}
          />
        </div>
        <div className="mt-5 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-small text-text-3">
          <span>
            Strict VOC scoring (IoU 0.5, the box must match the person closely): people found{" "}
            <Num source={`${detectorSource}, VOC matching (metrics.detector.voc)`}>
              {pct(detector.voc.recall)}
            </Num>{" "}
            · alerts that are real people{" "}
            <Num source={`${detectorSource}, VOC matching (metrics.detector.voc)`}>
              {pct(detector.voc.precision)}
            </Num>{" "}
            · overall score (AP50){" "}
            <Num source={detectorSource}>{pct(detector.voc.ap50)}</Num>
          </span>
          <span>{AP_GLOSS}</span>
        </div>
        <Source>
          People found and real alerts are scored like the human study (SAR-APD loose matching), so the comparison is
          like for like. Ours: {detectorSource}. Human: {human.source}.
        </Source>
      </Section>

      {/* The published state of the art, paired scheme by scheme. */}
      <Section
        title="Against the best published model (AIR)"
        aside="same HERIDAL test photos, each pair scored the same way"
        plain="AIR is the best published model on these test photos. Each pair of rows uses the same scoring, once strict and once like the human study."
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-body" aria-label="State of the art">
            <thead>
              <tr className="text-left text-small text-text-3">
                <th className="py-1 font-normal">Model · scoring</th>
                <th className="py-1 text-right font-normal">Alerts that are real people</th>
                <th className="py-1 text-right font-normal">People found</th>
                <th className="py-1 text-right font-normal">Overall score (AP)</th>
              </tr>
            </thead>
            <tbody>
              {(["voc", "sar"] as const).flatMap((scheme) => {
                const air = AIR_ROWS.find((r) => r.scheme === scheme)!;
                const ours = scheme === "voc" ? detector.voc : detector.sar;
                const oursAp = scheme === "voc" ? detector.voc.ap50 : detector.sar.ap;
                const schemeLabel = scheme === "voc" ? "VOC, IoU 0.5 (strict)" : "SAR-APD (like the human study)";
                return [
                  <Row
                    key={`ours-${scheme}`}
                    label={<>Sightline <span className="text-small text-text-3">· {schemeLabel}</span></>}
                    cells={[pct(ours.precision, 1), pct(ours.recall, 1), pct(oursAp, 1)]}
                    source={`${detectorSource}; ${scheme === "voc" ? "VOC matching at IoU 0.5 (metrics.detector.voc)" : "SAR-APD matching from the AIR paper (metrics.detector.sar)"}`}
                    highlight
                  />,
                  <Row
                    key={`air-${scheme}`}
                    label={<>{air.name} <span className="text-small text-text-3">· {scheme === "voc" ? "VOC2012 (strict)" : "SAR-APD (like the human study)"}</span></>}
                    cells={[pct(air.precision, 1), pct(air.recall, 1), pct(air.ap, 1)]}
                    source={`${AIR_CITATION}, ${scheme === "voc" ? "VOC2012 evaluation" : "SAR-APD evaluation"} (arXiv)`}
                  />,
                ];
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-small text-text-3">
          Strict: the box must match the person closely. Like the human study: a looser match, as that study scored
          people. {AP_GLOSS}
        </p>
        <Source>
          AIR: {AIR_CITATION}, the same paper as the human baseline. Each pair uses the same scoring scheme, but AIR&apos;s
          numbers come from its own evaluation code and ours from our reimplementation, and AIR with MOB merges boxes its
          own way. {AIR_TUNING_NOTE}
        </Source>
      </Section>

      {/* Ablation table. */}
      <Section
        title="What each choice adds"
        aside="each version of the detector, on the test photos"
        plain="Each row is one version of the detector, built a different way, so you can see which choice made the difference."
      >
        <AblationTable
          rows={ablations}
          source={`HERIDAL test set, ${detector.test_images} images (metrics.ablations)`}
        />
      </Section>

      {/* Ranking block (D's numbers): the race above draws the same result. */}
      <Section
        title="Photos reviewed before the first and the last person"
        aside="the race above, as a table"
        plain="How many photos a reviewer looks at before reaching a photo with a person in it, and before reaching the last one. Fewer is better."
      >
        <table className="w-full text-body" aria-label="Ranking">
          <thead>
            <tr className="text-left text-small text-text-3">
              <th className="py-1 font-normal">Order</th>
              <th className="py-1 text-right font-normal">Photos to the first person</th>
              <th className="py-1 text-right font-normal">Photos to the last person</th>
              <th className="py-1 text-right font-normal">Share of all photos</th>
            </tr>
          </thead>
          <tbody>
            <Row
              label="Ranked by detector"
              cells={[
                count(ranking.ranked.frames_to_first_hit),
                count(ranking.ranked.frames_to_all_hits),
                pct(ranking.ranked.frames_to_all_hits / ranking.n_frames, 1),
              ]}
              source={rankingSource(ranking)}
              highlight
            />
            <Row
              label="Random order, expected"
              cells={[
                count(ranking.expected_first_hit_random_order),
                random ? `≈${count(random.expectedAll)}` : "—",
                random ? pct(random.expectedAll / ranking.n_frames, 1) : "—",
              ]}
              source={`First hit (N + 1) / (k + 1), all hits k(N + 1) / (k + 1), for N = ${ranking.n_frames} frames and k = ${ranking.n_positive} with people (metrics.ranking)`}
            />
            <Row
              label={
                <span className="text-text-3">
                  This flight&apos;s order{" "}
                  <span className="text-small">(one layout)</span>
                </span>
              }
              cells={[
                count(ranking.flight_order.frames_to_first_hit),
                count(ranking.flight_order.frames_to_all_hits),
                pct(ranking.flight_order.frames_to_all_hits / ranking.n_frames, 1),
              ]}
              source={`${rankingSource(ranking)}; one seeded layout, not a baseline`}
            />
          </tbody>
        </table>
        {random && (
          <p className="mt-2 text-small text-text-3">
            Random order: the average over random shuffles of the same photos (expected value). In 8 of 10
            shuffles the last photo with a person is between photo{" "}
            <Num source={`Exact 10th and 90th percentile of the last positive's position for N = ${ranking.n_frames}, k = ${ranking.n_positive} (metrics.ranking)`}>
              {count(random.p10All)}
            </Num>{" "}
            and{" "}
            <Num source={`Exact 10th and 90th percentile of the last positive's position for N = ${ranking.n_frames}, k = ${ranking.n_positive} (metrics.ranking)`}>
              {count(random.p90All)}
            </Num>
            .
          </p>
        )}
        <Source>
          {rankingSource(ranking)}. Shown in photos, not minutes: the survey&apos;s photos are 1000×750 sections
          of 4000×3000 HERIDAL photos, and the published human time is per full photo.
        </Source>
      </Section>

      {/* Search simulation (C's numbers). */}
      <Section
        title="Cells a ground team checks before reaching the person"
        aside={sim.simulated ? <Badge kind="simulated">Simulated evaluation</Badge> : undefined}
        plain="The map is split into small squares (cells). A ground team checks them in the order each map suggests, until it reaches the person. Fewer is better."
      >
        {sim.in_survey ? (
          <>
            <SearchTable
              label="Search simulation inside the surveyed area"
              caption="Cells checked inside the surveyed area"
              methods={sim.in_survey.methods}
              source={`${simSource(sim)}; ${sim.in_survey.trials} trials with the person in a photographed cell (metrics.search_sim.in_survey)`}
            />
            <p className="mt-2 text-small text-text-3">
              {count(sim.in_survey.trials)} trials whose person was in a
              photographed cell and the drone missed them (each trial is one
              simulated search). Fewer is better.
            </p>
          </>
        ) : (
          <p className="mt-3 text-small text-text-3">
            Inside-the-survey numbers: not yet measured (this data file is older
            than that measurement).
          </p>
        )}
        <details className="group mt-3">
          <summary className="cursor-pointer text-small text-text-3 hover:text-text-2">
            The whole 1 km grid, and why the methods nearly tie there
          </summary>
          <SearchTable
            label="Search simulation"
            caption="Whole 1 km grid"
            methods={sim.methods}
            source={simSource(sim)}
            secondary={Boolean(sim.in_survey)}
          />
        </details>
        <p className="mt-2 text-small text-text-3">
          Prior only: checks cells by the starting guess (prior) of where a lost person goes, ignoring the drone.
          Naive map (photographed = searched): treats every photographed cell as searched. Sightline: canopy-aware:
          trusts a photo less where trees hide the ground, so forest the drone could not see into stays on the list.
        </p>
        <Source>
          {simSource(sim)}. The drone itself found the person in{" "}
          <Num source={simSource(sim)}>{pct(sim.found_by_drone_rate)}</Num> of
          trials. Across the whole grid the methods nearly tie: most of the
          grid was never photographed and the starting guess is flat, so only the
          surveyed area can separate them.
        </Source>
      </Section>
    </div>
  );
}

/**
 * One collapsed block of the details: a native <details> styled as a glass panel, so the Results
 * page stays short and every table is one click (or Enter) away. Anything a closed block must
 * still say, like a "Simulated" badge, goes in `aside`, which shows in the summary.
 */
function Section({
  title,
  aside,
  plain,
  children,
}: {
  title: string;
  aside?: ReactNode;
  /** One plain sentence for a reader with no statistics: what the table shows and which way is good. */
  plain: string;
  children: ReactNode;
}) {
  return (
    <details
      className={`group rounded-lg border border-border bg-surface backdrop-blur-[16px] ${RIM}`}
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-lg p-4 hover:bg-surface-strong lg:px-6 [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden="true"
          className="font-mono text-text-3 transition-transform group-open:rotate-90 motion-reduce:transition-none"
        >
          ›
        </span>
        <span className="text-body text-text">{title}</span>
        {aside && (
          <span className="text-small text-text-3 sm:ml-auto">{aside}</span>
        )}
      </summary>
      <div className="px-4 pb-4 lg:px-6 lg:pb-6">
        <p data-plain className="mb-3 text-small text-text-2">
          {plain}
        </p>
        {children}
      </div>
    </details>
  );
}


/** One method table. Highlights the row with the fewest median cells, and nothing on a tie. */
function SearchTable({
  label,
  caption,
  methods,
  source,
  secondary = false,
}: {
  label: string;
  caption: string;
  methods: Metrics["search_sim"]["methods"];
  source: string;
  secondary?: boolean;
}) {
  const best = uniqueMinIndex(methods.map((m) => m.median_cells));
  return (
    <table
      className={`mt-3 w-full ${secondary ? "text-small opacity-80" : "text-body"}`}
      aria-label={label}
    >
      <caption className="pb-1 text-left text-small text-text-3">
        {caption}
      </caption>
      <thead>
        <tr className="text-left text-small text-text-3">
          <th className="py-1 font-normal">Search order</th>
          <th className="py-1 text-right font-normal">Typical (median)</th>
          <th className="py-1 text-right font-normal">9 in 10 searches (90th percentile)</th>
        </tr>
      </thead>
      <tbody>
        {methods.map((method, i) => (
          <Row
            key={method.name}
            label={method.name}
            cells={[count(method.median_cells), count(method.p90_cells)]}
            source={source}
            highlight={i === best}
          />
        ))}
      </tbody>
    </table>
  );
}

function rankingSource(r: Metrics["ranking"]): string {
  return `Demo survey, ${r.n_frames} frames, ${r.n_positive} with people (metrics.ranking)`;
}

function simSource(s: Metrics["search_sim"]): string {
  return `Simulated search, ${s.trials} trials, seed ${s.seed} (metrics.search_sim)`;
}

/** A number with its source as a tooltip. Every figure on this screen goes through here. */
function Num({ children, source }: { children: ReactNode; source: string }) {
  return (
    <span title={source} className="font-mono tabular-nums text-text">
      {children}
    </span>
  );
}

function Delta({ value, baseline }: { value: number; baseline: number }) {
  const better = value >= baseline;
  return (
    <span className={better ? "text-ok" : "text-warn"}>
      {deltaPts(value, baseline)} {better ? "better" : "worse"}
    </span>
  );
}

/** Counting headline number; the final string is also the accessible value. */
function CountingNum({
  target,
  final,
  format,
  source,
}: {
  target: number;
  final: string;
  format: (v: number) => string;
  source: string;
}) {
  const shown = useCountUp(target);
  const done = shown === target;
  return (
    <span
      title={source}
      className="font-mono tabular-nums text-text"
      aria-label={final}
    >
      <span aria-hidden={!done}>{done ? final : format(shown)}</span>
    </span>
  );
}

/**
 * Two thin bars: ours in the accent, human in the muted text colour. A comparison you can read
 * from across the room; the exact figures sit right above (HIG: charts for patterns, text for
 * exact values).
 */
function CompareBars({
  ours,
  human,
  lowerIsBetter = false,
}: {
  ours: number;
  human: number;
  lowerIsBetter?: boolean;
}) {
  const max = Math.max(ours, human, 1e-9);
  const width = (v: number) =>
    `${Math.max(2, Math.min(100, (v / max) * 100))}%`;
  return (
    <div
      className="mt-1 flex flex-col gap-1"
      role="img"
      aria-label={`Ours ${lowerIsBetter ? "lower" : "higher"} is better; bars compare ours to human`}
    >
      <div className="h-1 w-full rounded-full bg-surface-strong">
        <div
          className="h-1 rounded-full bg-accent"
          style={{ width: width(ours) }}
        />
      </div>
      <div className="h-1 w-full rounded-full bg-surface-strong">
        <div
          className="h-1 rounded-full bg-text-3"
          style={{ width: width(human) }}
        />
      </div>
      <div className="flex justify-between font-mono text-label uppercase tracking-label text-text-3">
        <span>
          <span className="text-accent-soft">■</span> ours
        </span>
        <span>human ■</span>
      </div>
    </div>
  );
}

function Headline({
  value,
  animate,
  format,
  label,
  source,
  compare,
  bars,
}: {
  value: string;
  animate: number;
  format: (v: number) => string;
  label: string;
  source: string;
  compare: ReactNode;
  bars: { ours: number; human: number; lowerIsBetter?: boolean };
}) {
  return (
    <div className="flex flex-col gap-2 sm:px-6 sm:first:pl-0 sm:last:pr-0">
      <Stat
        value={
          <CountingNum
            target={animate}
            final={value}
            format={format}
            source={source}
          />
        }
        label={label}
      />
      <span className="text-small text-text-2">{compare}</span>
      <CompareBars {...bars} />
    </div>
  );
}

function Source({ children }: { children: ReactNode }) {
  return <p className="mt-4 text-small text-text-3">Source: {children}</p>;
}

function Row({
  label,
  cells,
  source,
  highlight = false,
}: {
  label: ReactNode;
  cells: string[];
  source: string;
  highlight?: boolean;
}) {
  return (
    <tr
      data-highlight={highlight || undefined}
      className={highlight ? "text-text" : "text-text-2"}
    >
      <th scope="row" className="py-1.5 pr-3 text-left font-normal">
        {highlight ? <span className="text-accent-soft">{label}</span> : label}
      </th>
      {cells.map((cell, i) => (
        <td key={i} className="py-1.5 pl-3 text-right">
          <Num source={source}>{cell}</Num>
        </td>
      ))}
    </tr>
  );
}

function AblationTable({
  rows,
  source,
}: {
  rows: Metrics["ablations"];
  source: string;
}) {
  const display = ablationDisplayRows(rows);
  return (
    <>
      <table className="w-full text-body" aria-label="Ablations">
        <thead>
          <tr className="text-left text-small text-text-3">
            <th className="py-1 font-normal">Version</th>
            <th className="py-1 text-right font-normal">Alerts that are real people</th>
            <th className="py-1 text-right font-normal">People found</th>
            <th className="py-1 text-right font-normal">Overall score (AP50)</th>
          </tr>
        </thead>
        <tbody>
          {display.map((row) => {
            const inUse = row.name === IN_USE_ROW;
            const sub = ablationSubLabel(row.name);
            const label = (
              <>
                {row.name}
                {inUse && (
                  <span className="ml-2 font-mono text-label uppercase tracking-label text-accent">
                    in use
                  </span>
                )}
                {sub && (
                  <span className="block text-small text-text-3">
                    {sub}
                  </span>
                )}
              </>
            );
            if (!row.measured) {
              // Never show a placeholder as a result: say plainly that it hasn't been measured.
              return (
                <tr
                  key={row.name}
                  data-measured="false"
                  className="text-text-3"
                >
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                    {label}
                  </th>
                  <td colSpan={3} className="py-1.5 pl-3 text-right">
                    <Badge kind="placeholder">Not yet measured</Badge>
                  </td>
                </tr>
              );
            }
            return (
              <Row
                key={row.name}
                label={label}
                cells={[
                  pct(row.voc.precision, 1),
                  pct(row.voc.recall, 1),
                  pct(row.voc.ap50, 1),
                ]}
                source={`${source}; each row at its own threshold, chosen on validation`}
                highlight={inUse}
              />
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-small text-text-3">
        Stock: the off-the-shelf model. Fine-tuned: trained further on search-and-rescue photos. Tiling: cutting each
        photo into tiles, so a person a few pixels wide is not shrunk away. Hard negatives: extra training on spots
        where it raised a false alarm. All rows use strict scoring (the box must match the person closely), each at its
        own confidence cut-off. {AP_GLOSS}
      </p>
      <Source>
        {source}; VOC scoring, each row at its own threshold chosen on validation. &ldquo;In use&rdquo; marks the
        detector the app runs, not the best score.
      </Source>
    </>
  );
}
