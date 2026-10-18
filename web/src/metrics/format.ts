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

/**
 * The ablation rows, in lane A's order (sightline/ml/evaluate.py ABLATION_NAMES, contract §9).
 * The first two shrink the whole photo to 1024 px; the next three keep it whole at full or
 * 1920 px resolution; "Fine-tuned + tiling" is the detector in use.
 */
export const ABLATION_NAMES = [
  "Stock model, no tiling",
  "Fine-tuned on tiles, run on shrunk photos",
  "Stock model, full-resolution photo",
  "Fine-tuned on tiles, full-resolution photo",
  "Trained and run on whole photos",
  "Fine-tuned + tiling",
  "+ hard negatives",
] as const;

/** The row that matches the detector the app runs (tiled inference, docs/LANE_A_ML.md). */
export const IN_USE_ROW = "Fine-tuned + tiling";

/** Old row names in files written before 2026-10-18 (evening): sightline/ml/evaluate.py LEGACY_ABLATION_RENAMES. */
export const LEGACY_ABLATION_RENAMES: Readonly<Record<string, string>> = {
  "Fine-tuned, no tiling": "Fine-tuned on tiles, run on shrunk photos",
};

/** Rows every metrics file has carried since the first release; the other three came later. */
const CORE_ROWS: readonly string[] = [
  "Stock model, no tiling",
  "Fine-tuned on tiles, run on shrunk photos",
  "Fine-tuned + tiling",
  "+ hard negatives",
];

/** A row name under its current name. */
export function canonicalAblationName(name: string): string {
  return LEGACY_ABLATION_RENAMES[name] ?? name;
}

const SHRUNK_ROWS = new Set(["Stock model, no tiling", "Fine-tuned on tiles, run on shrunk photos"]);

/** Rows that score a whole photo shrunk to 1024 px (the model's input), matched by exact name. */
export function isResizedRow(name: string): boolean {
  return SHRUNK_ROWS.has(canonicalAblationName(name));
}

const SUB_LABELS: Readonly<Record<string, string>> = {
  "Stock model, no tiling": "whole photo shrunk to 1024 px",
  "Fine-tuned on tiles, run on shrunk photos": "whole photo shrunk to 1024 px",
  "Stock model, full-resolution photo": "whole photo, 4000 px, one pass",
  "Fine-tuned on tiles, full-resolution photo": "whole photo, 4000 px, one pass",
  "Trained and run on whole photos": "trained and run at 1920 px",
  "Fine-tuned + tiling": "1024 px tiles",
};

/** How a row reads the photo, for a line under its name; undefined when there is nothing to add. */
export function ablationSubLabel(name: string): string | undefined {
  return SUB_LABELS[canonicalAblationName(name)];
}

type Voc = { precision: number; recall: number; ap50: number };

/** All three scores exactly zero: a stand-in, never a measurement. */
export function isPlaceholderVoc(voc: Voc): boolean {
  return voc.precision === 0 && voc.recall === 0 && voc.ap50 === 0;
}

export type AblationDisplayRow =
  | { name: string; measured: true; voc: Voc }
  | { name: string; measured: false };

/**
 * Rows to show: the canonical names in order, then any extra rows. Old names are mapped to
 * their current ones. A row present with all-zero scores (e.g. a pipeline placeholder), or a core
 * row missing from the file, is "not measured". The three newer baselines are expected only in a
 * file that carries at least one of them, so an older four-row file does not list them as gaps.
 */
export function ablationDisplayRows(
  rows: readonly { name: string; voc: Voc }[],
): AblationDisplayRow[] {
  const renamed = rows.map((r) => ({ ...r, name: canonicalAblationName(r.name) }));
  const byName = new Map(renamed.map((r) => [r.name, r]));
  const canonical = ABLATION_NAMES as readonly string[];
  const newer = canonical.filter((n) => !CORE_ROWS.includes(n));
  const hasNewer = newer.some((n) => byName.has(n));
  const expected = canonical.filter((n) => byName.has(n) || CORE_ROWS.includes(n) || hasNewer);
  const names = [...expected, ...renamed.map((r) => r.name).filter((n) => !canonical.includes(n))];
  return names.map((name) => {
    const row = byName.get(name);
    return row && !isPlaceholderVoc(row.voc)
      ? { name, measured: true, voc: row.voc }
      : { name, measured: false };
  });
}

/** Index of the single smallest value; -1 when the smallest is shared (a tie) or the list is empty. */
export function uniqueMinIndex(values: readonly number[]): number {
  if (values.length === 0) return -1;
  const min = Math.min(...values);
  const at = values.flatMap((v, i) => (v === min ? [i] : []));
  return at.length === 1 ? (at[0] ?? -1) : -1;
}

/** "4 min", "3 h 5 min": a span of time a person would spend. */
export function duration(totalSeconds: number): string {
  const mins = Math.round(totalSeconds / 60);
  if (mins < 1) return `${Math.round(totalSeconds)} s`;
  if (mins < 90) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
