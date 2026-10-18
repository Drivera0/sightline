import type { CacheBundle } from "../../contract";
import type { Answer } from "../../review/store";
import type { GeoJSONSource, Map } from "maplibre-gl";
import {
  buildDetectionFeatures,
  buildPinMarkerFeatures,
  buildFlightDirectionFeatures,
  buildFlightPathFeature,
  buildFootprintFeatures,
  buildGridOutlineFeature,
  buildLkpFeature,
} from "./features";
import { MAP_LAYER_IDS, MAP_SOURCE_IDS } from "./layerIds";
import { ensurePinImages, PIN_IMAGES } from "./pinImages";

interface MapColors {
  accent: string;
  accentSoft: string;
  background: string;
  text: string;
  textSecondary: string;
  warning: string;
}

type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];

/** Chevrons hide at and above this zoom; the 1 km grid fits at about zoom 15 on a laptop screen. */
export const FLIGHT_DIRECTION_MAX_ZOOM = 14.5;

// Read the shared design tokens because MapLibre canvas paint cannot resolve CSS variables.
export function readMapColors(root: Element = document.documentElement): MapColors {
  const styles = getComputedStyle(root);
  return {
    accent: styles.getPropertyValue("--accent").trim(),
    accentSoft: styles.getPropertyValue("--accent-soft").trim(),
    background: styles.getPropertyValue("--bg").trim(),
    text: styles.getPropertyValue("--text").trim(),
    textSecondary: styles.getPropertyValue("--text-2").trim(),
    warning: styles.getPropertyValue("--warn").trim(),
  };
}

// Refresh detection geometry with the latest browser-only review answers.
export function syncDetectionSource(
  map: Map,
  bundle: Pick<CacheBundle, "detections">,
  answers: Readonly<Record<string, Answer>>,
): void {
  const source = (id: string) => map.getSource(id) as GeoJSONSource | undefined;
  source(MAP_SOURCE_IDS.pins)?.setData(buildDetectionFeatures(bundle.detections, answers));
  source(MAP_SOURCE_IDS.pinMarkers)?.setData(buildPinMarkerFeatures(bundle.detections, answers));
}

// Replace an existing GeoJSON source or add it on the first render.
function setGeoJsonSource(map: Map, id: string, data: GeoJsonData): void {
  const source = map.getSource(id) as GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
    return;
  }
  map.addSource(id, { type: "geojson", data });
}

