// Colours of the heat classes and contours, chosen by the basemap under them, and what the heat does
// to that basemap (muted satellite imagery, a place below the roads and labels).
//
// Satellite: a ColorBrewer YlOrRd subset (Brewer, colorbrewer2.org; colour-blind safe, no green),
// darker and denser for likelier, over imagery desaturated while the heat is shown (Esri's "Firefly"
// idea: mute the basemap, not the data). Dark vector basemap: lightness inverted, so lighter means
// likelier on a dark ground, from the upper range of matplotlib's magma (van der Walt & Smith 2015);
// low-alpha yellow over dark grey turns olive, magma's purples do not. Fill opacity stays between
// 0.24 and 0.56 (a fifth under the first cut, so the ground reads through) with a line at the class edges, the range over which a transparent overlay
// and the map under it both stay readable (Hombeck et al., IEEE VIS 2020).
import type { Map } from "maplibre-gl";
import { CELL } from "./classes";

type PaintName = Parameters<Map["setPaintProperty"]>[1];

export type BasemapKind = "satellite" | "dark";

export interface FillStyle {
  color: string;
  alpha: number;
}

export interface LineStyle {
  color: string;
  width: number;
  /** Dash pattern in line widths; none for a solid line. */
  dash?: number[];
  /** Line opacity (1 when left out). */
  opacity?: number;
}

export interface HeatPalette {
  kind: BasemapKind;
  /** The three mass classes: likeliest 50 %, 50–80 %, 80–90 %. */
  top: FillStyle;
  mid: FillStyle;
  low: FillStyle;
  /** The edge of the likeliest 50 % (1.5 px) and, faint, of the 90 % region (1 px); both solid. */
  contour50: LineStyle;
  contour90: LineStyle;
  /** A thin dark line under each contour: it reads on pale imagery and on the pale classes. */
  casing: { color: string; width: number; opacity: number };
}

export const HEAT_PALETTES: Record<BasemapKind, HeatPalette> = {
  satellite: {
    kind: "satellite",
    top: { color: "#e31a1c", alpha: 0.48 },
    mid: { color: "#fd8d3c", alpha: 0.36 },
    low: { color: "#fed976", alpha: 0.24 },
    contour50: { color: "#bd0026", width: 1.5 },
    contour90: { color: "#ffffff", width: 1, opacity: 0.45 },
    casing: { color: "#0a0b0d", width: 0, opacity: 0 },
  },
  dark: {
    kind: "dark",
    top: { color: "#fe9f6d", alpha: 0.56 },
    mid: { color: "#de4968", alpha: 0.44 },
    low: { color: "#8c2981", alpha: 0.32 },
    contour50: { color: "#fcfdbf", width: 1.5 },
    contour90: { color: "#ffffff", width: 1, opacity: 0.4 },
    casing: { color: "#0a0b0d", width: 0, opacity: 0 },
  },
};

/** Opacity of the "not yet searched" veil (cells not photographed at this step). */
export const VEIL_ALPHA = 0.45;
/** Fill of a cell awaiting review: a neutral light tone (no update yet), outlined dashed on the map. */
export const HELD_ALPHA = 0.3;

/** The fill colour and alpha of a cell kind; null for no fill. `veil` and `held` are theme colours. */
export function kindFill(palette: HeatPalette, kind: number, theme: { veil: string; held: string }): FillStyle | null {
  switch (kind) {
    case CELL.top:
      return palette.top;
    case CELL.mid:
      return palette.mid;
    case CELL.low:
      return palette.low;
    case CELL.held:
      return { color: theme.held, alpha: HELD_ALPHA };
    case CELL.veil:
      return { color: theme.veil, alpha: VEIL_ALPHA };
    default:
      return null;
  }
}

/**
 * Fill opacity falls as you zoom in, so the ground under the cells takes over when you look closely:
 * the full multiplier at z13 and below, ZOOM_FADE.to at z16 and above. The contours keep full strength.
 */
