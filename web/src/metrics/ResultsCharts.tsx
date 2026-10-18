import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Metrics } from "../contract";
import { Badge, Label } from "../shell/components";
import { Sourced } from "../shell/Popover";
import { ablationDisplayRows, duration, IN_USE_ROW, pct, seconds } from "./format";
import { AIR_CITATION, AIR_ROWS } from "./publishedSota";

/**
 * Four charts under the Results cards, each answering one question a visitor asks: how long does
 * reading a survey take, where does the detector sit against people and the published model, does
 * the search map's gain survive a worse canopy estimate, and where does the detector miss people.
 * Numbers come from metrics.json or, where the contract has no field, from a cited doc table
 * (like publishedSota.ts), never invented.
 */
export function ResultsCharts({
  metrics,
  surveyId,
  cellM,
}: {
  metrics: Metrics;
  surveyId?: string;
  cellM?: number;
}) {
  const robustness = robustnessFor(metrics, surveyId, cellM);
  return (
    <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
      <TimeChart metrics={metrics} />
      <PrecisionRecallMap metrics={metrics} />
      {robustness && <RobustnessChart rows={robustness} cellM={cellM!} />}
      <MissesChart overall={metrics.detector.voc.recall} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Cited tables (no contract field holds these).

/**
 * Recall by HERIDAL test site, docs/DETECTOR_LIMITS.md §2 ("Which misses dominate"), final model
 * on the corrected labels. CAP and GRO, and the six sites with no misses, are grouped as there.
 */
export const MISSES_BY_SITE: readonly { label: string; people: number; missed: number; sites?: string }[] = [
  { label: "MED", people: 52, missed: 16 },
  { label: "CAB", people: 34, missed: 12 },
  { label: "ZRI", people: 47, missed: 8 },
  { label: "BLI", people: 46, missed: 6 },
  { label: "CAP, GRO", people: 40, missed: 4 },
  { label: "6 other sites", people: 118, missed: 0, sites: "BRA, BRK, BRS, MOB, SB, TRS" },
];

/** Recall by person size (√ box area), docs/DETECTOR_LIMITS.md §2. */
export const MISSES_BY_SIZE: readonly { label: string; people: number; recall: number }[] = [
  { label: "tiny (< 40 px)", people: 34, recall: 0.88 },
  { label: "small (40–60 px)", people: 175, recall: 0.83 },
  { label: "medium (60–90 px)", people: 118, recall: 0.92 },
  { label: "large (90 px +)", people: 10, recall: 0.7 },
];

/**
 * In-survey median cells on the 5 m demo cache at five canopy-noise levels, seeds 7 / 8 / 9:
 * docs/LANE_C_SEARCH.md, "Robustness", the 5 m table. 0.43 matches the canopy estimate's measured
 * error (MAE 0.34, σ ≈ 0.43). Measured on the seymour-demo run only, so it is shown only there.
 */
export const ROBUSTNESS_5M: readonly { noise: number; naive: readonly number[]; sightline: readonly number[] }[] = [
  { noise: 0.15, naive: [1743, 1684, 1791], sightline: [1213, 1211, 1298] },
  { noise: 0.25, naive: [1779, 1735, 1789], sightline: [1284, 1260, 1367] },
  { noise: 0.35, naive: [1788, 1741, 1862], sightline: [1356, 1339, 1457] },
  { noise: 0.43, naive: [1810, 1775, 1879], sightline: [1395, 1407, 1516] },
  { noise: 0.55, naive: [1825, 1790, 1926], sightline: [1448, 1476, 1606] },
];
const MEASURED_NOISE = 0.43;
const ROBUSTNESS_SOURCE =
  "docs/LANE_C_SEARCH.md, Robustness, 5 m table: simulate on the demo's 5 m map, 30,000 trials per run, seeds 7, 8, 9; in-survey median cells";

/** The robustness rows, only for the run they were measured on (survey, 5 m cells, seed 7's numbers). */
function robustnessFor(metrics: Metrics, surveyId?: string, cellM?: number) {
  const inside = metrics.search_sim.in_survey;
  const ours = inside?.methods.find((m) => m.name.startsWith("Sightline"))?.median_cells;
  const naive = inside?.methods.find((m) => m.name.startsWith("Naive"))?.median_cells;
  const first = ROBUSTNESS_5M[0]!;
  const same =
    surveyId === "seymour-demo" &&
    cellM === 5 &&
    metrics.search_sim.seed === 7 &&
    ours === first.sightline[0] &&
    naive === first.naive[0];
  return same ? ROBUSTNESS_5M : null;
}

// ---------------------------------------------------------------------------------------------
// Shared pieces.

/** The rendered width of an element, for SVG drawn 1:1 in CSS pixels (text never scales down). */
function useWidth(fallback = 480) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(260, Math.round(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** A chart card: the question as its accessible name, the answer as a line under it, its source. */
function ChartCard({
  title,
  insight,
  source,
  badge,
  children,
  footnote,
}: {
  title: string;
  insight: ReactNode;
  source: string;
  badge?: ReactNode;
  children: ReactNode;
  footnote?: ReactNode;
}) {
  const id = useId();
  return (
    <figure
      aria-labelledby={id}
      className="sl-rise m-0 flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <Sourced source={source}>
          <Label id={id}>{title}</Label>
        </Sourced>
        {badge}
      </div>
      <p className="text-body text-text">{insight}</p>
      {children}
      {footnote && <figcaption className="text-label text-text-3">{footnote}</figcaption>}
    </figure>
  );
}

const SVG_TEXT = { fontSize: 11 } as const;

// ---------------------------------------------------------------------------------------------
// 1. Time to read a survey.

/** A survey size to read the per-photo times against: full 4000×3000 photos, not the demo's sections. */
const SURVEY_FULL_PHOTOS = 500;

function TimeChart({ metrics }: { metrics: Metrics }) {
  const human = SURVEY_FULL_PHOTOS * metrics.baseline_human.seconds_per_image;
  const detector = SURVEY_FULL_PHOTOS * metrics.detector.seconds_per_image;
  const rows = [
    { label: "A person, by eye", value: human, accent: false },
    { label: "Sightline", value: detector, accent: true },
  ];
  return (
    <ChartCard
      title={`Time to read a survey of ${SURVEY_FULL_PHOTOS} full photos`}
      insight={
        <>
          By eye: {duration(human)}. The detector reads them all in {duration(detector)}, then puts the likeliest
          photos first for a person to check.
        </>
      }
      source={`${SURVEY_FULL_PHOTOS} × per-photo time: ${seconds(metrics.baseline_human.seconds_per_image)} by eye (${metrics.baseline_human.source}); ${seconds(metrics.detector.seconds_per_image)} for the detector (metrics.detector.seconds_per_image)`}
      footnote="Per full 4000×3000 photo. The demo survey's frames are sections of full photos, so this is a survey of the size a team flies, not the demo's 500 frames."
    >
      <ul className="flex flex-col gap-3" aria-label="Time to read every photo">
        {rows.map((r) => (
          <li key={r.label} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] items-center gap-3">
            <span className={"text-small " + (r.accent ? "font-medium text-text" : "text-text-2")}>{r.label}</span>
            {/* Value at the bar's tip, outside it, so a 0.8% bar still reads. */}
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={"sl-grow block h-3 shrink-0 rounded-r-[4px] " + (r.accent ? "bg-accent" : "bg-text-3/60")}
                style={{ width: `calc(${Math.max(0.8, (r.value / human) * 100)}% - 5.5rem)`, minWidth: 4 }}
              />
              <span className="whitespace-nowrap font-mono text-small text-text">{duration(r.value)}</span>
            </span>
          </li>
        ))}
      </ul>
    </ChartCard>
  );
}

// ---------------------------------------------------------------------------------------------
// 2. Precision and recall map.

const SHORT_NAMES: Record<string, string> = {
  "Stock model, no tiling": "Stock, shrunk photo",
  "Fine-tuned on tiles, run on shrunk photos": "Fine-tuned, shrunk photo",
  "Stock model, full-resolution photo": "Stock, full-resolution photo",
  "Fine-tuned on tiles, full-resolution photo": "Fine-tuned, one 4000 px pass",
  "Trained and run on whole photos": "Trained on 1920 px photos",
  [IN_USE_ROW]: "Sightline (in use)",
  "+ hard negatives": "+ hard negatives (not kept)",
};

type Shape = "dot" | "diamond" | "square";
interface PrPoint {
  name: string;
  /** The row name in the screen-reader table, when it differs from the visible label. */
  tableName?: string;
  recall: number;
  precision: number;
  shape: Shape;
  accent?: boolean;
  /** Direct label beside the mark (selective: the points the story is about). */
  label?: string;
  labelAt?: "left-below" | "left-above" | "right" | "below-leader";
}

function PrecisionRecallMap({ metrics }: { metrics: Metrics }) {
  const [scheme, setScheme] = useState<"voc" | "sar">("voc");
  const [ref, width] = useWidth();
  const airVoc = AIR_ROWS.find((r) => r.scheme === "voc")!;
  const airSar = AIR_ROWS.find((r) => r.scheme === "sar")!;
  const variants: PrPoint[] = ablationDisplayRows(metrics.ablations).flatMap((r) =>
    r.measured
      ? [
          {
            name: SHORT_NAMES[r.name] ?? r.name,
            tableName: r.name === IN_USE_ROW ? "Fine-tuned + tiling (Sightline, in use)" : undefined,
            recall: r.voc.recall,
            precision: r.voc.precision,
            shape: "dot" as const,
            accent: r.name === IN_USE_ROW,
            label: r.name === IN_USE_ROW ? "Sightline (in use)" : undefined,
            labelAt: "below-leader" as const,
          },
        ]
      : [],
  );
  const points: PrPoint[] =
    scheme === "voc"
      ? [
          ...variants,
          {
            name: "AIR (Pyrrö et al. 2021)",
            recall: airVoc.recall,
            precision: airVoc.precision,
            shape: "diamond",
            label: "AIR",
            labelAt: "left-above",
          },
        ]
      : [
          {
            name: "Sightline",
            tableName: "Sightline detector",
            recall: metrics.detector.sar.recall,
            precision: metrics.detector.sar.precision,
            shape: "dot",
            accent: true,
            label: "Sightline",
            labelAt: "below-leader",
          },
          {
            name: "AIR (Pyrrö et al. 2021)",
            recall: airSar.recall,
            precision: airSar.precision,
            shape: "diamond",
            label: "AIR",
            labelAt: "left-above",
          },
          {
            name: "People",
            tableName: "People (human study)",
            recall: metrics.baseline_human.recall,
            precision: metrics.baseline_human.precision,
            shape: "square",
            label: "People",
            labelAt: "right",
          },
        ];

  const h = 320;
  const m = { l: 44, r: 16, t: 16, b: 40 };
  const x = (v: number) => m.l + v * (width - m.l - m.r);
  const y = (v: number) => h - m.b - v * (h - m.t - m.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const button = (on: boolean) =>
    "rounded-full border px-3 py-1 text-label " +
    (on ? "border-text-2 bg-surface-strong text-text" : "border-border text-text-3 hover:text-text-2");

  return (
    <ChartCard
      title="How many people it finds, and how often its alerts are right"
      insight={
        scheme === "voc" ? (
          <>Looking at photos at full detail moves a model from the bottom left to the top right. Ours finds as many people as AIR, the best published model, but more of its alerts turn out not to be people.</>
        ) : (
          <>Scored the way the published study scored people looking by eye: Sightline and AIR both find more people than people do, with fewer false alarms.</>
        )
      }
      source={`metrics.ablations (strict VOC) and metrics.detector.sar; people: ${metrics.baseline_human.source}; AIR: ${AIR_CITATION}`}
      footnote="Top right is best: finds everyone, and every alert is a real person. Hover or tab to a point for its numbers. Each dot is one version of the detector we tested on 101 photos it never trained on. AIR (Pyrrö et al. 2021) is the best published model on these photos; its cut-off was tuned on those same test photos, ours on separate ones."
    >
      {/* One filter row above the plot it scopes. */}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Scoring">
        <button type="button" aria-pressed={scheme === "voc"} className={button(scheme === "voc")} onClick={() => setScheme("voc")}>
          Strict scoring (box must match the person closely)
        </button>
        <button type="button" aria-pressed={scheme === "sar"} className={button(scheme === "sar")} onClick={() => setScheme("sar")}>
          Scored like the human study
        </button>
      </div>
      <div ref={ref} className="w-full">
        <svg width={width} height={h} role="img" aria-label="Precision against recall" className="block overflow-visible">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x(0)} x2={x(1)} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth={1} />
              <line y1={y(0)} y2={y(1)} x1={x(t)} x2={x(t)} className="stroke-border" strokeWidth={1} />
              <text x={x(t)} y={h - m.b + 16} textAnchor="middle" className="fill-text-3" style={SVG_TEXT}>
                {pct(t)}
              </text>
              <text x={m.l - 8} y={y(t) + 4} textAnchor="end" className="fill-text-3" style={SVG_TEXT}>
                {pct(t)}
              </text>
            </g>
          ))}
          <text x={x(0.5)} y={h - 4} textAnchor="middle" className="fill-text-2" style={SVG_TEXT}>
            People found →
          </text>
          <text x={m.l} y={m.t - 2} className="fill-text-2" style={SVG_TEXT}>
            ↑ Alerts that are real people
          </text>
          {[...points].sort((a, b) => Number(!!a.accent) - Number(!!b.accent)).map((p) => (
            <PrMark key={p.name} p={p} cx={x(p.recall)} cy={y(p.precision)} />
          ))}
        </svg>
      </div>
      <table className="sr-only">
        <caption>People found and alerts that are real people, {scheme === "voc" ? "strict scoring" : "scored like the human study"}</caption>
        <thead>
          <tr>
            <th scope="col">Detector</th>
            <th scope="col">People found</th>
            <th scope="col">Alerts that are real people</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.name}>
              <th scope="row">{p.tableName ?? p.name}</th>
              <td>{pct(p.recall)}</td>
              <td>{pct(p.precision)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ChartCard>
  );
}

