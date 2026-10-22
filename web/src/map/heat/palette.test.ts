import { describe, expect, it, vi } from "vitest";
import type { Map } from "maplibre-gl";
import { offlineBasemapStyle } from "../base/basemap";
import { CELL } from "./classes";
import {
  basemapKind,
  basemapLabelLayer,
  HEAT_PALETTES,
  HELD_ALPHA,
  IMAGERY_MUTE,
  imageryLayers,
  kindFill,
  muteImagery,
  VEIL_ALPHA,
  zoomFade,
  ZOOM_FADE,
  zoomOpacity,
} from "./palette";

type Layer = { id: string; type: string; source?: string; paint: Record<string, unknown> };

/** A map with these layers on these sources, recording paint changes like MapLibre does. */
function styledMap(layers: Layer[], sources: Record<string, string>) {
  const setPaintProperty = vi.fn((id: string, prop: string, value: unknown) => {
    const layer = layers.find((l) => l.id === id)!;
    if (value === undefined) delete layer.paint[prop];
    else layer.paint[prop] = value;
  });
  const map = {
    getLayersOrder: () => layers.map((l) => l.id),
    getLayer: (id: string) => layers.find((l) => l.id === id),
    getSource: (id: string) => (sources[id] ? { type: sources[id] } : undefined),
    getPaintProperty: (id: string, prop: string) => layers.find((l) => l.id === id)?.paint[prop],
    setPaintProperty,
  } as unknown as Map;
  return { map, layers, setPaintProperty };
}

/** Roughly MapTiler Satellite: imagery, then vector roads and labels on top. */
const satellite = () =>
  styledMap(
    [
      { id: "Satellite", type: "raster", source: "satellite", paint: { "raster-saturation": 0.1 } },
      { id: "Road network", type: "line", source: "maptiler_planet", paint: {} },
      { id: "Place labels", type: "symbol", source: "maptiler_planet", paint: {} },
      // Our own canvas raster must never count as imagery.
      { id: "heat-cells", type: "raster", source: "heat-cells", paint: {} },
    ],
    { satellite: "raster", maptiler_planet: "vector", "heat-cells": "canvas" },
  );

/** The bundled offline style, as MapLibre would report it. */
const offline = () => {
  const style = offlineBasemapStyle({ background: "#000", surface: "#111", surfaceStrong: "#222", border: "#333", textSecondary: "#999" });
  return styledMap(
    style.layers.map((l) => ({ id: l.id, type: l.type, source: "source" in l ? (l.source as string) : undefined, paint: {} })),
    Object.fromEntries(Object.entries(style.sources).map(([id, s]) => [id, s.type])),
  );
};

describe("palette by basemap", () => {
  it("picks the satellite palette over imagery and the dark one over the offline vector map", () => {
    expect(basemapKind(satellite().map)).toBe("satellite");
    expect(imageryLayers(satellite().map)).toEqual(["Satellite"]);
    expect(basemapKind(offline().map)).toBe("dark");
    // No style yet (or a test double): the dark palette, the offline default.
    expect(basemapKind({} as Map)).toBe("dark");
    expect(basemapKind({ getLayersOrder: () => { throw new Error("no style"); } } as unknown as Map)).toBe("dark");
  });

  it("satellite: the YlOrRd subset, denser for likelier; dark: magma's upper range, lighter for likelier", () => {
    const s = HEAT_PALETTES.satellite;
    expect([s.low.color, s.mid.color, s.top.color]).toEqual(["#fed976", "#fd8d3c", "#e31a1c"]);
    expect([s.low.alpha, s.mid.alpha, s.top.alpha]).toEqual([0.3, 0.45, 0.6]);
    expect(s.contour50.color).toBe("#bd0026");
    const d = HEAT_PALETTES.dark;
    expect([d.low.color, d.mid.color, d.top.color]).toEqual(["#8c2981", "#de4968", "#fe9f6d"]);
    // Alpha one step (+0.1) above the satellite classes on the dark ground.
    for (const k of ["low", "mid", "top"] as const) expect(d[k].alpha).toBeCloseTo(s[k].alpha + 0.1, 9);
    expect(d.contour50.color).toBe("#fcfdbf");
    // The 90 % edge is dashed, the 50 % edge solid, on both.
    for (const p of [s, d]) {
      expect(p.contour90.dash).toBeDefined();
      expect(p.contour50.dash).toBeUndefined();
    }
  });

  it("fills each cell kind: the classes, the veil and the held tone; nothing outside the 90 % region", () => {
    const theme = { veil: "#000000", held: "#ffffff" };
    const p = HEAT_PALETTES.dark;
    expect(kindFill(p, CELL.top, theme)).toBe(p.top);
    expect(kindFill(p, CELL.none, theme)).toBeNull();
    expect(kindFill(p, CELL.veil, theme)).toEqual({ color: "#000000", alpha: VEIL_ALPHA });
    expect(kindFill(p, CELL.held, theme)).toEqual({ color: "#ffffff", alpha: HELD_ALPHA });
  });
});

describe("opacity by zoom", () => {
  it("keeps full strength to z13 and fades the fills to 0.55 of it by z16", () => {
    expect(zoomFade(10)).toBe(1);
    expect(zoomFade(13)).toBe(1);
    expect(zoomFade(14.5)).toBeCloseTo(1 - 0.45 / 2, 9);
    expect(zoomFade(16)).toBeCloseTo(ZOOM_FADE.to, 9);
    expect(zoomFade(20)).toBeCloseTo(0.55, 9);
    expect(zoomOpacity(0.6)).toEqual(["interpolate", ["linear"], ["zoom"], 13, 0.6, 16, 0.6 * 0.55]);
    expect(zoomOpacity(1.4)[4]).toBe(1);
  });
});

describe("the basemap under the heat", () => {
  it("puts the heat under the first road or label of the basemap", () => {
    expect(basemapLabelLayer(satellite().map)).toBe("Road network");
    expect(basemapLabelLayer(offline().map)).toBe("basemap-roads");
    expect(basemapLabelLayer({} as Map)).toBeUndefined();
  });

  it("mutes the imagery while the heat is shown and puts back what the style had", () => {
    const { map, layers } = satellite();
    const imagery = layers[0]!;
    muteImagery(map, true);
    expect(imagery.paint["raster-saturation"]).toBe(IMAGERY_MUTE["raster-saturation"]);
    expect(imagery.paint["raster-brightness-max"]).toBe(IMAGERY_MUTE["raster-brightness-max"]);
    // Muting again (every styledata) keeps the style's own values to restore.
    muteImagery(map, true);
    muteImagery(map, false);
    expect(imagery.paint["raster-saturation"]).toBe(0.1);
    expect("raster-brightness-max" in imagery.paint).toBe(false);
    // Our canvas raster is never touched.
    expect(layers[3]!.paint).toEqual({});
  });

  it("does nothing on the offline map (no imagery)", () => {
    const { map, setPaintProperty } = offline();
    muteImagery(map, true);
    muteImagery(map, false);
    expect(setPaintProperty).not.toHaveBeenCalled();
  });
});
