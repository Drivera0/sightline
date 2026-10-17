import { describe, expect, it } from "vitest";
import type { Detections, MapFile, Survey } from "../../contract";
import type { LayerSpecification, Map as MapLibreMap } from "maplibre-gl";
import { syncBaseLayers } from "./layers";
import { MAP_LAYER_IDS } from "./layerIds";

const survey: Survey = {
  contract_version: "1.0",
  survey_id: "test",
  simulated_path: true,
  frames: [],
  area: { name: "Test", lkp: { lat: 49.37, lon: -122.945 } },
};

const detections: Detections = {
  contract_version: "1.0",
  model: "test",
  save_threshold: 0.05,
  candidate_threshold: 0.25,
  frames: {},
};

const mapFile = {
  grid: {
    origin_nw: { lat: 49.374492, lon: -122.951898 },
    cell_m: 20,
    rows: 50,
    cols: 50,
  },
} as Pick<MapFile, "grid">;

const colors = {
  accent: "accent",
  accentSoft: "accent-soft",
  background: "background",
  text: "text",
  textSecondary: "text-secondary",
  warning: "warning",
};

// Provide the source/layer methods used by the pure MapLibre installer.
function mapRecorder(): {
  map: MapLibreMap;
  layers: LayerSpecification[];
} {
  const sources = new globalThis.Map<string, { setData: (data: unknown) => void }>();
  const layers: LayerSpecification[] = [];
  const map = {
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, _source: unknown) => {
      sources.set(id, { setData: (_data: unknown) => undefined });
    },
    getLayer: (id: string) => layers.find((layer) => layer.id === id),
    addLayer: (layer: LayerSpecification) => {
      layers.push(layer);
    },
  } as unknown as MapLibreMap;
  return { map, layers };
}

describe("review-aware detection layers", () => {
  it("installs person fill, state outlines, rejected dashes and review labels", () => {
    const { map, layers } = mapRecorder();

    syncBaseLayers(map, { survey, detections, map: mapFile }, {}, colors);

    expect(layers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: MAP_LAYER_IDS.pins,
          paint: expect.objectContaining({
            "fill-opacity": ["case", ["==", ["get", "reviewState"], "person"], 0.65, 0],
          }),
        }),
        expect.objectContaining({
          id: MAP_LAYER_IDS.pinOutlines,
          filter: ["!=", ["get", "reviewState"], "not_person"],
        }),
        expect.objectContaining({
          id: MAP_LAYER_IDS.rejectedPins,
          filter: ["==", ["get", "reviewState"], "not_person"],
          paint: expect.objectContaining({ "line-dasharray": [2, 2] }),
        }),
        expect.objectContaining({
          id: MAP_LAYER_IDS.pinLabels,
          layout: expect.objectContaining({ "text-field": ["get", "reviewLabel"] }),
        }),
      ]),
    );
  });

  it("installs grid, direction and LKP label layers in display order", () => {
    const { map, layers } = mapRecorder();

    syncBaseLayers(map, { survey, detections, map: mapFile }, {}, colors);

    expect(layers.map((layer) => layer.id)).toEqual([
      MAP_LAYER_IDS.gridOutline,
      MAP_LAYER_IDS.footprints,
      MAP_LAYER_IDS.selectedFootprint,
      MAP_LAYER_IDS.flightPath,
      MAP_LAYER_IDS.flightDirection,
      MAP_LAYER_IDS.pins,
      MAP_LAYER_IDS.pinOutlines,
      MAP_LAYER_IDS.rejectedPins,
      MAP_LAYER_IDS.pinLabels,
      MAP_LAYER_IDS.lkp,
      MAP_LAYER_IDS.lkpLabel,
    ]);
    expect(layers.find((layer) => layer.id === MAP_LAYER_IDS.lkpLabel)).toMatchObject({
      type: "symbol",
      layout: { "text-field": ["get", "label"] },
    });
  });
});
