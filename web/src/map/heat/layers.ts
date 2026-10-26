// MapLibre sources and layers for the heat map. Kept free of React so tests can use a mocked map.
//
// The probability surface (surface.ts) is per-class GeoJSON fills and contour lines at rest and one
// canvas raster while it animates. A 5 m grid has 40,000 cells; as one GeoJSON polygon per cell with
// feature state the replay ran at about 6 frames a second in Chrome, so the fills are the cells of
// each class merged into rectangles (a few hundred to a few thousand), and the animation is the
// raster: breathing changes only opacities, and a frame is one texture upload.
import type { CanvasSource, GeoJSONSource, Map } from "maplibre-gl";
import type { MapFile } from "../../contract";
import { HEAT_LAYER_PREFIX, MAP_LAYER_IDS } from "../base/layerIds";
import { DRONE_IMAGE_ID, DRONE_ICON_SIZE } from "./droneImage";
import { HOTSPOT_BADGE_COUNT, HOTSPOT_BADGE_PREFIX } from "./hotspotImages";
import { surveyedBoundary, type LikelyPatch } from "./geometry";
import { basemapLabelLayer, type HeatPalette, HEAT_PALETTES } from "./palette";
import type { HeatRaster } from "./raster";
import { ensureSurfaceLayers, setSurfaceOpacity, type SurfaceMode, surfaceIds, type SurfaceTheme } from "./surface";
import type { LabelCandidate } from "./labelPlacement";
import { sectorName, sectorRing, SECTOR_STATE_LABEL, type SectorStatus } from "./sectors";

type Grid = MapFile["grid"];
type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];
type LonLat = [number, number];

export const HEAT_SOURCE_ID = `${HEAT_LAYER_PREFIX}cells`;
export const HEAT_SURVEYED_SOURCE_ID = `${HEAT_LAYER_PREFIX}surveyed`;
export const HEAT_HELD_SOURCE_ID = `${HEAT_LAYER_PREFIX}held`;
export const HEAT_CANDIDATE_SOURCE_ID = `${HEAT_LAYER_PREFIX}candidates`;
export const HEAT_UNSURE_SOURCE_ID = `${HEAT_LAYER_PREFIX}unsure`;
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
  candidateOutline: `${HEAT_LAYER_PREFIX}candidate-outline`,
  unsureOutline: `${HEAT_LAYER_PREFIX}unsure-outline`,
  surveyed: `${HEAT_LAYER_PREFIX}surveyed`,
  sectorLine: `${HEAT_LAYER_PREFIX}sector-line`,
  sectorLabel: `${HEAT_LAYER_PREFIX}sector-label`,
  hotspotPatchOutline: `${HEAT_LAYER_PREFIX}hotspot-patch-outline`,
  hotspotPatchActive: `${HEAT_LAYER_PREFIX}hotspot-patch-active`,
  hotspotHalo: `${HEAT_LAYER_PREFIX}hotspot-halo`,
  hotspotPulse: `${HEAT_LAYER_PREFIX}hotspot-pulse`,
  hotspots: `${HEAT_LAYER_PREFIX}hotspots`,
  hotspotActive: `${HEAT_LAYER_PREFIX}hotspot-active`,
  hotspotBadge: `${HEAT_LAYER_PREFIX}hotspot-badge`,
  trail: `${HEAT_LAYER_PREFIX}trail`,
  droneFootprint: `${HEAT_LAYER_PREFIX}drone-footprint`,
  droneFootprintLine: `${HEAT_LAYER_PREFIX}drone-footprint-line`,
  droneHalo: `${HEAT_LAYER_PREFIX}drone-halo`,
  drone: `${HEAT_LAYER_PREFIX}drone`,
  ripple: `${HEAT_LAYER_PREFIX}ripple`,
} as const;
/** The probability surface's layers: the raster (HEAT_LAYER_IDS.cells), class fills and contours. */
export const HEAT_SURFACE_IDS = surfaceIds(HEAT_LAYER_PREFIX, HEAT_LAYER_IDS.cells);

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

/** The "Unsure" ring's width: thinner than the candidate ring (2.5), as wide as the unsure pin's ring. */
export const UNSURE_OUTLINE_WIDTH = 2;

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

