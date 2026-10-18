// MapLibre sources and layers for the heat map. Kept free of React so tests can use a mocked map.
//
// The cells are one canvas source (one pixel per cell, see raster.ts) drawn by a raster layer with
// nearest-neighbour resampling. A 5 m grid has 40,000 cells; as GeoJSON polygons with feature state
// the breathing and the replay ran at about 6 frames a second in Chrome. The raster is one texture:
// breathing changes only raster-opacity, and a new map state is one texture upload.
import type { CanvasSource, GeoJSONSource, Map } from "maplibre-gl";
import type { MapFile } from "../../contract";
import { HEAT_LAYER_PREFIX, MAP_LAYER_IDS } from "../base/layerIds";
import { DRONE_IMAGE_ID, DRONE_ICON_SIZE } from "./droneImage";
import { cellCenter, surveyedBoundary } from "./geometry";
import { gridCorners, type HeatRaster } from "./raster";
import { sectorName, sectorRing, SECTOR_STATE_LABEL, type SectorStatus } from "./sectors";

type Grid = MapFile["grid"];
type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];
type LonLat = [number, number];

export const HEAT_SOURCE_ID = `${HEAT_LAYER_PREFIX}cells`;
export const HEAT_SURVEYED_SOURCE_ID = `${HEAT_LAYER_PREFIX}surveyed`;
export const HEAT_HELD_SOURCE_ID = `${HEAT_LAYER_PREFIX}held`;
export const HEAT_TRAIL_SOURCE_ID = `${HEAT_LAYER_PREFIX}trail`;
export const HEAT_DRONE_SOURCE_ID = `${HEAT_LAYER_PREFIX}drone`;
export const HEAT_DRONE_FOOTPRINT_SOURCE_ID = `${HEAT_LAYER_PREFIX}drone-footprint`;
export const HEAT_HOTSPOT_SOURCE_ID = `${HEAT_LAYER_PREFIX}hotspots`;
export const HEAT_RIPPLE_SOURCE_ID = `${HEAT_LAYER_PREFIX}ripple`;
export const HEAT_SECTOR_SOURCE_ID = `${HEAT_LAYER_PREFIX}sectors`;
export const HEAT_SECTOR_LABEL_SOURCE_ID = `${HEAT_LAYER_PREFIX}sector-labels`;
export const HEAT_LAYER_IDS = {
  cells: `${HEAT_LAYER_PREFIX}cells`,
  sectorFill: `${HEAT_LAYER_PREFIX}sector-fill`,
  reviewOutline: `${HEAT_LAYER_PREFIX}review-outline`,
  surveyed: `${HEAT_LAYER_PREFIX}surveyed`,
  sectorLine: `${HEAT_LAYER_PREFIX}sector-line`,
  sectorLabel: `${HEAT_LAYER_PREFIX}sector-label`,
  hotspots: `${HEAT_LAYER_PREFIX}hotspots`,
  trail: `${HEAT_LAYER_PREFIX}trail`,
  droneFootprint: `${HEAT_LAYER_PREFIX}drone-footprint`,
  droneFootprintLine: `${HEAT_LAYER_PREFIX}drone-footprint-line`,
  droneHalo: `${HEAT_LAYER_PREFIX}drone-halo`,
  drone: `${HEAT_LAYER_PREFIX}drone`,
  ripple: `${HEAT_LAYER_PREFIX}ripple`,
} as const;

export type HeatVariant = "search" | "review";

export interface HeatColors {
  accent: string;
  outline: string;
  /** The app background (label halos, the drone's rim). */
  veil: string;
  /** Tone for the outline of cells awaiting review (the shell's "Unsure" token). */
  review: string;
  /** "Person" token, for the ripple of a confirmed person. */
  ok: string;
}

/** The dashed outline that marks cells awaiting review. */
export const REVIEW_OUTLINE_DASH = [2, 1.5];

/** MapLibre cannot read CSS variables, so read the tokens at runtime. */
export function readHeatColors(root: Element = document.documentElement): HeatColors {
  const styles = getComputedStyle(root);
  const v = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    accent: v("--accent", "#ff7a1a"),
    outline: v("--text", "#f2f2f0"),
    veil: v("--bg", "#0a0b0d"),
    review: v("--warn", "#ffc48f"),
    ok: v("--ok", "#7ee2a0"),
  };
}

