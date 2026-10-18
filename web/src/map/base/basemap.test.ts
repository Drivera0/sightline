import { describe, expect, it } from "vitest";
import {
  OFFLINE_BASEMAP_PATH,
  OFFLINE_GLYPHS_PATH,
  OFFLINE_SOURCE_ID,
  basemapStyle,
  chooseBasemapMode,
  mapTilerSatelliteStyle,
  offlineBasemapStyle,
  type BasemapColors,
} from "./basemap";

const colors: BasemapColors = {
  background: "black",
  surface: "gray",
  surfaceStrong: "darkgray",
  border: "silver",
  textSecondary: "white",
};

describe("chooseBasemapMode", () => {
  it("uses satellite only with a non-empty key and network connection", () => {
    expect(chooseBasemapMode("secret", true)).toBe("satellite");
    expect(chooseBasemapMode("", true)).toBe("offline");
    expect(chooseBasemapMode("   ", true)).toBe("offline");
    expect(chooseBasemapMode("secret", false)).toBe("offline");
  });
});

describe("basemap styles", () => {
  it("adds the MapTiler key as an encoded query parameter", () => {
    const url = new URL(mapTilerSatelliteStyle("key with + symbols"));
    expect(url.pathname).toBe("/maps/satellite-v4/style.json");
    expect(url.searchParams.get("key")).toBe("key with + symbols");
  });

  it("builds an attributed PMTiles style with local glyphs", () => {
    const style = offlineBasemapStyle(colors);
    const source = style.sources[OFFLINE_SOURCE_ID];

    if (!source) throw new Error("Offline basemap source is missing");
    expect(style.glyphs).toBe(OFFLINE_GLYPHS_PATH);
    expect(source).toMatchObject({
      type: "vector",
      url: `pmtiles://${OFFLINE_BASEMAP_PATH}`,
    });
    expect("attribution" in source ? source.attribution : "").toContain("OpenStreetMap");
    expect(style.layers.map((layer) => layer.id)).toEqual([
      "basemap-background",
      "basemap-earth",
      "basemap-landcover",
      "basemap-landuse",
      "basemap-water",
      "basemap-buildings",
      "basemap-roads",
    ]);
  });

  it("falls back to offline when satellite mode has no key", () => {
    expect(basemapStyle("satellite", undefined, colors)).toEqual(offlineBasemapStyle(colors));
  });
});