// Install or refresh all Lane B sources and their deterministic base layers.
export function syncBaseLayers(
  map: Map,
  bundle: Pick<CacheBundle, "survey" | "detections"> & {
    map: Pick<CacheBundle["map"], "grid">;
  },
  answers: Readonly<Record<string, Answer>> = {},
  colors = readMapColors(),
): void {
  setGeoJsonSource(map, MAP_SOURCE_IDS.grid, buildGridOutlineFeature(bundle.map.grid));
  setGeoJsonSource(map, MAP_SOURCE_IDS.footprints, buildFootprintFeatures(bundle.survey));
  setGeoJsonSource(map, MAP_SOURCE_IDS.flightPath, buildFlightPathFeature(bundle.survey));
  setGeoJsonSource(
    map,
    MAP_SOURCE_IDS.flightDirection,
    buildFlightDirectionFeatures(bundle.survey),
  );
  setGeoJsonSource(map, MAP_SOURCE_IDS.pins, buildDetectionFeatures(bundle.detections, answers));
  setGeoJsonSource(map, MAP_SOURCE_IDS.pinMarkers, buildPinMarkerFeatures(bundle.detections, answers));
  ensurePinImages(map, colors);
  setGeoJsonSource(map, MAP_SOURCE_IDS.lkp, buildLkpFeature(bundle.survey));

  if (!map.getLayer(MAP_LAYER_IDS.gridOutline)) {
    map.addLayer({
      id: MAP_LAYER_IDS.gridOutline,
      type: "line",
      source: MAP_SOURCE_IDS.grid,
      paint: {
        "line-color": colors.textSecondary,
        "line-opacity": 0.45,
        "line-width": 1,
      },
    });
  }
  if (!map.getLayer(MAP_LAYER_IDS.footprints)) {
    map.addLayer({
      id: MAP_LAYER_IDS.footprints,
      type: "line",
      source: MAP_SOURCE_IDS.footprints,
      layout: { visibility: "none" },
      paint: { "line-color": colors.textSecondary, "line-opacity": 0.35, "line-width": 1 },
    });
  }
  if (!map.getLayer(MAP_LAYER_IDS.flightPath)) {
    map.addLayer({
      id: MAP_LAYER_IDS.flightPath,
      type: "line",
      source: MAP_SOURCE_IDS.flightPath,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": colors.text,
        "line-opacity": 0.1,
        "line-width": 1,
      },
    });
  }
  if (!map.getLayer(MAP_LAYER_IDS.flightDirection)) {
    // Direction chevrons only when zoomed out beyond the whole grid (they clutter the cells at
    // survey zoom); the replay's moving drone shows direction up close.
    map.addLayer({
      id: MAP_LAYER_IDS.flightDirection,
      type: "line",
      source: MAP_SOURCE_IDS.flightDirection,
      maxzoom: FLIGHT_DIRECTION_MAX_ZOOM,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": colors.text,
        "line-opacity": 0.35,
        "line-width": 1.25,
      },
    });
  }
  // The 10 m circle: a light tint so the photo spot stays readable, the state shown by its line.
  if (!map.getLayer(MAP_LAYER_IDS.pins)) {
    map.addLayer({
      id: MAP_LAYER_IDS.pins,
      type: "fill",
      source: MAP_SOURCE_IDS.pins,
      paint: {
        "fill-color": ["match", ["get", "reviewState"], "unsure", colors.warning, colors.accent],
        "fill-opacity": [
          "match",
          ["get", "reviewState"],
          "person",
          0.3,
          "unsure",
          0.12,
          "unreviewed",
          0.06,
          0,
        ],
      },
    });
  }
  if (!map.getLayer(MAP_LAYER_IDS.pinOutlines)) {
    map.addLayer({
      id: MAP_LAYER_IDS.pinOutlines,
      type: "line",
      source: MAP_SOURCE_IDS.pins,
      filter: ["!=", ["get", "reviewState"], "not_person"],
      paint: {
        "line-color": ["match", ["get", "reviewState"], "unsure", colors.warning, colors.accent],
        "line-opacity": ["match", ["get", "reviewState"], "unreviewed", 0.8, 1],
        "line-width": ["match", ["get", "reviewState"], "person", 2.5, "unsure", 2, 1.5],
      },
    });
  }
  if (!map.getLayer(MAP_LAYER_IDS.rejectedPins)) {
    map.addLayer({
      id: MAP_LAYER_IDS.rejectedPins,
      type: "line",
      source: MAP_SOURCE_IDS.pins,
      filter: ["==", ["get", "reviewState"], "not_person"],
      paint: {
        "line-color": colors.textSecondary,
        "line-opacity": 0.55,
        "line-width": 1.25,
        "line-dasharray": [2, 2],
      },
    });
  }
  // The selected candidate: a double ring around its own circle, not a second shape (the photo
  // footprint rectangle used to draw here too, which read as two markers for one find).
  if (!map.getLayer(MAP_LAYER_IDS.selectedPin)) {
    map.addLayer({
      id: MAP_LAYER_IDS.selectedPin,
      type: "line",
      source: MAP_SOURCE_IDS.pins,
      filter: ["==", ["get", "detectionId"], ""],
      paint: {
        "line-color": colors.text,
        "line-opacity": 0.95,
        "line-width": 1.5,
        "line-gap-width": 3,
      },
    });
  }
  // The state icon at each candidate's centre: shape and icon differ, not only colour.
  if (!map.getLayer(MAP_LAYER_IDS.pinMarkers)) {
    map.addLayer({
      id: MAP_LAYER_IDS.pinMarkers,
      type: "symbol",
      source: MAP_SOURCE_IDS.pinMarkers,
      layout: {
        "icon-image": [
          "match",
          ["get", "reviewState"],
          "person",
          PIN_IMAGES.person,
          "unsure",
          PIN_IMAGES.unsure,
          "not_person",
          PIN_IMAGES.notPerson,
          PIN_IMAGES.unreviewed,
        ],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "symbol-sort-key": ["match", ["get", "reviewState"], "person", 3, "unsure", 2, "unreviewed", 1, 0],
      },
    });
  }
  // A label chip beside the icon, only for answers a searcher acts on. It moves above, below or
  // to either side, whichever is free, so a nearby label never hides it.
  if (!map.getLayer(MAP_LAYER_IDS.pinLabels)) {
    map.addLayer({
      id: MAP_LAYER_IDS.pinLabels,
      type: "symbol",
      source: MAP_SOURCE_IDS.pinMarkers,
      filter: ["!=", ["get", "reviewLabel"], ""],
      minzoom: 14,
      layout: {
        "text-field": ["get", "reviewLabel"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 11.5,
        "text-letter-spacing": 0.02,
        "text-variable-anchor": ["bottom", "top", "left", "right"],
        "text-radial-offset": 1.35,
        "icon-image": ["match", ["get", "reviewState"], "unsure", PIN_IMAGES.chipUnsure, PIN_IMAGES.chipPerson],
        "icon-text-fit": "both",
        "icon-text-fit-padding": [3, 9, 3, 9],
        "symbol-sort-key": ["get", "labelRank"],
        "text-allow-overlap": false,
        "icon-allow-overlap": false,
      },
      paint: {
        "text-color": ["match", ["get", "reviewState"], "unsure", colors.warning, colors.text],
      },
    });
  }
  if (!map.getLayer(MAP_LAYER_IDS.lkp)) {
    map.addLayer({
      id: MAP_LAYER_IDS.lkp,
      type: "circle",
      source: MAP_SOURCE_IDS.lkp,
      paint: {
        "circle-color": colors.text,
        "circle-radius": 7,
        "circle-stroke-color": colors.accent,
        "circle-stroke-width": 3,
      },
    });
  }
  if (!map.getLayer(MAP_LAYER_IDS.lkpLabel)) {
    map.addLayer({
      id: MAP_LAYER_IDS.lkpLabel,
      type: "symbol",
      source: MAP_SOURCE_IDS.lkp,
      layout: {
        "text-field": ["get", "label"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 13,
        "text-offset": [0, 1.4],
        "text-anchor": "top",
        "text-allow-overlap": true,
      },
      paint: {
        "text-color": colors.text,
        "text-halo-color": colors.background,
        "text-halo-width": 2,
      },
    });
  }
}

// Ring the candidate selected in the review queue or by a click on its pin.
export function setSelectedPin(map: Map, detectionId: string | null): void {
  if (!map.getLayer(MAP_LAYER_IDS.selectedPin)) return;
  map.setFilter(MAP_LAYER_IDS.selectedPin, ["==", ["get", "detectionId"], detectionId ?? ""]);
}