/** Heat layers sit below every lane B layer: before grid-outline, or on top if B has not drawn yet. */
function beforeId(map: Map): string | undefined {
  return map.getLayer(MAP_LAYER_IDS.gridOutline) ? MAP_LAYER_IDS.gridOutline : undefined;
}

const EMPTY: GeoJsonData = { type: "FeatureCollection", features: [] };

/** Heat raster opacity at rest: full on Search next, a little fainter beside the review queue so pins stay first (lower than 0.8 turns the pale low end muddy over the dark basemap). */
export const HEAT_BASE_OPACITY = { search: 0.95, review: 0.8 } as const;

function lines(segments: LonLat[][]): GeoJsonData {
  return { type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: segments } };
}

/**
 * Add the heat sources and layers if they are missing (first render, or after a style reload
 * dropped them). Returns true when the cell source was (re)added. Never rebuilds an existing source.
 * The review variant leaves out the hotspots, the replay trail and the drone.
 */
export function ensureHeatLayers(
  map: Map,
  raster: Pick<HeatRaster, "canvas">,
  grid: Grid,
  covered: Uint8Array,
  colors: HeatColors,
  variant: HeatVariant = "search",
): boolean {
  let added = false;
  if (!map.getSource(HEAT_SOURCE_ID)) {
    map.addSource(HEAT_SOURCE_ID, {
      type: "canvas",
      canvas: raster.canvas,
      coordinates: gridCorners(grid),
      animate: false,
    });
    added = true;
  }
  if (!map.getSource(HEAT_SURVEYED_SOURCE_ID)) {
    map.addSource(HEAT_SURVEYED_SOURCE_ID, { type: "geojson", data: lines(surveyedBoundary(grid, covered)) });
  }
  for (const id of [HEAT_HELD_SOURCE_ID, HEAT_SECTOR_SOURCE_ID, HEAT_SECTOR_LABEL_SOURCE_ID, HEAT_RIPPLE_SOURCE_ID]) {
    if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: EMPTY });
  }

  if (!map.getLayer(HEAT_LAYER_IDS.cells)) {
    map.addLayer(
      {
        id: HEAT_LAYER_IDS.cells,
        type: "raster",
        source: HEAT_SOURCE_ID,
        paint: {
          "raster-opacity": HEAT_BASE_OPACITY[variant],
          // Every cell a crisp square: no smoothing between cells, no invented detail.
          "raster-resampling": "nearest",
          "raster-fade-duration": 0,
        },
      },
      beforeId(map),
    );
  }
  if (!map.getLayer(HEAT_LAYER_IDS.sectorFill)) {
    map.addLayer(
      {
        id: HEAT_LAYER_IDS.sectorFill,
        type: "fill",
        source: HEAT_SECTOR_SOURCE_ID,
        paint: {
          "fill-color": ["case", ["get", "current"], colors.accent, colors.outline],
          "fill-opacity": ["case", ["get", "current"], 0.1, ["get", "hover"], 0.08, 0],
          "fill-antialias": false,
        },
      },
      beforeId(map),
    );
  }
  // The dashed outline around cells awaiting review (one merged boundary, readable at any zoom).
  if (!map.getLayer(HEAT_LAYER_IDS.reviewOutline)) {
    map.addLayer(
      {
        id: HEAT_LAYER_IDS.reviewOutline,
        type: "line",
        source: HEAT_HELD_SOURCE_ID,
        paint: {
          "line-color": colors.review,
          "line-opacity": 0.95,
          "line-width": 1.5,
          "line-dasharray": REVIEW_OUTLINE_DASH,
        },
      },
      beforeId(map),
    );
  }
  if (!map.getLayer(HEAT_LAYER_IDS.surveyed)) {
    map.addLayer(
      {
        id: HEAT_LAYER_IDS.surveyed,
        type: "line",
        source: HEAT_SURVEYED_SOURCE_ID,
        paint: { "line-color": colors.outline, "line-opacity": 0.55, "line-width": 1 },
      },
      beforeId(map),
    );
  }
  if (!map.getLayer(HEAT_LAYER_IDS.sectorLine)) {
    map.addLayer(
      {
        id: HEAT_LAYER_IDS.sectorLine,
        type: "line",
        source: HEAT_SECTOR_SOURCE_ID,
        paint: {
          "line-color": ["case", ["get", "current"], colors.accent, colors.outline],
          // Resting sector lines stay faint so they do not rule lines across the heat.
          "line-opacity": ["case", ["get", "current"], 0.95, ["get", "hover"], 0.9, 0.16],
          "line-width": ["case", ["any", ["get", "current"], ["get", "hover"]], 1.75, 0.5],
        },
      },
      beforeId(map),
    );
  }
  if (!map.getLayer(HEAT_LAYER_IDS.sectorLabel)) {
    map.addLayer(
      {
        id: HEAT_LAYER_IDS.sectorLabel,
        type: "symbol",
        source: HEAT_SECTOR_LABEL_SOURCE_ID,
        layout: {
          "text-field": ["get", "text"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          "text-anchor": ["get", "anchor"],
          "text-justify": ["get", "justify"],
          "text-offset": ["array", "number", 2, ["get", "offset"]],
          "text-letter-spacing": 0.03,
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": ["case", ["get", "current"], colors.accent, colors.outline],
          "text-opacity": ["case", ["any", ["get", "current"], ["get", "hover"]], 1, 0.7],
          "text-halo-color": colors.veil,
          "text-halo-width": 1.4,
        },
      },
      beforeId(map),
    );
  }
  if (variant === "search") {
    // The Search next cells: a ring that breathes with the heat (see setBreath).
    for (const id of [HEAT_HOTSPOT_SOURCE_ID, HEAT_TRAIL_SOURCE_ID, HEAT_DRONE_SOURCE_ID, HEAT_DRONE_FOOTPRINT_SOURCE_ID]) {
      if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: EMPTY });
    }
    if (!map.getLayer(HEAT_LAYER_IDS.hotspots)) {
      map.addLayer({
        id: HEAT_LAYER_IDS.hotspots,
        type: "circle",
        source: HEAT_HOTSPOT_SOURCE_ID,
        paint: {
          "circle-radius": HOTSPOT_RADIUS_PX,
          "circle-color": colors.outline,
          "circle-opacity": 0,
          "circle-stroke-color": colors.outline,
          "circle-stroke-width": 2,
          "circle-stroke-opacity": HOTSPOT_OPACITY.mid,
        },
      });
    }
    // The replay trail, the photo being taken now, and the drone go on top: they are what moves.
    if (!map.getLayer(HEAT_LAYER_IDS.trail)) {
      map.addLayer({
        id: HEAT_LAYER_IDS.trail,
        type: "line",
        source: HEAT_TRAIL_SOURCE_ID,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": colors.outline, "line-opacity": 0.45, "line-width": 1.25 },
      });
    }
    if (!map.getLayer(HEAT_LAYER_IDS.droneFootprint)) {
      map.addLayer({
        id: HEAT_LAYER_IDS.droneFootprint,
        type: "fill",
        source: HEAT_DRONE_FOOTPRINT_SOURCE_ID,
        paint: { "fill-color": colors.accent, "fill-opacity": 0.22, "fill-antialias": true },
      });
    }
    if (!map.getLayer(HEAT_LAYER_IDS.droneFootprintLine)) {
      map.addLayer({
        id: HEAT_LAYER_IDS.droneFootprintLine,
        type: "line",
        source: HEAT_DRONE_FOOTPRINT_SOURCE_ID,
        paint: { "line-color": colors.accent, "line-opacity": 0.9, "line-width": 1.25 },
      });
    }
    if (!map.getLayer(HEAT_LAYER_IDS.droneHalo)) {
      map.addLayer({
        id: HEAT_LAYER_IDS.droneHalo,
        type: "circle",
        source: HEAT_DRONE_SOURCE_ID,
        paint: { "circle-color": colors.accent, "circle-opacity": 0.22, "circle-radius": 22, "circle-blur": 0.9 },
      });
    }
    if (!map.getLayer(HEAT_LAYER_IDS.drone)) {
      map.addLayer({
        id: HEAT_LAYER_IDS.drone,
        type: "symbol",
        source: HEAT_DRONE_SOURCE_ID,
        layout: {
          "icon-image": DRONE_IMAGE_ID,
          "icon-size": DRONE_ICON_SIZE,
          "icon-rotate": ["get", "bearing"],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });
    }
  }
  // The ripple at an answered pin, on top so it reads over the pin it came from.
  if (!map.getLayer(HEAT_LAYER_IDS.ripple)) {
    map.addLayer({
      id: HEAT_LAYER_IDS.ripple,
      type: "circle",
      source: HEAT_RIPPLE_SOURCE_ID,
      paint: {
        "circle-radius": 0,
        "circle-color": ["get", "color"],
        "circle-opacity": 0,
        "circle-stroke-color": ["get", "color"],
        "circle-stroke-width": 2,
        "circle-stroke-opacity": 0,
      },
    });
  }
  return added;
}