/**
 * The surface's opacity multiplier: the classes' own alphas (palette.ts) on Search next, fainter
 * beside the review queue so the pins stay first. Faded further by zoom (palette.ts ZOOM_FADE).
 */
export const HEAT_BASE_OPACITY = { search: 1, review: 0.75 } as const;

/** The surface's two theme colours from the heat colours: the veil (app background) and the held tone. */
export function heatTheme(colors: HeatColors): SurfaceTheme {
  return { veil: colors.veil, held: colors.outline };
}

/**
 * Where the surface goes: under the basemap's first road or label, else under every lane B layer
 * (before grid-outline), else on top.
 */
export function surfaceBeforeId(map: Map): string | undefined {
  return basemapLabelLayer(map) ?? beforeId(map);
}

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
  palette: HeatPalette = HEAT_PALETTES.dark,
  mode: SurfaceMode = "vector",
): boolean {
  const added = ensureSurfaceLayers(
    map,
    HEAT_SURFACE_IDS,
    raster.canvas,
    grid,
    palette,
    heatTheme(colors),
    HEAT_BASE_OPACITY[variant],
    mode,
    surfaceBeforeId(map),
  );
  if (!map.getSource(HEAT_SURVEYED_SOURCE_ID)) {
    map.addSource(HEAT_SURVEYED_SOURCE_ID, { type: "geojson", data: lines(surveyedBoundary(grid, covered)) });
  }
  for (const id of [HEAT_HELD_SOURCE_ID, HEAT_CANDIDATE_SOURCE_ID, HEAT_UNSURE_SOURCE_ID, HEAT_SECTOR_SOURCE_ID, HEAT_SECTOR_LABEL_SOURCE_ID, HEAT_RIPPLE_SOURCE_ID]) {
    if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: EMPTY });
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
  // Candidate sightings: a solid ring in the "Person" colour around their cells (drawn darkest).
  if (!map.getLayer(HEAT_LAYER_IDS.candidateOutline)) {
    map.addLayer(
      {
        id: HEAT_LAYER_IDS.candidateOutline,
        type: "line",
        source: HEAT_CANDIDATE_SOURCE_ID,
        paint: { "line-color": colors.ok, "line-opacity": 1, "line-width": 2.5 },
      },
      beforeId(map),
    );
  }
  // "Unsure" areas: a solid amber ring, thinner than the candidate's (the unsure pin's colour and
  // width), so it reads as unresolved and differs from the dashed "awaiting review" outline.
  if (!map.getLayer(HEAT_LAYER_IDS.unsureOutline)) {
    map.addLayer(
      {
        id: HEAT_LAYER_IDS.unsureOutline,
        type: "line",
        source: HEAT_UNSURE_SOURCE_ID,
        paint: { "line-color": colors.review, "line-opacity": 1, "line-width": UNSURE_OUTLINE_WIDTH },
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
          "text-size": 13,
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
    for (const id of [HEAT_HOTSPOT_SOURCE_ID, HEAT_TRAIL_SOURCE_ID, HEAT_DRONE_SOURCE_ID, HEAT_DRONE_FOOTPRINT_SOURCE_ID]) {
      if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: EMPTY });
    }
    // Bottom to top: the replay trail and the photo being taken, the last known point (raiseLkp),
    // the search-next circles (above the heat and the flight path), then the drone.
    if (!map.getLayer(HEAT_LAYER_IDS.trail)) {
      map.addLayer({
        id: HEAT_LAYER_IDS.trail,
        type: "line",
        source: HEAT_TRAIL_SOURCE_ID,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": colors.outline, "line-opacity": TRAIL_OPACITY.rest, "line-width": 1.25 },
      });
    }
    if (!map.getLayer(HEAT_LAYER_IDS.droneFootprint)) {
      map.addLayer({
        id: HEAT_LAYER_IDS.droneFootprint,
        type: "fill",
        source: HEAT_DRONE_FOOTPRINT_SOURCE_ID,
        paint: { "fill-color": colors.accent, "fill-opacity": 0, "fill-antialias": true },
      });
    }
    if (!map.getLayer(HEAT_LAYER_IDS.droneFootprintLine)) {
      map.addLayer({
        id: HEAT_LAYER_IDS.droneFootprintLine,
        type: "line",
        source: HEAT_DRONE_FOOTPRINT_SOURCE_ID,
        paint: { "line-color": colors.accent, "line-opacity": 0, "line-width": 1.25 },
      });
    }
    // Patch outlines show the actual connected ground; centroid circles carry the matching list
    // number. The near-white ring uses a dark casing (it holds against the pale-yellow
    // and the deep-red ends of the heat and against the trail), a numbered accent badge matching the
    // list, a slow pulse on the first (setHotspotPulse), and an accent ring on the one hovered or
    // picked in the list (setActiveHotspot).
    if (!map.getLayer(HEAT_LAYER_IDS.hotspotPatchOutline)) {
      map.addLayer({
        id: HEAT_LAYER_IDS.hotspotPatchOutline,
        type: "line",
        source: HEAT_HOTSPOT_SOURCE_ID,
        filter: ["==", ["get", "kind"], "outline"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": colors.outline, "line-opacity": 0.8, "line-width": 2 },
      });
    }
    if (!map.getLayer(HEAT_LAYER_IDS.hotspotPatchActive)) {
      map.addLayer({
        id: HEAT_LAYER_IDS.hotspotPatchActive,
        type: "line",
        source: HEAT_HOTSPOT_SOURCE_ID,
        filter: ["all", ["==", ["get", "kind"], "outline"], ["==", ["get", "idx"], -1]],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": colors.accent, "line-opacity": 1, "line-width": 4 },
      });
    }
    if (!map.getLayer(HEAT_LAYER_IDS.hotspotHalo)) {
      map.addLayer({
        id: HEAT_LAYER_IDS.hotspotHalo,
        type: "circle",
        source: HEAT_HOTSPOT_SOURCE_ID,
        filter: ["==", ["get", "kind"], "marker"],
        paint: {
          "circle-radius": HOTSPOT_RADIUS_PX,
          "circle-color": colors.veil,
          "circle-opacity": HOTSPOT_STYLE.fillOpacity,
          "circle-stroke-color": colors.veil,
          "circle-stroke-width": HOTSPOT_STYLE.casingPx,
          "circle-stroke-opacity": HOTSPOT_STYLE.casingOpacity,
        },
      });
    }
    if (!map.getLayer(HEAT_LAYER_IDS.hotspotPulse)) {
      map.addLayer({
        id: HEAT_LAYER_IDS.hotspotPulse,
        type: "circle",
        source: HEAT_HOTSPOT_SOURCE_ID,
        filter: ["all", ["==", ["get", "kind"], "marker"], ["==", ["get", "rank"], 1]],
        paint: {
          "circle-radius": HOTSPOT_RADIUS_PX,
          "circle-opacity": 0,
          "circle-stroke-color": colors.outline,
          "circle-stroke-width": 2,
          "circle-stroke-opacity": 0,
        },
      });
    }
    if (!map.getLayer(HEAT_LAYER_IDS.hotspots)) {
      map.addLayer({
        id: HEAT_LAYER_IDS.hotspots,
        type: "circle",
        source: HEAT_HOTSPOT_SOURCE_ID,
        filter: ["==", ["get", "kind"], "marker"],
        paint: {
          "circle-radius": HOTSPOT_RADIUS_PX,
          "circle-opacity": 0,
          "circle-stroke-color": colors.outline,
          "circle-stroke-width": HOTSPOT_STYLE.ringPx,
          "circle-stroke-opacity": 1,
        },
      });
    }
    if (!map.getLayer(HEAT_LAYER_IDS.hotspotActive)) {
      map.addLayer({
        id: HEAT_LAYER_IDS.hotspotActive,
        type: "circle",
        source: HEAT_HOTSPOT_SOURCE_ID,
        filter: ["all", ["==", ["get", "kind"], "marker"], ["==", ["get", "idx"], -1]],
        paint: {
          "circle-radius": HOTSPOT_RADIUS_PX + 6,
          "circle-opacity": 0,
          "circle-stroke-color": colors.accent,
          "circle-stroke-width": 3,
          "circle-stroke-opacity": 1,
        },
      });
    }
    if (!map.getLayer(HEAT_LAYER_IDS.hotspotBadge)) {
      map.addLayer({
        id: HEAT_LAYER_IDS.hotspotBadge,
        type: "symbol",
        source: HEAT_HOTSPOT_SOURCE_ID,
        filter: ["==", ["get", "kind"], "marker"],
        layout: {
          "icon-image": ["concat", HOTSPOT_BADGE_PREFIX, ["to-string", ["min", ["get", "rank"], HOTSPOT_BADGE_COUNT]]],
          // Up and to the right of the ring, so the cell inside it stays visible.
          "icon-offset": [HOTSPOT_BADGE_OFFSET_PX, -HOTSPOT_BADGE_OFFSET_PX],
          "icon-size": ["case", ["==", ["get", "rank"], 1], 1.15, 1],
          "icon-allow-overlap": true,
          // Badges always show, and labels (the last known point's) move off them and their ring.
          "icon-padding": HOTSPOT_RADIUS_PX - HOTSPOT_BADGE_OFFSET_PX + 6,
          "symbol-sort-key": ["-", 0, ["get", "rank"]],
        },
        paint: { "icon-opacity": 1 },
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

/** Redraw the ring around the candidate sighting cells. */
export function setCandidateBoundary(map: Map, grid: Grid, candidate: Uint8Array): void {
  (map.getSource(HEAT_CANDIDATE_SOURCE_ID) as GeoJSONSource | undefined)?.setData?.(lines(surveyedBoundary(grid, candidate)));
}

/** Redraw the amber ring around the "Unsure" cells. */
export function setUnsureBoundary(map: Map, grid: Grid, unsure: Uint8Array): void {
  (map.getSource(HEAT_UNSURE_SOURCE_ID) as GeoJSONSource | undefined)?.setData?.(lines(surveyedBoundary(grid, unsure)));
}

/** Redraw the dashed outline of the photographed cells awaiting review. */
export function setHeldBoundary(map: Map, grid: Grid, covered: Uint8Array, held: Uint8Array): void {
  const shown = new Uint8Array(held.length);
  for (let i = 0; i < held.length; i++) if (held[i] === 1 && covered[i] === 1) shown[i] = 1;
  (map.getSource(HEAT_HELD_SOURCE_ID) as GeoJSONSource | undefined)?.setData?.(lines(surveyedBoundary(grid, shown)));
}

/**
 * Where a sector's label may go, best first (see labelPlacement.ts). Flight sectors are thin strips
 * under the heat: just outside their west edge, like row labels, else just inside it. Outer sectors:
 * next to the photographed area they surround (their corners are often far off screen), else their
 * north-west corner. Lattice sectors: inside the north-west corner, else the south-east one.
 */
export function labelCandidates(grid: Grid, s: SectorStatus, all: readonly SectorStatus[]): LabelCandidate[] {
  const ring = sectorRing(grid, s.sector);
  const [nw, ne, se, sw] = ring as [LonLat, LonLat, LonLat, LonLat];
  const nwCorner: LabelCandidate = { at: nw, anchor: "top-left", offset: [0.45, 0.35] };
  const midLat = (nw[1] + sw[1]) / 2;
  if (s.sector.kind === "flight") {
    return [
      { at: [nw[0], midLat], anchor: "right", offset: [-0.7, 0] },
      { at: [nw[0], midLat], anchor: "left", offset: [0.7, 0] },
    ];
  }
  if (s.sector.kind === "lattice") return [nwCorner, { at: se, anchor: "bottom-right", offset: [-0.45, -0.35] }];
  const flights = all.filter((x) => x.sector.kind === "flight");
  const surveyWestLon = flights.length > 0 ? Math.min(...flights.map((x) => sectorRing(grid, x.sector)[0]![0])) : nw[0];
  switch (s.sector.id) {
    case "N":
      return [{ at: [surveyWestLon, sw[1]], anchor: "bottom-left", offset: [0.45, -0.35] }, nwCorner];
    case "S":
      return [{ at: [surveyWestLon, nw[1]], anchor: "top-left", offset: [0.45, 0.35] }, nwCorner];
    case "W":
      return [{ at: ne, anchor: "top-right", offset: [-0.45, 0.35] }, nwCorner];
    default:
      return [nwCorner];
  }
}

/** Picks one of a label's candidates, or null to hide it (labelPlacement.placeLabel on the live map). */
export type PlaceLabel = (candidates: readonly LabelCandidate[], text: string) => LabelCandidate | null;

/**
 * Sector outlines and labels, with the current / hovered sector marked. A resting label is just the
 * sector's name (the Sectors list has every state); the current and the hovered sector add their state.
 * Without `place` each label takes its first candidate; with it, a label no candidate fits is left out.
 */
export function sectorFeatures(
  grid: Grid,
  statuses: readonly SectorStatus[],
  currentId: string | null,
  hoverId: string | null,
  place?: PlaceLabel,
): { areas: GeoJsonData; labels: GeoJsonData } {
  const areas = statuses.map((s) => ({
    type: "Feature" as const,
    properties: { id: s.sector.id, current: s.sector.id === currentId, hover: s.sector.id === hoverId },
    geometry: { type: "Polygon" as const, coordinates: [sectorRing(grid, s.sector)] },
  }));
  const labels = statuses.flatMap((s) => {
    const active = s.sector.id === currentId || s.sector.id === hoverId;
    const state = s.sector.id === currentId ? "Drone here" : SECTOR_STATE_LABEL[s.state];
    const name = sectorName(s.sector).toUpperCase();
    const text = active ? `${name}\n${state}` : name;
    const candidates = labelCandidates(grid, s, statuses);
    const chosen = place ? place(candidates, text) : (candidates[0] ?? null);
    if (!chosen) return [];
    const right = chosen.anchor.endsWith("right");
    return [
      {
        type: "Feature" as const,
        properties: {
          id: s.sector.id,
          text,
          current: s.sector.id === currentId,
          hover: s.sector.id === hoverId,
          anchor: chosen.anchor,
          justify: right ? "right" : "left",
          offset: chosen.offset,
        },
        geometry: { type: "Point" as const, coordinates: chosen.at },
      },
    ];
  });
  return { areas: { type: "FeatureCollection", features: areas }, labels: { type: "FeatureCollection", features: labels } };
}

export function pushSectors(
  map: Map,
  grid: Grid,
  statuses: readonly SectorStatus[],
  currentId: string | null,
  hoverId: string | null,
  place?: PlaceLabel,
): void {
  const { areas, labels } = sectorFeatures(grid, statuses, currentId, hoverId, place);
  (map.getSource(HEAT_SECTOR_SOURCE_ID) as GeoJSONSource | undefined)?.setData?.(areas);
  (map.getSource(HEAT_SECTOR_LABEL_SOURCE_ID) as GeoJSONSource | undefined)?.setData?.(labels);
}

/** Only the label layer: on every camera move the labels are re-placed, the outlines stay. */
export function pushSectorLabels(
  map: Map,
  grid: Grid,
  statuses: readonly SectorStatus[],
  currentId: string | null,
  hoverId: string | null,
  place?: PlaceLabel,
): void {
  const { labels } = sectorFeatures(grid, statuses, currentId, hoverId, place);
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

/** The replay trail: brighter while the drone flies, dimmer at rest so the search-next circles win. */
export const TRAIL_OPACITY = { playing: 0.5, rest: 0.28 } as const;
/** The photo being taken: its fill and outline at full strength (they fade to 0 when hidden). */
export const FOOTPRINT_OPACITY = { fill: 0.22, line: 0.9 } as const;
/** Fade time of the trail and the photo highlight (MapLibre paint transitions). */
export const EMPHASIS_FADE_MS = 320;

/**
 * Replay emphasis, faded by MapLibre's paint transitions (no per-frame calls): the trail brightens
 * while playing, and the photo highlight shows while the drone is mid-flight. `instant` (reduced
 * motion, a style reload) sets the values without a fade.
 */
export function setReplayEmphasis(map: Map, { playing, highlight }: { playing: boolean; highlight: boolean }, instant: boolean): void {
  const transition = { duration: instant ? 0 : EMPHASIS_FADE_MS, delay: 0 };
  type PaintName = Parameters<Map["setPaintProperty"]>[1];
  const set = (id: string, prop: string, value: number) => {
    if (!map.getLayer(id)) return;
    map.setPaintProperty(id, `${prop}-transition` as PaintName, transition);
    map.setPaintProperty(id, prop as PaintName, value);
  };
  set(HEAT_LAYER_IDS.trail, "line-opacity", playing ? TRAIL_OPACITY.playing : TRAIL_OPACITY.rest);
  set(HEAT_LAYER_IDS.droneFootprint, "fill-opacity", highlight ? FOOTPRINT_OPACITY.fill : 0);
  set(HEAT_LAYER_IDS.droneFootprintLine, "line-opacity", highlight ? FOOTPRINT_OPACITY.line : 0);
  // The circles move as the photos come in: quiet while the drone flies, full strength at rest.
  const k = playing ? HOTSPOT_STYLE.replayOpacity : 1;
  set(HEAT_LAYER_IDS.hotspotHalo, "circle-stroke-opacity", HOTSPOT_STYLE.casingOpacity * k);
  set(HEAT_LAYER_IDS.hotspotHalo, "circle-opacity", HOTSPOT_STYLE.fillOpacity * k);
  set(HEAT_LAYER_IDS.hotspots, "circle-stroke-opacity", k);
  set(HEAT_LAYER_IDS.hotspotActive, "circle-stroke-opacity", k);
  set(HEAT_LAYER_IDS.hotspotBadge, "icon-opacity", k);
  set(HEAT_LAYER_IDS.hotspotPatchOutline, "line-opacity", 0.8 * k);
  set(HEAT_LAYER_IDS.hotspotPatchActive, "line-opacity", k);
  if (map.getLayer(HEAT_LAYER_IDS.hotspotPulse)) {
    map.setLayoutProperty?.(HEAT_LAYER_IDS.hotspotPulse, "visibility", playing ? "none" : "visible");
  }
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
/** Radius of a search-next ring (to the middle of its stroke). */
export const HOTSPOT_RADIUS_PX = 12;
/** The badge sits on the ring, up and to the right (45°). */
export const HOTSPOT_BADGE_OFFSET_PX = Math.round(HOTSPOT_RADIUS_PX * Math.SQRT1_2);
/**
 * The ring is 2.5 px of near-white (--text) centred on a 7 px dark casing (--bg), so 2.25 px of dark
 * shows on each side: light-on-dark at the pale end of the heat, light on dark red at the other.
 * A faint dark fill lifts the ring off busy cells. While the drone flies, all of it drops to
 * replayOpacity.
 */
export const HOTSPOT_STYLE = { ringPx: 2.5, casingPx: 7, casingOpacity: 0.85, fillOpacity: 0.14, replayOpacity: 0.3 } as const;
/** The first circle's pulse: one ring grows from the circle and fades, every PULSE_MS. */
export const HOTSPOT_PULSE_MS = 2400;
export const HOTSPOT_PULSE_GROW_PX = 12;

/** 1 ± BREATH_AMPLITUDE, a sine of period BREATH_PERIOD_MS. */
export function breathFactor(tMs: number): number {
  return 1 + BREATH_AMPLITUDE * Math.sin((2 * Math.PI * tMs) / BREATH_PERIOD_MS);
}

/** Apply one breath to the surface's opacity (raster and fills). Cheap: no data-driven paint. */
export function setBreath(
  map: Map,
  factor: number,
  base: number = HEAT_BASE_OPACITY.search,
  palette: HeatPalette = HEAT_PALETTES.dark,
  theme: SurfaceTheme = { veil: "#0a0b0d", held: "#f2f2f0" },
): void {
  setSurfaceOpacity(map, HEAT_SURFACE_IDS, palette, theme, Math.min(1, base * factor));
}

/** The pulse ring at time tMs: radius and opacity, growing out of the circle and fading (eased out). */
export function hotspotPulseFrame(tMs: number): { radius: number; opacity: number } {
  const k = (((tMs % HOTSPOT_PULSE_MS) + HOTSPOT_PULSE_MS) % HOTSPOT_PULSE_MS) / HOTSPOT_PULSE_MS;
  const eased = 1 - (1 - k) ** 2;
  return { radius: HOTSPOT_RADIUS_PX + HOTSPOT_PULSE_GROW_PX * eased, opacity: 0.7 * (1 - k) };
}

/** One pulse frame on the first circle (null: no pulse, e.g. reduced motion). Safe before the layer exists. */
export function setHotspotPulse(map: Map, tMs: number | null): void {
  if (!map.getLayer(HEAT_LAYER_IDS.hotspotPulse)) return;
  const { radius, opacity } = tMs === null ? { radius: HOTSPOT_RADIUS_PX, opacity: 0 } : hotspotPulseFrame(tMs);
  map.setPaintProperty(HEAT_LAYER_IDS.hotspotPulse, "circle-radius", radius);
  map.setPaintProperty(HEAT_LAYER_IDS.hotspotPulse, "circle-stroke-opacity", opacity);
}

/** Highlight the marker and outline of patch `idx`; null clears them. */
export function setActiveHotspot(map: Map, idx: number | null): void {
  if (map.getLayer(HEAT_LAYER_IDS.hotspotActive)) {
    map.setFilter?.(HEAT_LAYER_IDS.hotspotActive, [
      "all",
      ["==", ["get", "kind"], "marker"],
      ["==", ["get", "idx"], idx ?? -1],
    ]);
  }
  if (map.getLayer(HEAT_LAYER_IDS.hotspotPatchActive)) {
    map.setFilter?.(HEAT_LAYER_IDS.hotspotPatchActive, [
      "all",
      ["==", ["get", "kind"], "outline"],
      ["==", ["get", "idx"], idx ?? -1],
    ]);
  }
}

/** The layers a pointer can hit on a search-next patch. */
export const HOTSPOT_HIT_LAYERS = [HEAT_LAYER_IDS.hotspotPatchOutline, HEAT_LAYER_IDS.hotspotHalo, HEAT_LAYER_IDS.hotspotBadge] as const;

/**
 * Lift lane B's last-known-point marker and label above the heat, the trail and the photo highlight
 * (they are added after lane B's layers), just under the search-next circles, so a circle at the
 * last known point still shows whole and the label moves off the badges. Safe in any state.
 */
export function raiseLkp(map: Map): void {
  const before = map.getLayer(HEAT_LAYER_IDS.hotspotHalo)
    ? HEAT_LAYER_IDS.hotspotHalo
    : map.getLayer(HEAT_LAYER_IDS.droneHalo)
      ? HEAT_LAYER_IDS.droneHalo
      : undefined;
  for (const id of [MAP_LAYER_IDS.lkp, MAP_LAYER_IDS.lkpLabel]) {
    if (map.getLayer(id)) map.moveLayer?.(id, before);
  }
}

/** Patch boundaries plus probability-weighted centroids for their numbered map markers. */
export function hotspotFeatures(grid: Grid, patches: readonly LikelyPatch[]): GeoJsonData {
  const features: Record<string, unknown>[] = [];
  const cellCount = grid.rows * grid.cols;
  patches.forEach((patch, rank) => {
    const mask = new Uint8Array(cellCount);
    for (const idx of patch.cells) if (idx >= 0 && idx < cellCount) mask[idx] = 1;
    features.push({
      type: "Feature",
      properties: { idx: patch.id, rank: rank + 1, kind: "outline" },
      geometry: { type: "MultiLineString", coordinates: surveyedBoundary(grid, mask) },
    });
    features.push({
      type: "Feature",
      properties: { idx: patch.id, rank: rank + 1, kind: "marker" },
      geometry: { type: "Point", coordinates: [patch.centroid.lon, patch.centroid.lat] },
    });
  });
  return {
    type: "FeatureCollection",
    features,
  };
}

/** Redraw the hotspot outlines. Safe before the source exists (does nothing). */
export function pushHotspots(map: Map, grid: Grid, patches: readonly LikelyPatch[]): void {
  (map.getSource(HEAT_HOTSPOT_SOURCE_ID) as GeoJSONSource | undefined)?.setData?.(hotspotFeatures(grid, patches));
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
