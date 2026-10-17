export const MAPTILER_KEY_ENV = "VITE_MAPTILER_KEY";
export const OFFLINE_BASEMAP_PATH = "/basemap/northshore.pmtiles";

export type BasemapMode = "satellite" | "offline";

// Prefer satellite tiles only when both credentials and connectivity exist.
export function chooseBasemapMode(
  mapTilerKey: string | undefined,
  online: boolean,
): BasemapMode {
  return mapTilerKey && online ? "satellite" : "offline";
}
