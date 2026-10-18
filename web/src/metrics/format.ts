// Pure formatting helpers for the metrics screen. Numbers in, strings out; no React.

/** 0.812 → "81%" (or "81.2%" with `decimals = 1`). */
export function pct(value: number, decimals = 0): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

/** Difference in percentage points vs a baseline, signed: 0.80 vs 0.68 → "+12 pts". */
export function deltaPts(value: number, baseline: number): string {
  const pts = Math.round((value - baseline) * 100);
  const sign = pts > 0 ? "+" : pts < 0 ? "−" : "±";
  return `${sign}${Math.abs(pts)} pts`;
}

/** Seconds, sensible precision: 0.9 → "0.9 s", 33 → "33 s", 0.043 → "0.04 s". */
export function seconds(value: number): string {
  if (value >= 10) return `${Math.round(value)} s`;
  if (value >= 1) return `${value.toFixed(1)} s`;
  return `${value.toFixed(2)} s`;
}

/** How many times faster `ours` is than `baseline`: 0.9 vs 33 → "37× faster". */
export function speedup(ours: number, baseline: number): string {
  if (ours <= 0) return "—";
  const factor = baseline / ours;
  if (factor >= 1.05)
    return `${factor >= 10 ? Math.round(factor) : factor.toFixed(1)}× faster`;
  if (factor <= 0.95) return `${(1 / factor).toFixed(1)}× slower`;
  return "about the same";
}

/** Whole frames or cells: 71.6 → "72", 7 → "7". */
export function count(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** Minutes with one decimal unless whole: 2.75 → "2.8 min". */
export function minutes(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)} min`;
}

/** Index of the ablation row with the highest AP50 (first wins ties); -1 if empty. */
export function bestByAp50(rows: readonly { voc: { ap50: number } }[]): number {
  let best = -1;
  let bestAp = -Infinity;
  rows.forEach((row, i) => {
    if (row.voc.ap50 > bestAp) {
      bestAp = row.voc.ap50;
      best = i;
    }
  });
  return best;
}

/** Rows that score a whole photo shrunk to the model input, per LANE_A_ML.md §5. */
export function isResizedRow(name: string): boolean {
  return /no tiling/i.test(name);
}

/** The four ablation rows, in order (LANE_A_ML.md §6.3, contract §9). */
export const ABLATION_NAMES = [
  "Stock model, no tiling",
  "Fine-tuned, no tiling",
  "Fine-tuned + tiling",
  "+ hard negatives",
] as const;

type Voc = { precision: number; recall: number; ap50: number };

/** All three scores exactly zero: a stand-in, never a measurement. */
export function isPlaceholderVoc(voc: Voc): boolean {
  return voc.precision === 0 && voc.recall === 0 && voc.ap50 === 0;
}

export type AblationDisplayRow =
  | { name: string; measured: true; voc: Voc }
  | { name: string; measured: false };

/**
 * Rows to show: every canonical name in order, then any extra rows. A name missing from
 * metrics.json, or present with all-zero scores (e.g. a pipeline placeholder), is "not measured".
 */
export function ablationDisplayRows(
  rows: readonly { name: string; voc: Voc }[],
): AblationDisplayRow[] {
  const byName = new Map(rows.map((r) => [r.name, r]));
  const names = [
    ...ABLATION_NAMES,
    ...rows
      .map((r) => r.name)
      .filter((n) => !(ABLATION_NAMES as readonly string[]).includes(n)),
  ];
  return names.map((name) => {
    const row = byName.get(name);
    return row && !isPlaceholderVoc(row.voc)
      ? { name, measured: true, voc: row.voc }
      : { name, measured: false };
  });
}
