// In-browser copy of the Python detector's tiled inference (sightline/ml/detect.py, detect_tiled):
// SAHI slices of 1024 px with 0.2 overlap, each slice letterboxed to the model's 1024 px input,
// raw YOLO output decoded and NMS'd per slice (Ultralytics' defaults), then all slices' boxes merged
// with NMS at IoU 0.5, exactly as `postprocess_type="NMS", postprocess_match_threshold=0.5`.
// Pure: numbers in, boxes out. The ONNX session and pixels live in runDetector.ts.

/** Slice size and overlap of detect_tiled (sightline/ml/detect.py). */
export const SLICE_PX = 1024;
export const OVERLAP = 0.2;
/** The model's square input (detectorSpec.imgsz). */
export const INPUT_PX = 1024;
/** The model's largest stride: a variable-size input must be a multiple of it. */
export const STRIDE = 32;
/** detect_tiled's default `conf`: boxes below this are dropped before merging. */
export const MIN_CONF = 0.05;
/** Ultralytics' default NMS IoU inside one slice (SAHI calls predict with it). */
export const SLICE_NMS_IOU = 0.7;
/** SAHI's merge across slices: NMS at IoU 0.5. */
export const MERGE_NMS_IOU = 0.5;
/** Ultralytics' default max detections per image. */
export const MAX_DET = 300;

/** [x1, y1, x2, y2] in pixels. */
export type Xyxy = [number, number, number, number];

export interface Detection {
  box: Xyxy;
  conf: number;
}

/**
 * The slice windows SAHI's get_slice_bboxes makes (same loop, same integer overlap): left to right,
 * top to bottom, and a window that would run past the edge is pulled back to end on it.
 */
export function sliceBoxes(width: number, height: number, slice = SLICE_PX, overlap = OVERLAP): Xyxy[] {
  const out: Xyxy[] = [];
  const yOverlap = Math.trunc(overlap * slice);
  const xOverlap = Math.trunc(overlap * slice);
  let yMin = 0;
  let yMax = 0;
  while (yMax < height) {
    let xMin = 0;
    let xMax = 0;
    yMax = yMin + slice;
    while (xMax < width) {
      xMax = xMin + slice;
      if (yMax > height || xMax > width) {
        const x2 = Math.min(width, xMax);
        const y2 = Math.min(height, yMax);
        out.push([Math.max(0, x2 - slice), Math.max(0, y2 - slice), x2, y2]);
      } else {
        out.push([xMin, yMin, xMax, yMax]);
      }
      xMin = xMax - xOverlap;
    }
    yMin = yMax - yOverlap;
  }
  return out;
}

export interface Letterbox {
  /** Scale from slice pixels to model input pixels. */
  scale: number;
  /** Padding added on the left and top, in input pixels. */
  padX: number;
  padY: number;
  /** The slice's size after scaling, in input pixels. */
  width: number;
  height: number;
  /** The model input's size: the full square, or with `stride` only the padding up to a multiple of it. */
  canvasW: number;
  canvasH: number;
}

/**
 * Ultralytics' LetterBox, centred: fit inside `input` keeping the aspect ratio, pad the rest. Without
 * `stride` it pads to the full square (auto=False, what a fixed-size ONNX needs); with `stride` (32) only
 * up to a multiple of it (auto=True, what YOLO.predict does), so a 1000×750 frame becomes 1024×768.
 * Same as sightline/ml/detect_cv.py `letterbox`.
 */
export function letterbox(width: number, height: number, input = INPUT_PX, stride?: number): Letterbox {
  const scale = Math.min(input / width, input / height);
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  let dw = (input - w) / 2;
  let dh = (input - h) / 2;
  if (stride !== undefined) {
    dw = ((input - w) % stride) / 2;
    dh = ((input - h) % stride) / 2;
  }
  // Ultralytics splits the padding in half and rounds each side (round(dw - 0.1), round(dw + 0.1)).
  const padX = Math.max(0, Math.round(dw - 0.1));
  const padY = Math.max(0, Math.round(dh - 0.1));
  const canvasW = w + padX + Math.max(0, Math.round(dw + 0.1));
  const canvasH = h + padY + Math.max(0, Math.round(dh + 0.1));
  return { scale, padX, padY, width: w, height: h, canvasW, canvasH };
}

