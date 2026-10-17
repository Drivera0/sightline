import type { ReactNode } from "react";
import type { Metrics } from "../contract";
import { useCache } from "../lib/cache";
import { Badge, EmptyState, Label, Panel, Stat } from "../shell/components";
import {
  bestByAp50,
  count,
  deltaPts,
  isResizedRow,
  minutes,
  pct,
  seconds,
  speedup,
} from "./format";

/**
 * Lane A's screen (LANE_A_ML.md §9): detector vs. the human baseline, the ablation table,
 * D's ranking result and C's search simulation. Reads `metrics.json` only. Every number
 * carries its source as a tooltip, and the panel footer repeats it.
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

function MetricsBody({ m }: { m: Metrics }) {
  const { detector, baseline_human: human, ablations, ranking, search_sim: sim } = m;

  const detectorSource = `HERIDAL test set, ${detector.test_images} images, ${
    detector.tiled ? "tiled" : "untiled"
  } inference at threshold ${detector.threshold} (metrics.detector)`;
  const humanSource = `Human baseline: ${human.source}`;
  const isSample = detector.model === "SAMPLE";

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto" data-testid="metrics">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-title font-medium">Detector vs. the human baseline</h2>
        {isSample && <Badge kind="placeholder">Sample numbers</Badge>}
        <span className="text-small text-text-3">
          model <span className="font-mono text-text-2">{detector.model}</span>
        </span>
      </div>

      {/* Headline row: recall, precision, speed. */}
      <Panel>
        <div className="grid gap-6 sm:grid-cols-3">
          <Headline
            value={<Num source={detectorSource}>{pct(detector.voc.recall)}</Num>}
            label="Recall"
            compare={
              <>
                <Num source={humanSource}>{pct(human.recall)}</Num> human ·{" "}
                <Delta value={detector.voc.recall} baseline={human.recall} />
              </>
            }
          />
          <Headline
            value={<Num source={detectorSource}>{pct(detector.voc.precision)}</Num>}
            label="Precision"
            compare={
              <>
                <Num source={humanSource}>{pct(human.precision)}</Num> human ·{" "}
                <Delta value={detector.voc.precision} baseline={human.precision} />
              </>
            }
          />
          <Headline
            value={<Num source={detectorSource}>{seconds(detector.seconds_per_image)}</Num>}
            label="Per photo"
            compare={
              <>
                <Num source={humanSource}>{seconds(human.seconds_per_image)}</Num> human ·{" "}
                <span className="text-accent-soft">
                  {speedup(detector.seconds_per_image, human.seconds_per_image)}
                </span>
              </>
            }
          />
        </div>
        <div className="mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-small text-text-3">
          <span>
            AP50 <Num source={detectorSource}>{pct(detector.voc.ap50)}</Num>
          </span>
          <span>
            SAR-style (approx. AIR): precision{" "}
            <Num source={`${detectorSource}, loose matching from the AIR paper`}>
              {pct(detector.sar.precision)}
            </Num>{" "}
            · recall{" "}
            <Num source={`${detectorSource}, loose matching from the AIR paper`}>
              {pct(detector.sar.recall)}
            </Num>
          </span>
        </div>
        <Source>
          Ours: {detectorSource}. Human: {human.source}.
        </Source>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Ablation table. */}
        <Panel>
          <AblationTable rows={ablations} source={detectorSource} />
        </Panel>

        {/* Ranking block (D's numbers). */}
        <Panel>
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
                label="Flight order"
                cells={[
                  count(ranking.flight_order.frames_to_first_hit),
                  count(ranking.flight_order.frames_to_all_hits),
                  minutes(ranking.minutes_at_human_pace.flight_order_first),
                ]}
                source={rankingSource(ranking)}
              />
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
                cells={[count(ranking.expected_first_hit_random_order), "—", "—"]}
                source={`(N + 1) / (k + 1) for ${ranking.n_frames} frames and ${ranking.n_positive} with people (metrics.ranking)`}
              />
            </tbody>
          </table>
          <Source>
            {rankingSource(ranking)}. {ranking.note}
          </Source>
        </Panel>
      </div>

      {/* Search simulation (C's numbers). */}
      <Panel>
        <div className="flex flex-wrap items-center gap-3">
          <Label>Cells a ground team checks before reaching the person</Label>
          {sim.simulated && <Badge kind="simulated">Simulated evaluation</Badge>}
        </div>
        <table className="mt-3 w-full text-body" aria-label="Search simulation">
          <thead>
            <tr className="text-left text-small text-text-3">
              <th className="py-1 font-normal">Method</th>
              <th className="py-1 text-right font-normal">Median</th>
              <th className="py-1 text-right font-normal">90th percentile</th>
            </tr>
          </thead>
          <tbody>
            {sim.methods.map((method, i) => (
              <Row
                key={method.name}
                label={method.name}
                cells={[count(method.median_cells), count(method.p90_cells)]}
                source={simSource(sim)}
                highlight={i === sim.methods.length - 1}
              />
            ))}
          </tbody>
        </table>
        <Source>
          {simSource(sim)}. The drone itself found the person in{" "}
          <Num source={simSource(sim)}>{pct(sim.found_by_drone_rate)}</Num> of trials; the rows count
          the remaining trials. Lower is better.
        </Source>
      </Panel>
    </div>
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

function Headline({
  value,
  label,
  compare,
}: {
  value: ReactNode;
  label: string;
  compare: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Stat value={value} label={label} />
      <span className="text-small text-text-2">{compare}</span>
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

function AblationTable({ rows, source }: { rows: Metrics["ablations"]; source: string }) {
  const best = bestByAp50(rows);
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
          {rows.map((row, i) => (
            <Row
              key={row.name}
              label={
                <>
                  {row.name}
                  {isResizedRow(row.name) && (
                    <span className="text-small text-text-3"> (resized to 1024)</span>
                  )}
                  {i === best && (
                    <span className="ml-2 font-mono text-label uppercase tracking-label text-accent">
                      best
                    </span>
                  )}
                </>
              }
              cells={[pct(row.voc.precision, 1), pct(row.voc.recall, 1), pct(row.voc.ap50, 1)]}
              source={`${source}; same threshold rule for every row (metrics.ablations)`}
              highlight={i === best}
            />
          ))}
        </tbody>
      </table>
      <Source>{source}; same scoring and threshold rule for every row.</Source>
    </>
  );
}
