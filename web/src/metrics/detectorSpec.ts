import raw from "./detectorSpec.json";

/**
 * The detector's real layer table, exported from the weights by
 * scripts/analysis/export_model_spec.py (one dummy forward pass at imgsz). Nothing here is typed
 * by hand: the rank step's "Inside the detector" panel draws its schematic from this file.
 */
export interface SpecLayer {
  index: number;
  /** Ultralytics module name: Conv, C3k2, SPPF, C2PSA, Upsample, Concat, Detect. */
  type: string;
  /** Input layer(s): -1 is the previous layer, other numbers are layer indices. */
  from: number | number[];
  params: number;
  /** Output shape without the batch dimension: [channels, height, width], or [values, locations] for Detect. */
  out_shape: number[];
}

export interface DetectorSpec {
  source: string;
  weights_file: string;
  weights_sha256: string;
  imgsz: number;
  nc: number;
  /** Class names as stored in the weights (single_cls training stores the one class as "item"). */
  names: string[];
  strides: number[];
  n_layers: number;
  total_params: number;
  detect_from: number[];
  train_epochs: number | null;
  train_imgsz: number | null;
  train_base_model: string | null;
  layers: SpecLayer[];
}

export const detectorSpec: DetectorSpec = raw as DetectorSpec;

export type Stage = "backbone" | "neck" | "head";

/** Indices of the layers a layer reads from, with -1 resolved to the previous layer. */
export function inputsOf(layer: Pick<SpecLayer, "index" | "from">): number[] {
  const from = Array.isArray(layer.from) ? layer.from : [layer.from];
  return from.map((f) => (f < 0 ? layer.index + f : f));
}

/**
 * Backbone: everything before the first Upsample. Head: Detect. Neck: the rest (top-down and
 * bottom-up paths), as in Ultralytics' YOLO11 architecture guide.
 */
export function stageOf(layer: Pick<SpecLayer, "index" | "type">, spec: Pick<DetectorSpec, "layers"> = detectorSpec): Stage {
  if (layer.type === "Detect") return "head";
  const firstUp = spec.layers.find((l) => l.type === "Upsample")?.index ?? Infinity;
  return layer.index < firstUp ? "backbone" : "neck";
}

/** Prediction locations in one square imgsz pass: one per grid cell at every stride. */
export function gridLocations(imgsz: number, strides: readonly number[]): number {
  return strides.reduce((sum, s) => sum + Math.ceil(imgsz / s) ** 2, 0);
}

/** Values the head predicts per location besides the class scores (4 box values for YOLO11). */
export function boxValuesPerLocation(spec: Pick<DetectorSpec, "layers" | "nc"> = detectorSpec): number {
  const detect = spec.layers[spec.layers.length - 1];
  return (detect?.out_shape[0] ?? spec.nc) - spec.nc;
}

/** "256²×128" for a square [128, 256, 256] map, "64×48×256" otherwise. */
export function formatShape(shape: readonly number[]): string {
  const [c, h, w] = shape;
  if (c === undefined || h === undefined || w === undefined) return shape.join("×");
  return h === w ? `${h}²×${c}` : `${h}×${w}×${c}`;
}

/** 9428179 → "9.43 M". */
export function formatMillions(n: number): string {
  return `${(n / 1e6).toFixed(2)} M`;
}

/** The three pyramid levels the head reads (P3, P4, P5), with their stride and feature shape. */
export function pyramidLevels(spec: DetectorSpec = detectorSpec): { name: string; layer: SpecLayer; stride: number }[] {
  return spec.detect_from.flatMap((index, i) => {
    const layer = spec.layers[index];
    const stride = spec.strides[i];
    return layer && stride !== undefined ? [{ name: `P${i + 3}`, layer, stride }] : [];
  });
}

/** "yolo11s.pt" → "YOLO11s". */
export function architectureName(spec: Pick<DetectorSpec, "train_base_model"> = detectorSpec): string {
  const base = (spec.train_base_model ?? "yolo11s").replace(/\.pt$/, "");
  return base.replace(/^yolo/i, "YOLO");
}