/**
 * Tell MapLibre the canvas changed. While `playing` the source re-uploads every frame; when the
 * animation ends (or for a one-off change) pause() uploads once more and stops.
 */
export function refreshHeatSource(map: Map, playing: boolean): void {
  const source = map.getSource(HEAT_SOURCE_ID) as Partial<CanvasSource> | undefined;
  if (!source || typeof source.play !== "function" || typeof source.pause !== "function") return;
  source.play();
  if (!playing) source.pause();
}

/** Redraw the outline of the cells photographed so far. */
export function setSurveyedBoundary(map: Map, grid: Grid, photographed: Uint8Array): void {
  (map.getSource(HEAT_SURVEYED_SOURCE_ID) as GeoJSONSource | undefined)?.setData?.(lines(surveyedBoundary(grid, photographed)));
}

/** Redraw the dashed outline of the photographed cells awaiting review. */
export function setHeldBoundary(map: Map, grid: Grid, covered: Uint8Array, held: Uint8Array): void {
  const shown = Uint8Array.from(held, (h, i) => (h === 1 && covered[i] === 1 ? 1 : 0));
  (map.getSource(HEAT_HELD_SOURCE_ID) as GeoJSONSource | undefined)?.setData?.(lines(surveyedBoundary(grid, shown)));
}

