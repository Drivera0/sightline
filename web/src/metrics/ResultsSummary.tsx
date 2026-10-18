import type { ReactNode } from "react";
import type { Metrics } from "../contract";
import { Badge, Label } from "../shell/components";
import { count, pct } from "./format";

/** The three numbers to say out loud, each with its comparison and source. Full tables follow below it. */
export function ResultsSummary({ metrics }: { metrics: Metrics }) {
  const { detector, baseline_human: human, ranking, search_sim: sim } = metrics;
  const inside = sim.in_survey;
  const byName = (name: string) => inside?.methods.find((m) => m.name.startsWith(name));
  const sightline = byName("Sightline");
  const naive = byName("Naive");
  return (
    <section aria-label="Results" className="grid gap-4 md:grid-cols-3">
      <Headline
        label="Recall"
        value={pct(detector.voc.recall)}
        versus={`Human ${pct(human.recall)}`}
        source={`HERIDAL test set, ${detector.test_images} images (metrics.detector) vs ${human.source}`}
      >
        People found on photos the detector never trained on
      </Headline>
      <Headline
        label="First person"
        value={`Photo ${count(ranking.ranked.frames_to_first_hit)}`}
        versus={`Random order ≈ ${count(ranking.expected_first_hit_random_order)}`}
        source={`Demo survey, ${ranking.n_frames} frames (metrics.ranking)`}
      >
        Position of the first real person in the ranked queue
      </Headline>
      {sightline && naive && inside ? (
        <Headline
          label="Cells to search"
          value={count(sightline.median_cells)}
          versus={`Naive map ${count(naive.median_cells)}`}
          source={`Simulated search, ${inside.trials} trials with the person in a photographed cell (metrics.search_sim.in_survey)`}
          badge={<Badge kind="simulated">Simulated</Badge>}
        >
          Median cells a ground team checks inside the surveyed area
        </Headline>
      ) : (
        <Headline label="Cells to search" value="—" versus="Not yet measured" source="metrics.search_sim.in_survey">
          Needs a cache built with contract 1.1
        </Headline>
      )}
    </section>
  );
}

function Headline({
  label,
  value,
  versus,
  source,
  badge,
  children,
}: {
  label: string;
  value: string;
  versus: string;
  source: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="sl-rise flex flex-col gap-2 rounded-lg border border-border bg-surface p-5" title={source}>
      <div className="flex items-center justify-between gap-2">
        <Label>{label}</Label>
        {badge}
      </div>
      <span className="font-mono text-[44px] leading-none text-text">{value}</span>
      <span className="text-small text-accent-soft">{versus}</span>
      <span className="text-small text-text-3">{children}</span>
    </div>
  );
}
