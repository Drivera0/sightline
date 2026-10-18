/** Stable IDs shared with Lane C for deterministic MapLibre layer ordering. */
export const HEAT_LAYER_PREFIX = "heat-";

export const MAP_LAYER_IDS = {
  gridOutline: "grid-outline",
  footprints: "footprints",
  flightPath: "flight-path",
  flightDirection: "flight-direction",
  pins: "detection-pins",
  pinOutlines: "detection-pin-outlines",
  rejectedPins: "rejected-detection-pins",
  selectedPin: "selected-detection-pin",
  pinMarkers: "detection-pin-markers",
  pinLabels: "detection-pin-labels",
  lkp: "last-known-point",
  lkpLabel: "last-known-point-label",
} as const;

export const MAP_SOURCE_IDS = {
  grid: "search-grid",
  footprints: "survey-footprints",
  flightPath: "survey-flight-path",
  flightDirection: "survey-flight-direction",
  pins: "candidate-detections",
  pinMarkers: "candidate-detection-markers",
  lkp: "survey-lkp",
} as const;

export const MAP_LAYER_ORDER = [
  MAP_LAYER_IDS.gridOutline,
  MAP_LAYER_IDS.footprints,
  MAP_LAYER_IDS.flightPath,
  MAP_LAYER_IDS.flightDirection,
  MAP_LAYER_IDS.pins,
  MAP_LAYER_IDS.pinOutlines,
  MAP_LAYER_IDS.rejectedPins,
  MAP_LAYER_IDS.selectedPin,
  MAP_LAYER_IDS.pinMarkers,
  MAP_LAYER_IDS.pinLabels,
  MAP_LAYER_IDS.lkp,
  MAP_LAYER_IDS.lkpLabel,
] as const;