/**
 * Sector outlines and labels, with the current / hovered sector marked. A resting label is just the
 * sector's name (the Sectors list has every state); the current and the hovered sector add their state.
 */
export function sectorFeatures(
  grid: Grid,
  statuses: readonly SectorStatus[],
  currentId: string | null,
  hoverId: string | null,
): { areas: GeoJsonData; labels: GeoJsonData } {
  const areas = statuses.map((s) => ({
    type: "Feature" as const,
    properties: { id: s.sector.id, current: s.sector.id === currentId, hover: s.sector.id === hoverId },
    geometry: { type: "Polygon" as const, coordinates: [sectorRing(grid, s.sector)] },
  }));
  const labels = statuses.map((s) => {
    const ring = sectorRing(grid, s.sector);
    // Flight sectors are thin strips under the heat: label them just outside, west of the strip,
    // like row labels. Other sectors: inside their north-west corner.
    const flight = s.sector.kind === "flight";
    const at: LonLat = flight
      ? [(ring[0] as LonLat)[0], ((ring[0] as LonLat)[1] + (ring[3] as LonLat)[1]) / 2]
      : (ring[0] as LonLat);
    const active = s.sector.id === currentId || s.sector.id === hoverId;
    const state = s.sector.id === currentId ? "Drone here" : SECTOR_STATE_LABEL[s.state];
    const name = sectorName(s.sector).toUpperCase();
    return {
      type: "Feature" as const,
      properties: {
        id: s.sector.id,
        text: active ? `${name}\n${state}` : name,
        current: s.sector.id === currentId,
        hover: s.sector.id === hoverId,
        anchor: flight ? "right" : "top-left",
        justify: flight ? "right" : "left",
        offset: flight ? [-0.7, 0] : [0.45, 0.35],
      },
      geometry: { type: "Point" as const, coordinates: at },
    };
  });
  return { areas: { type: "FeatureCollection", features: areas }, labels: { type: "FeatureCollection", features: labels } };
}