function PrMark({ p, cx, cy }: { p: PrPoint; cx: number; cy: number }) {
  const fill = p.accent ? "fill-accent" : p.shape === "dot" ? "fill-text-3" : "fill-text-2";
  const ring = "stroke-bg";
  // "below-leader": the label sits in the empty space under a crowded cluster, tied to its mark by a line.
  const leader = p.labelAt === "below-leader";
  const lx = p.labelAt === "right" ? cx + 10 : leader ? cx - 6 : cx - 10;
  const ly = p.labelAt === "left-above" ? cy - 9 : p.labelAt === "right" ? cy + 4 : leader ? cy + 40 : cy + 16;
  return (
    <g data-point tabIndex={0} aria-label={`${p.name}: finds ${pct(p.recall)} of people; ${pct(p.precision)} of its alerts are real people`} className="focus:outline-none focus-visible:[&>circle:last-of-type]:stroke-text">
      <title>{`${p.name}: finds ${pct(p.recall)} of people; ${pct(p.precision)} of its alerts are real people`}</title>
      {/* A bigger, invisible hit area than the mark. */}
      <circle cx={cx} cy={cy} r={12} fill="transparent" />
      {p.shape === "dot" && <circle cx={cx} cy={cy} r={p.accent ? 6 : 5} className={`${fill} ${ring}`} strokeWidth={2} />}
      {p.shape === "diamond" && (
        <rect x={cx - 5} y={cy - 5} width={10} height={10} transform={`rotate(45 ${cx} ${cy})`} className={`${fill} ${ring}`} strokeWidth={2} />
      )}
      {p.shape === "square" && <rect x={cx - 5} y={cy - 5} width={10} height={10} rx={2} className={`${fill} ${ring}`} strokeWidth={2} />}
      {leader && p.label && <line x1={cx - 2} y1={cy + 7} x2={cx - 4} y2={cy + 28} className="stroke-text-3" strokeWidth={1} />}
      {p.label && (
        <text x={lx} y={ly} textAnchor={p.labelAt === "right" ? "start" : "end"} className={p.accent ? "fill-text" : "fill-text-2"} style={{ ...SVG_TEXT, fontWeight: p.accent ? 600 : 400 }}>
          {p.label}
        </text>
      )}
    </g>
  );
}

