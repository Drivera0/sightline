// Runs Sightline's detector in the visitor's browser: the ONNX export of the same weights the
// pipeline uses, through onnxruntime-web (WebGPU when the browser has it, otherwise WebAssembly).
// The model is served by this site (/models/, fetched at build time by scripts/fetch-model.sh), so
// nothing leaves the device and nothing is fetched from another origin.

import type * as Ort from "onnxruntime-web";
import { STRIDE, decodeSlice, letterbox, mergeSlices, offset, sliceBoxes, type Detection } from "./tiling";

export const MODEL_FILE = "sightline-detector-v2.onnx";
export const MODEL_URL = `${import.meta.env.BASE_URL}models/${MODEL_FILE}`;

export type Backend = "webgpu" | "wasm";

export interface LoadedDetector {
  ort: typeof Ort;
  session: Ort.InferenceSession;
  backend: Backend;
  /**
   * Whether the model takes a non-square input, so slices are padded like YOLO.predict (only to a
   * multiple of 32). Unknown (null) until the first slice that isn't square: a variable-size export
   * (sightline-detector-v2-dynamic.onnx) accepts it; the fixed-size one fails and we pad to the square.
   */
  rect: boolean | null;
}

/** True when this deployment ships the model file. */
export async function modelAvailable(): Promise<boolean> {
  try {
    const res = await fetch(MODEL_URL, { method: "HEAD" });
    const type = res.headers.get("content-type") ?? "";
    // A single-page host may answer a missing file with index.html.
    return res.ok && !type.includes("text/html");
  } catch {
    return false;
  }
}

/** Download the model from this site, reporting bytes as they arrive. */
async function fetchModel(onProgress: (loaded: number, total: number | null) => void): Promise<Uint8Array> {
  const res = await fetch(MODEL_URL);
  if (!res.ok || (res.headers.get("content-type") ?? "").includes("text/html")) {
    throw new Error("The detector model is not included in this build of the site.");
  }
  const total = Number(res.headers.get("content-length")) || null;
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress(buf.byteLength, buf.byteLength);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

let loading: Promise<LoadedDetector> | null = null;

/** Load once per page: the runtime (lazily, so the rest of the site never pays for it) and the model. */
export function loadDetector(onProgress: (loaded: number, total: number | null) => void): Promise<LoadedDetector> {
  loading ??= (async () => {
    const [ort, model] = await Promise.all([import("onnxruntime-web/webgpu"), fetchModel(onProgress)]);
    // Threads need cross-origin isolation, which a static host doesn't give; one thread works anywhere.
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    const hasGpu = typeof navigator !== "undefined" && "gpu" in navigator;
    if (hasGpu) {
      try {
        const session = await ort.InferenceSession.create(model, { executionProviders: ["webgpu"] });
        return { ort, session, backend: "webgpu" as const, rect: null };
      } catch {
        /* no usable adapter: fall back to WebAssembly */
      }
    }
    const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"] });
    return { ort, session, backend: "wasm" as const, rect: null };
  })();
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/** Pixels of one letterboxed slice as the model's [1, 3, h, w] float input (RGB, 0..1). */
function toInput(rgba: Uint8ClampedArray, w: number, h: number): Float32Array {
  const n = w * h;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[i] = rgba[i * 4]! / 255;
    out[n + i] = rgba[i * 4 + 1]! / 255;
    out[2 * n + i] = rgba[i * 4 + 2]! / 255;
  }
  return out;
}

/**
 * Tiled detection on one photo, as detect_tiled does in Python: every slice letterboxed onto a
 * grey (114) canvas (1024 px square, or padded only to a multiple of 32 when the model allows it),
 * run, decoded, then merged. Returns every box >= 0.05; the caller applies the survey's threshold.
 */
export async function detectPhoto(
  detector: LoadedDetector,
  image: ImageBitmap,
  onSlice: (done: number, total: number) => void,
): Promise<Detection[]> {
  const { ort, session } = detector;
  const slices = sliceBoxes(image.width, image.height);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser cannot read image pixels.");
  const perSlice: Detection[][] = [];
  const inputName = session.inputNames[0]!;
  const outputName = session.outputNames[0]!;

  const run = async (s: (typeof slices)[number], rect: boolean) => {
    const sw = s[2] - s[0];
    const sh = s[3] - s[1];
    const lb = letterbox(sw, sh, undefined, rect ? STRIDE : undefined);
    canvas.width = lb.canvasW;
    canvas.height = lb.canvasH;
    ctx.fillStyle = "rgb(114,114,114)";
    ctx.fillRect(0, 0, lb.canvasW, lb.canvasH);
    ctx.drawImage(image, s[0], s[1], sw, sh, lb.padX, lb.padY, lb.width, lb.height);
    const pixels = ctx.getImageData(0, 0, lb.canvasW, lb.canvasH).data;
    const dims = [1, 3, lb.canvasH, lb.canvasW];
    const input = new ort.Tensor("float32", toInput(pixels, lb.canvasW, lb.canvasH), dims);
    try {
      const result = await session.run({ [inputName]: input });
      const out = result[outputName]!;
      const dets = decodeSlice(out.data as Float32Array, out.dims[2]!, lb, sw, sh);
      out.dispose?.();
      return offset(dets, s);
    } finally {
      input.dispose?.();
    }
  };

  onSlice(0, slices.length);
  for (const [i, s] of slices.entries()) {
    const square = s[2] - s[0] === s[3] - s[1];
    if (detector.rect === null && !square) {
      try {
        perSlice.push(await run(s, true));
        detector.rect = true;
      } catch {
        detector.rect = false; // a fixed-size export: pad to the square from now on
        perSlice.push(await run(s, false));
      }
    } else {
      perSlice.push(await run(s, detector.rect === true));
    }
    onSlice(i + 1, slices.length);
    // Let the page paint the progress between slices.
    await new Promise((r) => setTimeout(r, 0));
  }
  return mergeSlices(perSlice, image.width, image.height);
}
