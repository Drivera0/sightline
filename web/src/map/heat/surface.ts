// The heat surface on a MapLibre map: per-class GeoJSON fills and the 50 % / 90 % contour lines at
// rest, and the canvas raster (raster.ts) while the heat animates (the Search next build-up, a review
// answer's tween, the flight replay, a live update). Both draw the same cell kinds (classes.ts) in the
// same colours and opacities, and the hand-over crossfades (setSurfaceMode with a fade: the contours
// fade out as a tween starts and the new fills and contours fade in as it ends). The raster is
// one texture upload per frame, which keeps the tweens smooth; the fills give crisp class edges at any
// zoom, per-class opacity by zoom and room for the contours. Kept free of React so tests can use a
// mocked map.
import type { GeoJSONSource, Map } from "maplibre-gl";
import type { MapFile } from "../../contract";
import { CELL, FILL_KINDS, type SurfaceData } from "./classes";
import { type HeatPalette, kindFill, zoomOpacity } from "./palette";
import { gridCorners } from "./raster";

type Grid = MapFile["grid"];
type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];
type PaintName = Parameters<Map["setPaintProperty"]>[1];

export interface SurfaceIds {
  /** The canvas source and its raster layer (same id). */
  raster: string;
  fillSource: string;
  contourSource: string;
  /** One fill layer per cell kind, keyed by kind. */
  fills: Record<number, string>;
  casing90: string;
  line90: string;
  casing50: string;
  line50: string;
}

/** Layer and source ids under one prefix; `raster` is the canvas layer's id. */
export function surfaceIds(prefix: string, raster: string): SurfaceIds {
  return {
    raster,
    fillSource: `${prefix}classes`,
    contourSource: `${prefix}contours`,
    fills: {
      [CELL.veil]: `${prefix}veil`,
      [CELL.held]: `${prefix}held`,
      [CELL.searched]: `${prefix}searched`,
      [CELL.low]: `${prefix}class-90`,
      [CELL.mid]: `${prefix}class-80`,
      [CELL.top]: `${prefix}class-50`,
    },
    casing90: `${prefix}contour-90-casing`,
    line90: `${prefix}contour-90`,
    casing50: `${prefix}contour-50-casing`,
    line50: `${prefix}contour-50`,
  };
}

/** Every layer of the surface, bottom to top. */
export function surfaceLayerIds(ids: SurfaceIds): string[] {
  return [ids.raster, ...FILL_KINDS.map((k) => ids.fills[k] as string), ids.casing90, ids.line90, ids.casing50, ids.line50];
}

/** The theme colours of the two non-class fills: the veil (app background) and the held tone (text). */
export interface SurfaceTheme {
  veil: string;
  held: string;
}

const EMPTY: GeoJsonData = { type: "FeatureCollection", features: [] };

export type SurfaceMode = "raster" | "vector";

/**
 * Add the surface's sources and layers if they are missing (first render, or after a style reload
 * dropped them), each before `before`. Returns true when the canvas source was (re)added. `opacity` is
 * the layer multiplier (the variant's, times the breath); `mode` says which half shows.
 */
export function ensureSurfaceLayers(
  map: Map,
  ids: SurfaceIds,
  canvas: HTMLCanvasElement,
  grid: Grid,
  palette: HeatPalette,
  theme: SurfaceTheme,
  opacity: number,
  mode: SurfaceMode,
  before?: string,
): boolean {
  let added = false;
  if (!map.getSource(ids.raster)) {
    map.addSource(ids.raster, { type: "canvas", canvas, coordinates: gridCorners(grid), animate: false });
    added = true;
  }
  for (const id of [ids.fillSource, ids.contourSource]) {
    if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: EMPTY });
  }
  const shown = (m: SurfaceMode) => (mode === m ? "visible" : "none");
  if (!map.getLayer(ids.raster)) {
    map.addLayer(
      {
        id: ids.raster,
        type: "raster",
        source: ids.raster,
        layout: { visibility: shown("raster") },
        paint: {
          "raster-opacity": zoomOpacity(opacity) as never,
          // Every cell a crisp square: no smoothing between cells, no invented detail.
          "raster-resampling": "nearest",
          "raster-fade-duration": 0,
        },
      },
      before,
    );
  }
  for (const kind of FILL_KINDS) {
    const id = ids.fills[kind] as string;
    if (map.getLayer(id)) continue;
    const fill = kindFill(palette, kind, theme);
    map.addLayer(
      {
        id,
        type: "fill",
        source: ids.fillSource,
        filter: ["==", ["get", "kind"], kind],
        layout: { visibility: shown("vector") },
        paint: {
          "fill-color": fill?.color ?? theme.veil,
          "fill-opacity": zoomOpacity((fill?.alpha ?? 0) * opacity) as never,
          // Neighbouring rectangles share edges: antialiasing would draw a faint seam between them.
          "fill-antialias": false,
        },
      },
      before,
    );
  }
  const line = (id: string, level: 50 | 90, casing: boolean) => {
    if (map.getLayer(id)) return;
    const style = level === 50 ? palette.contour50 : palette.contour90;
    map.addLayer(
      {
        id,
        type: "line",
        source: ids.contourSource,
        filter: ["==", ["get", "level"], level],
        layout: { visibility: shown("vector"), "line-join": "miter", "line-cap": "butt" },
        paint: casing
          ? { "line-color": palette.casing.color, "line-opacity": palette.casing.opacity, "line-width": style.width + 2 * palette.casing.width }
          : { "line-color": style.color, "line-opacity": style.opacity ?? 1, "line-width": style.width, ...(style.dash ? { "line-dasharray": style.dash } : {}) },
      },
      before,
    );
  };
  line(ids.casing90, 90, true);
  line(ids.line90, 90, false);
  line(ids.casing50, 50, true);
  line(ids.line50, 50, false);
  return added;
}

