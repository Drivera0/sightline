import type { Detection, Detections } from "../contract";

/** One histogram bin: [lo, hi), split into boxes below and at/above the flag threshold. */
export interface ScoreBin {
  lo: number;
  hi: number;
  below: number;
  above: number;
}

export interface ScoreHistogram {
  lo: number;
  hi: number;
  bins: ScoreBin[];
  total: number;
  /** Largest bin count (at least 1, so it can divide). */
  max: number;
}

/**
 * Histogram of box scores from `lo` (the save threshold, 0.05) to `hi` (1.0) in bins of `width`.
 * Each bin counts its boxes below and at/above `threshold` separately, so a bin the threshold cuts
 * through is coloured box by box, never by its left edge. A score of exactly `hi` goes in the
 * last bin; scores outside [lo, hi] are clamped into the end bins.
 */
export function scoreHistogram(confs: readonly number[], threshold: number, lo = 0.05, hi = 1, width = 0.05): ScoreHistogram {
  const n = Math.max(1, Math.round((hi - lo) / width));
  const bins: ScoreBin[] = Array.from({ length: n }, (_, i) => ({
    lo: round(lo + i * width),
    hi: round(i === n - 1 ? hi : lo + (i + 1) * width),
    below: 0,
    above: 0,
  }));
  for (const c of confs) {
    // The epsilon keeps 0.1 (stored as 0.0999…) in the bin that starts at 0.10.
    const i = Math.min(n - 1, Math.max(0, Math.floor((c - lo) / width + 1e-9)));
    const bin = bins[i] as ScoreBin;
    if (c >= threshold) bin.above += 1;
    else bin.below += 1;
  }
  const max = Math.max(1, ...bins.map((b) => b.below + b.above));
  return { lo, hi, bins, total: confs.length, max };
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * How a frame maps onto the model input in one imgsz pass, as Ultralytics' predict letterboxes it:
 * scale the long side to imgsz, then pad each side up to a multiple of the largest stride (32).
 */
export interface InputGeometry {
  /** Input pixels per frame pixel. */
  scale: number;
  inputW: number;
  inputH: number;
  /** Padding before the photo, in input pixels. */
  padLeft: number;
  padTop: number;
}

export function inputGeometry(widthPx: number, heightPx: number, imgsz: number, maxStride = 32): InputGeometry {
  const scale = Math.min(imgsz / widthPx, imgsz / heightPx);
  const unpadW = Math.round(widthPx * scale);
  const unpadH = Math.round(heightPx * scale);
  const padW = (imgsz - unpadW) % maxStride;
  const padH = (imgsz - unpadH) % maxStride;
  return {
    scale,
    inputW: unpadW + padW,
    inputH: unpadH + padH,
    padLeft: Math.max(0, Math.round(padW / 2 - 0.1)),
    padTop: Math.max(0, Math.round(padH / 2 - 0.1)),
  };
}

/** Grid size (cells across and down) of the prediction grid at `stride` for that input. */
export function gridSize(geom: InputGeometry, stride: number): { cols: number; rows: number } {
  return { cols: Math.ceil(geom.inputW / stride), rows: Math.ceil(geom.inputH / stride) };
}

/**
 * The grid cell at `stride` that contains a box's centre (box in frame pixels), or null without a
 * box. This is only where the centre falls: which head and anchor produced the box is not stored.
 */
export function cellOfBoxCentre(
  box: readonly [number, number, number, number] | undefined,
  geom: InputGeometry,
  stride: number,
): { col: number; row: number } | null {
  if (!box) return null;
  const { cols, rows } = gridSize(geom, stride);
  const cx = ((box[0] + box[2]) / 2) * geom.scale + geom.padLeft;
  const cy = ((box[1] + box[3]) / 2) * geom.scale + geom.padTop;
  return {
    col: Math.min(cols - 1, Math.max(0, Math.floor(cx / stride))),
    row: Math.min(rows - 1, Math.max(0, Math.floor(cy / stride))),
  };
}

/** The most confident box, or undefined for none. */
export function topDetection(boxes: readonly Detection[]): Detection | undefined {
  return boxes.reduce<Detection | undefined>((best, d) => (!best || d.conf > best.conf ? d : best), undefined);
}

/** Survey totals: boxes kept, boxes at or above the flag threshold, and photos with at least one. */
export function surveyScores(detections: Pick<Detections, "frames" | "candidate_threshold">): {
  boxes: number;
  above: number;
  photosFlagged: number;
  confs: number[];
} {
  const threshold = detections.candidate_threshold;
  const confs = Object.values(detections.frames).flatMap((ds) => ds.map((d) => d.conf));
  return {
    boxes: confs.length,
    above: confs.filter((c) => c >= threshold).length,
    photosFlagged: Object.values(detections.frames).filter((ds) => ds.some((d) => d.conf >= threshold)).length,
    confs,
  };
}
