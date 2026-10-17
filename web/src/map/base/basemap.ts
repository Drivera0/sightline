import { addProtocol, type StyleSpecification } from "maplibre-gl";
import { Protocol } from "pmtiles";

export const MAPTILER_KEY_ENV = "VITE_MAPTILER_KEY";
export const MAPTILER_SATELLITE_STYLE =
  "https://api.maptiler.com/maps/satellite-v4/style.json";
export const OFFLINE_BASEMAP_PATH = "/basemap/northshore.pmtiles";
export const OFFLINE_GLYPHS_PATH = "/basemap/fonts/{fontstack}/{range}.pbf";
export const OFFLINE_SOURCE_ID = "offline-basemap";

const OFFLINE_ATTRIBUTION =
  '<a href="https://protomaps.com">Protomaps</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

let pmtilesProtocol: Protocol | null = null;

export type BasemapMode = "satellite" | "offline";

export interface BasemapColors {
  background: string;
  surface: string;
  surfaceStrong: string;
  border: string;
  textSecondary: string;
}

// Prefer satellite tiles only when both credentials and connectivity exist.
export function chooseBasemapMode(
  mapTilerKey: string | undefined,
  online: boolean,
): BasemapMode {
  return mapTilerKey?.trim() && online ? "satellite" : "offline";
}

// Build the authenticated MapTiler style URL without storing credentials in source code.
export function mapTilerSatelliteStyle(mapTilerKey: string): string {
  const url = new URL(MAPTILER_SATELLITE_STYLE);
  url.searchParams.set("key", mapTilerKey);
  return url.toString();
}

// Read shared theme tokens for MapLibre, whose canvas cannot resolve CSS variables itself.
export function readBasemapColors(root: Element = document.documentElement): BasemapColors {
  const styles = getComputedStyle(root);
  return {
    background: styles.getPropertyValue("--bg").trim(),
    surface: styles.getPropertyValue("--surface").trim(),
    surfaceStrong: styles.getPropertyValue("--surface-strong").trim(),
    border: styles.getPropertyValue("--border").trim(),
    textSecondary: styles.getPropertyValue("--text-2").trim(),
  };
}

// Create a compact, label-ready vector style backed only by the bundled North Shore archive.
export function offlineBasemapStyle(colors: BasemapColors): StyleSpecification {
  return {
    version: 8,
    glyphs: OFFLINE_GLYPHS_PATH,
    sources: {
      [OFFLINE_SOURCE_ID]: {
        type: "vector",
        url: `pmtiles://${OFFLINE_BASEMAP_PATH}`,
        attribution: OFFLINE_ATTRIBUTION,
      },
    },
    layers: [
      {
        id: "basemap-background",
        type: "background",
        paint: { "background-color": colors.background },
      },
      {
        id: "basemap-earth",
        type: "fill",
        source: OFFLINE_SOURCE_ID,
        "source-layer": "earth",
        paint: { "fill-color": colors.surfaceStrong },
      },
      {
        id: "basemap-landcover",
        type: "fill",
        source: OFFLINE_SOURCE_ID,
        "source-layer": "landcover",
        paint: { "fill-color": colors.surface, "fill-opacity": 0.8 },
      },
      {
        id: "basemap-landuse",
        type: "fill",
        source: OFFLINE_SOURCE_ID,
        "source-layer": "landuse",
        paint: { "fill-color": colors.surfaceStrong, "fill-opacity": 0.8 },
      },
      {
        id: "basemap-water",
        type: "fill",
        source: OFFLINE_SOURCE_ID,
        "source-layer": "water",
        paint: { "fill-color": colors.textSecondary, "fill-opacity": 0.3 },
      },
      {
        id: "basemap-buildings",
        type: "fill",
        source: OFFLINE_SOURCE_ID,
        "source-layer": "buildings",
        paint: { "fill-color": colors.border, "fill-opacity": 0.75 },
      },
      {
        id: "basemap-roads",
        type: "line",
        source: OFFLINE_SOURCE_ID,
        "source-layer": "roads",
        paint: {
          "line-color": colors.textSecondary,
          "line-opacity": 0.55,
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.4, 15, 2],
        },
      },
    ],
  };
}

// Return the selected style while keeping online and offline configuration in one place.
export function basemapStyle(
  mode: BasemapMode,
  mapTilerKey: string | undefined,
  colors: BasemapColors,
): string | StyleSpecification {
  if (mode === "satellite" && mapTilerKey?.trim()) {
    return mapTilerSatelliteStyle(mapTilerKey.trim());
  }
  return offlineBasemapStyle(colors);
}

// Register PMTiles once for the browser lifetime before MapLibre creates an offline source.
export function ensurePmtilesProtocol(): void {
  if (pmtilesProtocol) return;
  pmtilesProtocol = new Protocol();
  addProtocol("pmtiles", pmtilesProtocol.tile);
}