export function pushSectors(
  map: Map,
  grid: Grid,
  statuses: readonly SectorStatus[],
  currentId: string | null,
  hoverId: string | null,
): void {
  const { areas, labels } = sectorFeatures(grid, statuses, currentId, hoverId);
  (map.getSource(HEAT_SECTOR_SOURCE_ID) as GeoJSONSource | undefined)?.setData?.(areas);
  (map.getSource(HEAT_SECTOR_LABEL_SOURCE_ID) as GeoJSONSource | undefined)?.setData?.(labels);
}

/** Where the drone has flown after `stepIndex` frames, and where it is now. */
export function replayFeatures(
  path: LonLat[],
  stepIndex: number,
): { trail: GeoJsonData; drone: GeoJsonData } {
  const flown = path.slice(0, Math.max(0, Math.min(stepIndex, path.length)));
  const at = flown.at(-1);
  const prev = flown.at(-2) ?? path[flown.length];
  return {
    trail:
      flown.length >= 2
        ? { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: flown } }
        : EMPTY,
    drone: at
      ? {
          type: "Feature",
          properties: { bearing: prev ? (flown.length >= 2 ? bearingDeg(prev, at) : bearingDeg(at, prev)) : 0 },
          geometry: { type: "Point", coordinates: at },
        }
      : EMPTY,
  };
}

/** Compass bearing in degrees (0 = north, 90 = east) from a to b, local flat approximation. */
export function bearingDeg(a: LonLat, b: LonLat): number {
  const dx = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return 0;
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

/** Lane B's flight layers that the legend's "Flight path (simulated)" switch shows and hides. */
export const FLIGHT_LAYER_IDS = [MAP_LAYER_IDS.flightPath, MAP_LAYER_IDS.flightDirection] as const;

/** Show or hide the flight path and its chevrons. Safe before lane B has drawn them. */
export function setFlightPathVisible(map: Map, visible: boolean): void {
  for (const id of FLIGHT_LAYER_IDS) {
    if (map.getLayer(id)) map.setLayoutProperty?.(id, "visibility", visible ? "visible" : "none");
  }
}

/** Move the trail and the drone to a whole step. Safe before the sources exist (does nothing). */
export function pushReplay(map: Map, path: LonLat[], stepIndex: number): void {
  const { trail, drone } = replayFeatures(path, stepIndex);
  (map.getSource(HEAT_TRAIL_SOURCE_ID) as GeoJSONSource | undefined)?.setData?.(trail);
  (map.getSource(HEAT_DRONE_SOURCE_ID) as GeoJSONSource | undefined)?.setData?.(drone);
}

/** Draw the drone at an interpolated position (the smooth replay; see droneMotion.ts). */
export function pushDrone(
  map: Map,
  at: LonLat | null,
  bearing: number,
  trail: LonLat[],
  footprint: readonly (readonly [number, number])[] | null,
): void {
  (map.getSource(HEAT_DRONE_SOURCE_ID) as GeoJSONSource | undefined)?.setData?.(
    at ? { type: "Feature", properties: { bearing }, geometry: { type: "Point", coordinates: at } } : EMPTY,
  );
  (map.getSource(HEAT_TRAIL_SOURCE_ID) as GeoJSONSource | undefined)?.setData?.(
    trail.length >= 2 ? { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: trail } } : EMPTY,
  );
  (map.getSource(HEAT_DRONE_FOOTPRINT_SOURCE_ID) as GeoJSONSource | undefined)?.setData?.(
    footprint && footprint.length >= 3
      ? {
          type: "Feature",
          properties: {},
          geometry: { type: "Polygon", coordinates: [[...footprint.map((c) => [c[0], c[1]]), [footprint[0]![0], footprint[0]![1]]]] },
        }
      : EMPTY,
  );
}