export const ZOOM_FADE = { fromZoom: 13, toZoom: 16, to: 0.55 } as const;

/** The opacity multiplier at a zoom (the same ramp MapLibre interpolates). */
export function zoomFade(zoom: number): number {
  const t = Math.min(1, Math.max(0, (zoom - ZOOM_FADE.fromZoom) / (ZOOM_FADE.toZoom - ZOOM_FADE.fromZoom)));
  return 1 + (ZOOM_FADE.to - 1) * t;
}

/** A zoom-interpolated opacity: `value` at fromZoom, value × ZOOM_FADE.to at toZoom. */
export function zoomOpacity(value: number): unknown[] {
  const v = Math.min(1, Math.max(0, value));
  return ["interpolate", ["linear"], ["zoom"], ZOOM_FADE.fromZoom, v, ZOOM_FADE.toZoom, v * ZOOM_FADE.to];
}

/** Imagery under the heat: desaturated and a little darker, so the classes stand out from it. */
export const IMAGERY_MUTE = { "raster-saturation": -0.6, "raster-brightness-max": 0.85 } as const;

interface LayerInfo {
  id: string;
  type: string;
  /** The type of the layer's source ("raster", "vector", "geojson", "canvas"…), when it has one. */
  sourceType?: string;
}

/**
 * The style's layers in order with their source types, read without serialising the style (this runs
 * on every styledata event). Empty when the map has no style yet, or is a test double without one.
 */
function layerInfo(map: Map): LayerInfo[] {
  try {
    const order = map.getLayersOrder?.();
    if (!order) return [];
    return order.flatMap((id) => {
      const layer = map.getLayer(id) as { type?: string; source?: string } | undefined;
      if (!layer?.type) return [];
      const source = layer.source ? (map.getSource(layer.source) as { type?: string } | undefined) : undefined;
      return [{ id, type: layer.type, sourceType: source?.type }];
    });
  } catch {
    return [];
  }
}

/** The basemap's own raster layers (imagery): raster layers on a raster tile source (not our canvas). */
export function imageryLayers(map: Map): string[] {
  return layerInfo(map)
    .filter((l) => l.type === "raster" && l.sourceType === "raster")
    .map((l) => l.id);
}

/** Satellite when the style shows imagery, else the dark vector basemap (also the default). */
export function basemapKind(map: Map): BasemapKind {
  return imageryLayers(map).length > 0 ? "satellite" : "dark";
}

/**
 * Where the heat goes in the layer stack: under the basemap's first road line or label (so names and
 * trails draw over it) and above its imagery and land fills. Undefined when the style has neither.
 */
export function basemapLabelLayer(map: Map): string | undefined {
  return layerInfo(map).find((l) => (l.type === "symbol" || l.type === "line") && l.sourceType === "vector")?.id;
}

const originals = new WeakMap<Map, globalThis.Map<string, Record<string, unknown>>>();

/** Mute the imagery while the heat is shown; `false` puts back what the style had. Safe in any state. */
export function muteImagery(map: Map, on: boolean): void {
  let saved = originals.get(map);
  if (!saved) {
    saved = new globalThis.Map();
    originals.set(map, saved);
  }
  for (const id of imageryLayers(map)) {
    try {
      if (on) {
        if (!saved.has(id)) {
          const before: Record<string, unknown> = {};
          for (const prop of Object.keys(IMAGERY_MUTE)) before[prop] = map.getPaintProperty(id, prop as PaintName);
          saved.set(id, before);
        }
        for (const [prop, value] of Object.entries(IMAGERY_MUTE)) map.setPaintProperty(id, prop as PaintName, value);
      } else {
        const before = saved.get(id);
        for (const prop of Object.keys(IMAGERY_MUTE)) map.setPaintProperty(id, prop as PaintName, before?.[prop] as never);
        saved.delete(id);
      }
    } catch {
      /* layer gone with a style reload */
    }
  }
}