// ---------------------------------------------------------------------------------------------
// 3. Search robustness.

function RobustnessChart({ rows, cellM }: { rows: typeof ROBUSTNESS_5M; cellM: number }) {
  const [ref, width] = useWidth();
  const ha = (cells: number) => (cells * cellM * cellM) / 10_000;
  const mean = (xs: readonly number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
  const series = [
    { key: "naive", label: "Naive map (photographed = searched)", end: "Naive map", accent: false, get: (r: (typeof rows)[number]) => r.naive },
    { key: "sightline", label: "Sightline", end: "Sightline", accent: true, get: (r: (typeof rows)[number]) => r.sightline },
  ] as const;
  const atMeasured = rows.find((r) => r.noise === MEASURED_NOISE)!;
  const gains = atMeasured.sightline.map((s, i) => 1 - s / atMeasured.naive[i]!);
  const gainText = `${Math.round(Math.min(...gains) * 100)}–${Math.round(Math.max(...gains) * 100)}%`;

  const h = 260;
  const m = { l: 44, r: 84, t: 16, b: 40 };
  const xMin = rows[0]!.noise;
  const xMax = rows[rows.length - 1]!.noise;
  const yMax = Math.ceil(Math.max(...rows.flatMap((r) => r.naive.map(ha))));
  const x = (v: number) => m.l + ((v - xMin) / (xMax - xMin)) * (width - m.l - m.r);
  const y = (v: number) => h - m.b - (v / yMax) * (h - m.t - m.b);
  const yTicks = Array.from({ length: yMax + 1 }, (_, i) => i);

  return (
    <ChartCard
      title="Does the map still help if our tree-cover estimate is wrong?"
      insight={
        <>
          Yes. Even with our tree-cover estimate as wrong as we measured it to be, a team using Sightline&apos;s map
          searches {gainText} less ground before finding the person, in every simulation run.
        </>
      }
      source={ROBUSTNESS_SOURCE}
      badge={<Badge kind="simulated">Simulated</Badge>}
      footnote="Simulated searches inside the area the drone photographed: typical ground a team covers before reaching the person. The naive map treats every photographed patch as already searched; Sightline's map knows a photo of forest can miss someone under the trees. Lines are the average of 3 simulation runs; the shaded band is their range. Real estimate errors follow patterns (pale and autumn trees), so even this is a little optimistic."
    >
      <ul aria-label="Chart legend" className="flex flex-wrap gap-4 text-label text-text-2">
        {series.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={"h-0.5 w-4 rounded-full " + (s.accent ? "bg-accent" : "bg-text-3")} />
            {s.label}
          </li>
        ))}
      </ul>
      <div ref={ref} className="w-full">
        <svg width={width} height={h} role="img" aria-label="Hectares to search against canopy noise" className="block overflow-visible">
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={x(xMin)} x2={x(xMax)} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth={1} />
              <text x={m.l - 8} y={y(t) + 4} textAnchor="end" className="fill-text-3" style={SVG_TEXT}>
                {t} ha
              </text>
            </g>
          ))}
          {rows.map((r) => (
            <text key={r.noise} x={x(r.noise)} y={h - m.b + 16} textAnchor="middle" className="fill-text-3" style={SVG_TEXT}>
              {r.noise.toFixed(2)}
            </text>
          ))}
          <text x={(x(xMin) + x(xMax)) / 2} y={h - 4} textAnchor="middle" className="fill-text-2" style={SVG_TEXT}>
            How wrong the tree-cover estimate is →
          </text>
          {/* Where our own canopy classifier's measured error sits. */}
          <line x1={x(MEASURED_NOISE)} x2={x(MEASURED_NOISE)} y1={y(0)} y2={y(yMax)} className="stroke-text-3" strokeWidth={1} />
          <text x={x(MEASURED_NOISE) - 4} y={y(0) - 6} textAnchor="end" className="fill-text-2" style={SVG_TEXT}>
            our measured error
          </text>
          {series.map((s) => {
            const pts = rows.map((r) => ({ noise: r.noise, vals: s.get(r).map(ha) }));
            const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.noise)},${y(mean(p.vals))}`).join(" ");
            const band =
              pts.map((p, i) => `${i ? "L" : "M"}${x(p.noise)},${y(Math.max(...p.vals))}`).join(" ") +
              " " +
              [...pts].reverse().map((p) => `L${x(p.noise)},${y(Math.min(...p.vals))}`).join(" ") +
              " Z";
            const last = pts[pts.length - 1]!;
            const fill = s.accent ? "fill-accent" : "fill-text-3";
            const stroke = s.accent ? "stroke-accent" : "stroke-text-3";
            return (
              <g key={s.key} data-series={s.key}>
                <path d={band} className={fill} fillOpacity={0.12} />
                <path d={line} fill="none" className={stroke} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {pts.map((p) => {
                  const avg = mean(p.vals);
                  const tip = `Estimate error ${p.noise.toFixed(2)}, ${s.label}: ${avg.toFixed(1)} ha on average (runs: ${p.vals.map((v) => v.toFixed(1)).join(" / ")} ha)`;
                  return (
                    <g key={p.noise} data-point tabIndex={0} aria-label={tip} className="focus:outline-none focus-visible:[&>circle:last-of-type]:stroke-text">
                      <title>{tip}</title>
                      <circle cx={x(p.noise)} cy={y(avg)} r={12} fill="transparent" />
                      <circle cx={x(p.noise)} cy={y(avg)} r={4} className={`${fill} stroke-bg`} strokeWidth={2} />
                    </g>
                  );
                })}
                <text x={x(last.noise) + 10} y={y(mean(last.vals)) + 4} className={s.accent ? "fill-text" : "fill-text-2"} style={SVG_TEXT}>
                  {s.end}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <table className="sr-only">
        <caption>Typical hectares to search, average of 3 simulation runs (simulated)</caption>
        <thead>
          <tr>
            <th scope="col">Tree-cover estimate error</th>
            <th scope="col">Naive map</th>
            <th scope="col">Sightline</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.noise}>
              <th scope="row">{r.noise.toFixed(2)}</th>
              <td>{mean(r.naive.map(ha)).toFixed(1)} ha</td>
              <td>{mean(r.sightline.map(ha)).toFixed(1)} ha</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ChartCard>
  );
}

// ---------------------------------------------------------------------------------------------
// 4. Where it misses.

function MissesChart({ overall }: { overall: number }) {
  const sites = MISSES_BY_SITE.map((s) => ({ ...s, recall: 1 - s.missed / s.people })).sort((a, b) => a.recall - b.recall);
  const missed = MISSES_BY_SITE.reduce((s, r) => s + r.missed, 0);
  const worstTwo = sites.slice(0, 2);
  const inWorstTwo = worstTwo.reduce((s, r) => s + r.missed, 0);
  return (
    <ChartCard
      title="Where the detector misses people"
      insight={
        <>
          It depends on the place more than the person: two sites account for {inWorstTwo} of the {missed} people it
          missed, while how big a person looks in the photo changes little.
        </>
      }
      source="docs/DETECTOR_LIMITS.md §2: final model on the corrected test labels, 337 people, threshold 0.29"
      footnote={`Share of people found at each place and size, strict scoring, on the 101 test photos. The vertical line is the overall ${pct(overall)}. ${worstTwo.map((s) => s.label).join(" and ")} are HERIDAL test sites in Croatia: groups of people on dark broken rock, and white or grey clothing on pale limestone.`}
    >
      <div className="flex flex-col gap-5">
        <RecallList
          name="People found, by test site"
          overall={overall}
          rows={sites.map((s) => ({ label: s.label, recall: s.recall, people: s.people, title: s.sites }))}
        />
        <RecallList name="People found, by how big the person looks" overall={overall} rows={MISSES_BY_SIZE} />
      </div>
    </ChartCard>
  );
}

function RecallList({
  name,
  overall,
  rows,
}: {
  name: string;
  overall: number;
  rows: readonly { label: string; recall: number; people: number; title?: string }[];
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="text-label text-text-3">{name}</span>
      <ul aria-label={name} className="flex flex-col gap-2">
        {rows.map((r) => (
          <li
            key={r.label}
            data-label={r.label}
            title={r.title}
            className="grid grid-cols-[7.5rem_minmax(0,1fr)_2.5rem] items-center gap-2 text-small"
          >
            <span className="truncate text-text-2">{r.label}</span>
            <span className="relative h-2.5 rounded-full bg-surface-strong">
              <span className="block h-full rounded-r-[4px] rounded-l-full bg-text-3/60" style={{ width: `${r.recall * 100}%` }} />
              {/* The overall recall, as a reference line across every row. */}
              <span aria-hidden="true" className="absolute -inset-y-1 w-px bg-text-2" style={{ left: `${overall * 100}%` }} />
            </span>
            <span className="text-right font-mono text-text">{pct(r.recall)}</span>
            <span className="col-start-2 -mt-1 text-label text-text-3">{r.people} people</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