/** Recolour the surface for another palette (a basemap switch) and set its opacity. Safe before it exists. */
export function setSurfacePalette(map: Map, ids: SurfaceIds, palette: HeatPalette, theme: SurfaceTheme, opacity: number): void {
  const set = (id: string, prop: string, value: unknown) => {
    if (map.getLayer(id)) map.setPaintProperty(id, prop as PaintName, value as never);
  };
  for (const kind of FILL_KINDS) {
    const fill = kindFill(palette, kind, theme);
    if (fill) set(ids.fills[kind] as string, "fill-color", fill.color);
  }
  set(ids.casing90, "line-color", palette.casing.color);
  set(ids.casing50, "line-color", palette.casing.color);
  set(ids.line90, "line-color", palette.contour90.color);
  set(ids.line50, "line-color", palette.contour50.color);
  setSurfaceOpacity(map, ids, palette, theme, opacity);
}

/**
 * The surface's opacity multiplier (the variant's base times the breath): the raster's opacity and
 * each fill's class alpha times it, both faded by zoom. The contours keep full strength.
 */
export function setSurfaceOpacity(map: Map, ids: SurfaceIds, palette: HeatPalette, theme: SurfaceTheme, opacity: number): void {
  if (map.getLayer(ids.raster)) map.setPaintProperty(ids.raster, "raster-opacity", zoomOpacity(opacity) as never);
  for (const kind of FILL_KINDS) {
    const id = ids.fills[kind] as string;
    const fill = kindFill(palette, kind, theme);
    if (fill && map.getLayer(id)) map.setPaintProperty(id, "fill-opacity", zoomOpacity(fill.alpha * opacity) as never);
  }
}

/**
 * The longest the raster waits for new fills to be drawn before it hands over anyway (a lost event,
 * a test double). A 5 m grid's fills take a few tens of milliseconds in MapLibre's worker.
 */
export const SURFACE_LOAD_TIMEOUT_MS = 400;

interface SwapState {
  /** New fills were pushed and are not drawn yet: the raster stays until they are. */
  pending: boolean;
  /** The mode last asked for. */
  want: SurfaceMode;
  /** Stops waiting for the pending push (a newer push replaces it). */
  cancel?: () => void;
  /** How the hand-over to `want` should go (a crossfade), when asked for one. */
  fade?: SurfaceFade;
  /** Stops a crossfade in progress. */
  stopFade?: () => void;
}

/**
 * A crossfade between the raster and the fills (V3 §2: the heat evolves, it never swaps): over `ms` the
 * half going away fades out while the other fades in, contours with the fills. Needs the palette, theme
 * and opacity multiplier the layers were drawn with, to put them back exactly at the end.
 */
export interface SurfaceFade {
  ms: number;
  palette: HeatPalette;
  theme: SurfaceTheme;
  opacity: number;
  /** Test seams. */
  raf?: (fn: (t: number) => void) => number;
  caf?: (id: number) => void;
  now?: () => number;
}