/** Breathing: ±10 % over 5 s. Slow and small on purpose (nothing flashes; WCAG 2.3.1). */
export const BREATH_AMPLITUDE = 0.1;
export const BREATH_PERIOD_MS = 5000;
/** Hotspot ring opacity across one breath, and its radius at rest (it breathes ±1.5 px). */
export const HOTSPOT_OPACITY = { low: 0.45, mid: 0.7, high: 0.95 } as const;
export const HOTSPOT_RADIUS_PX = 9;

/** 1 ± BREATH_AMPLITUDE, a sine of period BREATH_PERIOD_MS. */
export function breathFactor(tMs: number): number {
  return 1 + BREATH_AMPLITUDE * Math.sin((2 * Math.PI * tMs) / BREATH_PERIOD_MS);
}

/** Apply one breath: the heat raster's opacity and the hotspot rings, in step. Cheap: no data-driven paint. */
export function setBreath(map: Map, factor: number, base: number = HEAT_BASE_OPACITY.search): void {
  if (map.getLayer(HEAT_LAYER_IDS.cells)) {
    map.setPaintProperty(HEAT_LAYER_IDS.cells, "raster-opacity", Math.min(1, base * factor));
  }
  if (map.getLayer(HEAT_LAYER_IDS.hotspots)) {
    const t = (factor - (1 - BREATH_AMPLITUDE)) / (2 * BREATH_AMPLITUDE); // 0 … 1
    const { low, high } = HOTSPOT_OPACITY;
    map.setPaintProperty(HEAT_LAYER_IDS.hotspots, "circle-stroke-opacity", low + t * (high - low));
    map.setPaintProperty(HEAT_LAYER_IDS.hotspots, "circle-radius", HOTSPOT_RADIUS_PX + 3 * (t - 0.5));
  }
}

/** Centres of the given cells (the Search next list), for the hotspot rings. */
export function hotspotFeatures(grid: Grid, cells: readonly number[]): GeoJsonData {
  return {
    type: "FeatureCollection",
    features: cells.map((idx, rank) => {
      const c = cellCenter(grid, idx);
      return { type: "Feature", properties: { idx, rank: rank + 1 }, geometry: { type: "Point", coordinates: [c.lon, c.lat] } };
    }),
  };
}

/** Redraw the hotspot outlines. Safe before the source exists (does nothing). */
export function pushHotspots(map: Map, grid: Grid, cells: readonly number[]): void {
  (map.getSource(HEAT_HOTSPOT_SOURCE_ID) as GeoJSONSource | undefined)?.setData?.(hotspotFeatures(grid, cells));
}

/** Ripple: grows from RIPPLE_FROM_PX to RIPPLE_TO_PX and fades out over RIPPLE_MS. */
export const RIPPLE_MS = 750;
export const RIPPLE_FROM_PX = 8;
export const RIPPLE_TO_PX = 46;

/** Ring radius and opacity at time t (0…1) of the ripple. */
export function rippleFrame(t: number): { radius: number; opacity: number } {
  const k = Math.min(1, Math.max(0, t));
  const eased = 1 - (1 - k) ** 3;
  return { radius: RIPPLE_FROM_PX + (RIPPLE_TO_PX - RIPPLE_FROM_PX) * eased, opacity: 0.95 * (1 - k) };
}

/** Put the ripple at a pin (or clear it with null). */
export function pushRipple(map: Map, at: LonLat | null, color: string): void {
  (map.getSource(HEAT_RIPPLE_SOURCE_ID) as GeoJSONSource | undefined)?.setData?.(
    at ? { type: "Feature", properties: { color }, geometry: { type: "Point", coordinates: at } } : EMPTY,
  );
}

/** One ripple frame. Safe before the layer exists. */
export function setRippleFrame(map: Map, t: number): void {
  if (!map.getLayer(HEAT_LAYER_IDS.ripple)) return;
  const { radius, opacity } = rippleFrame(t);
  map.setPaintProperty(HEAT_LAYER_IDS.ripple, "circle-radius", radius);
  map.setPaintProperty(HEAT_LAYER_IDS.ripple, "circle-stroke-opacity", opacity);
  map.setPaintProperty(HEAT_LAYER_IDS.ripple, "circle-opacity", opacity * 0.12);
}