export function iou(a: Xyxy, b: Xyxy): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Greedy NMS, highest confidence first; ties keep the earlier box. Ultralytics (torchvision)
 * suppresses a box whose IoU is above the threshold; SAHI's merge suppresses at or above it
 * (`inclusive`).
 */
export function nms(dets: readonly Detection[], iouThreshold: number, maxDet = Infinity, inclusive = false): Detection[] {
  const sorted = [...dets].sort((a, b) => b.conf - a.conf);
  const kept: Detection[] = [];
  const overlaps = (v: number) => (inclusive ? v >= iouThreshold : v > iouThreshold);
  for (const d of sorted) {
    if (kept.length >= maxDet) break;
    if (!kept.some((k) => overlaps(iou(k.box, d.box)))) kept.push(d);
  }
  return kept;
}

/**
 * Decode one slice's raw output, shape [1, 4 + nc, anchors] (cx, cy, w, h, then class scores, in
 * input pixels), keep scores >= minConf, NMS inside the slice, and map back to slice pixels.
 */
export function decodeSlice(
  output: ArrayLike<number>,
  anchors: number,
  lb: Letterbox,
  sliceW: number,
  sliceH: number,
  minConf = MIN_CONF,
): Detection[] {
  const nc = output.length / anchors - 4;
  const raw: Detection[] = [];
  for (let i = 0; i < anchors; i++) {
    let conf = 0;
    for (let c = 0; c < nc; c++) conf = Math.max(conf, output[(4 + c) * anchors + i]!);
    if (conf < minConf) continue;
    const cx = output[i]!;
    const cy = output[anchors + i]!;
    const w = output[2 * anchors + i]!;
    const h = output[3 * anchors + i]!;
    const clampX = (v: number) => Math.min(sliceW, Math.max(0, v));
    const clampY = (v: number) => Math.min(sliceH, Math.max(0, v));
    raw.push({
      box: [
        clampX((cx - w / 2 - lb.padX) / lb.scale),
        clampY((cy - h / 2 - lb.padY) / lb.scale),
        clampX((cx + w / 2 - lb.padX) / lb.scale),
        clampY((cy + h / 2 - lb.padY) / lb.scale),
      ],
      conf,
    });
  }
  return nms(raw, SLICE_NMS_IOU, MAX_DET);
}

/** Shift a slice's boxes into photo pixels. */
export function offset(dets: readonly Detection[], slice: Xyxy): Detection[] {
  return dets.map((d) => ({
    conf: d.conf,
    box: [d.box[0] + slice[0], d.box[1] + slice[1], d.box[2] + slice[0], d.box[3] + slice[1]],
  }));
}

/** Merge every slice's boxes with SAHI's NMS (IoU 0.5) and round like detect.py's _int_box. */
export function mergeSlices(perSlice: readonly Detection[][], width: number, height: number): Detection[] {
  const merged = nms(perSlice.flat(), MERGE_NMS_IOU, Infinity, true);
  const out: Detection[] = [];
  for (const d of merged) {
    const x1 = Math.max(0, Math.round(d.box[0]));
    const y1 = Math.max(0, Math.round(d.box[1]));
    const x2 = Math.min(width, Math.round(d.box[2]));
    const y2 = Math.min(height, Math.round(d.box[3]));
    if (x2 > x1 && y2 > y1) out.push({ box: [x1, y1, x2, y2], conf: d.conf });
  }
  return out.sort((a, b) => b.conf - a.conf);
}