/** The fills', the raster's and the contours' strengths for a crossfade at `e` (0..1, eased) towards `mode`. */
export function fadeMix(mode: SurfaceMode, e: number): { raster: number; vector: number } {
  const k = Math.min(1, Math.max(0, e));
  return mode === "raster" ? { raster: k, vector: 1 - k } : { raster: 1 - k, vector: k };
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

function setMix(map: Map, ids: SurfaceIds, fade: SurfaceFade, mix: { raster: number; vector: number }): void {
  const set = (id: string, prop: string, value: unknown) => {
    if (map.getLayer(id)) map.setPaintProperty(id, prop as PaintName, value as never);
  };
  set(ids.raster, "raster-opacity", zoomOpacity(fade.opacity * mix.raster));
  for (const kind of FILL_KINDS) {
    const fill = kindFill(fade.palette, kind, fade.theme);
    if (fill) set(ids.fills[kind] as string, "fill-opacity", zoomOpacity(fill.alpha * fade.opacity * mix.vector));
  }
  set(ids.casing90, "line-opacity", fade.palette.casing.opacity * mix.vector);
  set(ids.casing50, "line-opacity", fade.palette.casing.opacity * mix.vector);
  set(ids.line90, "line-opacity", (fade.palette.contour90.opacity ?? 1) * mix.vector);
  set(ids.line50, "line-opacity", (fade.palette.contour50.opacity ?? 1) * mix.vector);
}

/** Crossfade to `mode`: both halves shown while it runs, then only `mode`'s, at full strength. */
function fadeTo(map: Map, ids: SurfaceIds, mode: SurfaceMode, fade: SurfaceFade, state: SwapState): void {
  state.stopFade?.();
  const raf = fade.raf ?? ((fn: (t: number) => void) => requestAnimationFrame(fn));
  const caf = fade.caf ?? ((id: number) => cancelAnimationFrame(id));
  const now = fade.now ?? (() => performance.now());
  for (const id of surfaceLayerIds(ids)) if (map.getLayer(id) && map.getLayoutProperty?.(id, "visibility") !== "visible") map.setLayoutProperty?.(id, "visibility", "visible");
  const start = now();
  let frame = 0;
  const end = () => {
    state.stopFade = undefined;
    setMix(map, ids, fade, { raster: 1, vector: 1 });
    applyMode(map, ids, mode);
  };
  const tick = () => {
    const t = Math.min(1, (now() - start) / Math.max(1, fade.ms));
    try {
      if (t >= 1) return end();
      setMix(map, ids, fade, fadeMix(mode, easeInOut(t)));
    } catch {
      return; /* the map is going away */
    }
    frame = raf(tick);
  };
  state.stopFade = () => {
    caf(frame);
    state.stopFade = undefined;
    try {
      setMix(map, ids, fade, { raster: 1, vector: 1 });
    } catch {
      /* the map is going away */
    }
  };
  setMix(map, ids, fade, fadeMix(mode, 0));
  frame = raf(tick);
}
const swaps = new WeakMap<Map, globalThis.Map<string, SwapState>>();

function swapState(map: Map, ids: SurfaceIds): SwapState {
  let byIds = swaps.get(map);
  if (!byIds) {
    byIds = new globalThis.Map();
    swaps.set(map, byIds);
  }
  let state = byIds.get(ids.fillSource);
  if (!state) {
    state = { pending: false, want: "vector" };
    byIds.set(ids.fillSource, state);
  }
  return state;
}

function applyMode(map: Map, ids: SurfaceIds, mode: SurfaceMode): void {
  for (const id of surfaceLayerIds(ids)) {
    if (!map.getLayer(id)) continue;
    const want = (id === ids.raster) === (mode === "raster") ? "visible" : "none";
    if (map.getLayoutProperty?.(id, "visibility") !== want) map.setLayoutProperty?.(id, "visibility", want);
  }
}

/**
 * Put the fills and contours of a new picture on the map (shown at rest). MapLibre tiles GeoJSON in a
 * worker, so until the new fills are drawn a hand-over to them would show the old picture for a frame
 * or two: the raster keeps the map until the fill source has loaded its new data (or the timeout).
 * Safe before the sources exist.
 */
export function pushSurface(map: Map, ids: SurfaceIds, data: SurfaceData): void {
  const fills = map.getSource(ids.fillSource) as GeoJSONSource | undefined;
  fills?.setData?.(data.fills as GeoJsonData);
  (map.getSource(ids.contourSource) as GeoJSONSource | undefined)?.setData?.(data.contours as GeoJsonData);
  if (!fills || typeof map.on !== "function" || typeof map.off !== "function") return;
  const state = swapState(map, ids);
  state.cancel?.(); // an earlier push still loading: this one replaces it
  state.pending = true;
  let contentSeen = false;
  const onData = (e: { sourceId?: string; sourceDataType?: string }) => {
    if (e.sourceId !== ids.fillSource) return;
    if (e.sourceDataType === "content") contentSeen = true;
    else if (contentSeen && map.isSourceLoaded?.(ids.fillSource)) finish();
  };
  const timer = setTimeout(() => finish(), SURFACE_LOAD_TIMEOUT_MS);
  const cancel = () => {
    clearTimeout(timer);
    map.off("sourcedata", onData as never);
    if (state.cancel === cancel) state.cancel = undefined;
  };
  const finish = () => {
    cancel();
    state.pending = false;
    try {
      if (state.want === "vector") {
        if (state.fade) fadeTo(map, ids, "vector", state.fade, state);
        else applyMode(map, ids, "vector");
      }
    } catch {
      /* style reloading */
    }
  };
  state.cancel = cancel;
  map.on("sourcedata", onData as never);
}

/**
 * Show the raster (while animating) or the fills and contours (at rest). Only touches what changes; a
 * hand-over to fills that are still loading waits for them (pushSurface).
 */
export function setSurfaceMode(map: Map, ids: SurfaceIds, mode: SurfaceMode, fade?: SurfaceFade): void {
  const state = swapState(map, ids);
  const was = state.want;
  state.want = mode;
  state.fade = fade;
  if (mode === "vector" && state.pending) {
    // the raster keeps the map until the new fills are drawn (then the crossfade, pushSurface)
    if (state.stopFade) {
      state.stopFade();
      applyMode(map, ids, "raster");
    }
    return;
  }
  if (fade && was !== mode) return fadeTo(map, ids, mode, fade, state);
  if (was !== mode) state.stopFade?.();
  if (!state.stopFade) applyMode(map, ids, mode);
}
