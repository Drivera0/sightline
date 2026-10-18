import type { ReactNode } from "react";
import type { Metrics } from "../contract";
import { useCache } from "../lib/cache";
import { Badge, EmptyState, Label, Panel, Stat } from "../shell/components";
import {
  ablationDisplayRows,
  bestByAp50,
  count,
  deltaPts,
  isResizedRow,
  minutes,
  pct,
  seconds,
  speedup,
  uniqueMinIndex,
} from "./format";
import { useCountUp } from "./motion";

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
  const isSample = detector.model === "SAMPLE";

  return (
    <div
      className="flex h-full flex-col gap-4 overflow-y-auto"
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
      <Panel className={RIM}>
        <div className="grid gap-6 sm:grid-cols-3 sm:gap-0 sm:divide-x sm:divide-border">
          <Headline
            value={pct(detector.voc.recall)}
            animate={detector.voc.recall}
            format={(v) => pct(v)}
            label="Recall"
            source={detectorSource}
            compare={
              <>
                <Num source={humanSource}>{pct(human.recall)}</Num> human ·{" "}
                <Delta value={detector.voc.recall} baseline={human.recall} />
              </>
            }
            bars={{ ours: detector.voc.recall, human: human.recall }}
          />
          <Headline
            value={pct(detector.voc.precision)}
            animate={detector.voc.precision}
            format={(v) => pct(v)}
            label="Precision"
            source={detectorSource}
            compare={
              <>
                <Num source={humanSource}>{pct(human.precision)}</Num> human ·{" "}
                <Delta
                  value={detector.voc.precision}
                  baseline={human.precision}
                />
              </>
            }
            bars={{ ours: detector.voc.precision, human: human.precision }}
          />
          <Headline
            value={seconds(detector.seconds_per_image)}
            animate={detector.seconds_per_image}
            format={seconds}
            label="Per photo"
            source={detectorSource}
            compare={
              <>
                <Num source={humanSource}>
                  {seconds(human.seconds_per_image)}
                </Num>{" "}
                human ·{" "}
                <span className="text-accent-soft">
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
            AP50 <Num source={detectorSource}>{pct(detector.voc.ap50)}</Num>
          </span>
          <span>
            SAR-style (approx. AIR): precision{" "}
            <Num
              source={`${detectorSource}, loose matching from the AIR paper`}
            >
              {pct(detector.sar.precision)}
            </Num>{" "}
            · recall{" "}
            <Num
              source={`${detectorSource}, loose matching from the AIR paper`}
            >
              {pct(detector.sar.recall)}
            </Num>
          </span>
        </div>
        <Source>
          Ours: {detectorSource}. Human: {human.source}.
        </Source>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {/* Ablation table. */}
        <Panel className={RIM}>
          <AblationTable rows={ablations} source={detectorSource} />
        </Panel>

        {/* Ranking block (D's numbers). */}
        <Panel className={RIM}>
          <Label>Frames reviewed before the first person</Label>
          <table className="mt-3 w-full text-body" aria-label="Ranking">
            <thead>
              <tr className="text-left text-small text-text-3">
                <th className="py-1 font-normal">Order</th>
                <th className="py-1 text-right font-normal">First hit</th>
                <th className="py-1 text-right font-normal">All hits</th>
                <th className="py-1 text-right font-normal">At human pace</th>
              </tr>
            </thead>
            <tbody>
              <Row
                label="Ranked by detector"
                cells={[
                  count(ranking.ranked.frames_to_first_hit),
                  count(ranking.ranked.frames_to_all_hits),
                  minutes(ranking.minutes_at_human_pace.ranked_first),
                ]}
                source={rankingSource(ranking)}
                highlight
              />
              <Row
                label="Random order, expected"
                cells={[
                  count(ranking.expected_first_hit_random_order),
                  "—",
                  minutes(
                    (ranking.expected_first_hit_random_order *
                      HUMAN_SECONDS_PER_PHOTO) /
                      60,
                  ),
                ]}
                source={`(N + 1) / (k + 1) for ${ranking.n_frames} frames and ${ranking.n_positive} with people (metrics.ranking); minutes at the published ${HUMAN_SECONDS_PER_PHOTO} s per photo (Pyrrö et al. 2021)`}
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
                  minutes(ranking.minutes_at_human_pace.flight_order_first),
                ]}
                source={`${rankingSource(ranking)}; one seeded layout, not a baseline`}
              />
            </tbody>
          </table>
          <Source>
            {rankingSource(ranking)}. {ranking.note}
          </Source>
        </Panel>

        {/* Search simulation (C's numbers). */}
        <Panel className={`${RIM} lg:col-span-2 xl:col-span-1`}>
          <div className="flex flex-wrap items-center gap-3">
            <Label>Cells a ground team checks before reaching the person</Label>
            {sim.simulated && (
              <Badge kind="simulated">Simulated evaluation</Badge>
            )}
          </div>
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
                photographed cell and the drone missed them. Lower is better.
              </p>
            </>
          ) : (
            <p className="mt-3 text-small text-text-3">
              Inside-the-survey numbers: not yet measured (this cache predates
              contract 1.1).
            </p>
          )}
          <SearchTable
            label="Search simulation"
            caption="Whole 1 km grid"
            methods={sim.methods}
            source={simSource(sim)}
            secondary={Boolean(sim.in_survey)}
          />
          <Source>
            {simSource(sim)}. The drone itself found the person in{" "}
            <Num source={simSource(sim)}>{pct(sim.found_by_drone_rate)}</Num> of
            trials. Across the whole grid the methods nearly tie: most of the
            grid was never photographed and the prior is flat, so only the
            surveyed area can separate them.
          </Source>
        </Panel>
      </div>
    </div>
  );
}

const HUMAN_SECONDS_PER_PHOTO = 33; // Pyrrö et al. 2021, the published human baseline

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
          <th className="py-1 font-normal">Method</th>
          <th className="py-1 text-right font-normal">Median</th>
          <th className="py-1 text-right font-normal">90th percentile</th>
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
  const measured = display.flatMap((r) => (r.measured ? [r] : []));
  const bestName = measured[bestByAp50(measured)]?.name;
  return (
    <>
      <Label>What each technique adds</Label>
      <table className="mt-3 w-full text-body" aria-label="Ablations">
        <thead>
          <tr className="text-left text-small text-text-3">
            <th className="py-1 font-normal">Variant</th>
            <th className="py-1 text-right font-normal">Precision</th>
            <th className="py-1 text-right font-normal">Recall</th>
            <th className="py-1 text-right font-normal">AP50</th>
          </tr>
        </thead>
        <tbody>
          {display.map((row) => {
            const label = (
              <>
                {row.name}
                {isResizedRow(row.name) && (
                  <span className="block text-small text-text-3">
                    resized to 1024
                  </span>
                )}
                {row.name === bestName && (
                  <span className="ml-2 font-mono text-label uppercase tracking-label text-accent">
                    best
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
                source={`${source}; same threshold rule for every row (metrics.ablations)`}
                highlight={row.name === bestName}
              />
            );
          })}
        </tbody>
      </table>
      <Source>{source}; same scoring and threshold rule for every row.</Source>
    </>
  );
}
