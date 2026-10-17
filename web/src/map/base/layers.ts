import type { CacheBundle } from "../../contract";
import type { GeoJSONSource, Map } from "maplibre-gl";
import {
  buildDetectionFeatures,
  buildFlightPathFeature,
  buildFootprintFeatures,
  buildLkpFeature,
} from "./features";
import { MAP_LAYER_IDS, MAP_SOURCE_IDS } from "./layerIds";

interface MapColors {
  accent: string;
  accentSoft: string;
  text: string;
  textSecondary: string;
}

type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];

// Read the shared design tokens because MapLibre canvas paint cannot resolve CSS variables.
export function readMapColors(root: Element = document.documentElement): MapColors {
  const styles = getComputedStyle(root);
  return {
    accent: styles.getPropertyValue("--accent").trim(),
    accentSoft: styles.getPropertyValue("--accent-soft").trim(),
    text: styles.getPropertyValue("--text").trim(),
    textSecondary: styles.getPropertyValue("--text-2").trim(),
  };
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
export function syncBaseLayers(map: Map, bundle: CacheBundle, colors = readMapColors()): void {
  setGeoJsonSource(map, MAP_SOURCE_IDS.footprints, buildFootprintFeatures(bundle.survey));
  setGeoJsonSource(map, MAP_SOURCE_IDS.flightPath, buildFlightPathFeature(bundle.survey));
  setGeoJsonSource(map, MAP_SOURCE_IDS.pins, buildDetectionFeatures(bundle.detections));
  setGeoJsonSource(map, MAP_SOURCE_IDS.lkp, buildLkpFeature(bundle.survey));

  if (!map.getLayer(MAP_LAYER_IDS.footprints)) {
    map.addLayer({
      id: MAP_LAYER_IDS.footprints,
      type: "line",
      source: MAP_SOURCE_IDS.footprints,
      paint: { "line-color": colors.textSecondary, "line-opacity": 0.35, "line-width": 1 },
    });
  }
  if (!map.getLayer(MAP_LAYER_IDS.selectedFootprint)) {
    map.addLayer({
      id: MAP_LAYER_IDS.selectedFootprint,
      type: "line",
      source: MAP_SOURCE_IDS.footprints,
      filter: ["==", ["get", "frameId"], ""],
      paint: { "line-color": colors.accent, "line-opacity": 0.95, "line-width": 3 },
    });
  }
  if (!map.getLayer(MAP_LAYER_IDS.flightPath)) {
    map.addLayer({
      id: MAP_LAYER_IDS.flightPath,
      type: "line",
      source: MAP_SOURCE_IDS.flightPath,
      paint: {
        "line-color": colors.accentSoft,
        "line-opacity": 0.8,
        "line-width": 2,
        "line-dasharray": [2, 2],
      },
    });
  }
  if (!map.getLayer(MAP_LAYER_IDS.pins)) {
    map.addLayer({
      id: MAP_LAYER_IDS.pins,
      type: "fill",
      source: MAP_SOURCE_IDS.pins,
      paint: {
        "fill-color": colors.accent,
        "fill-opacity": 0.45,
        "fill-outline-color": colors.text,
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
}

// Highlight the footprint associated with the shared review/map selection.
export function setSelectedFootprint(map: Map, frameId: string | null): void {
  if (!map.getLayer(MAP_LAYER_IDS.selectedFootprint)) return;
  map.setFilter(MAP_LAYER_IDS.selectedFootprint, ["==", ["get", "frameId"], frameId ?? ""]);
}
