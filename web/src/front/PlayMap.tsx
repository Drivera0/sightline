// Open play's map (#play): the surveyed search area outlined with its 16 sectors, the staging points, base
// camp and the last known point, on the North Shore basemap the site ships. A click inside the area (or
// just outside it: the point snaps in) places the last known point; a click on a staging point makes it
// base camp. Loaded on its own (MapLibre is large; the checklist works without it). Built by lane A.
import { useEffect, useMemo, useRef } from "react";
import type { GeoJSONSource, Map as MlMap, MapMouseEvent } from "maplibre-gl";
import { basemapStyle, chooseBasemapMode, readBasemapColors } from "../map/base/basemap";
import { MapProvider, useMap } from "../map/MapView";
import { AREA_BOUNDS, sectorRings, STAGING, type LatLon } from "../command/openPlay";

const FONT = ["Noto Sans Regular"];
type FC = Extract<Parameters<GeoJSONSource["setData"]>[0], { type: "FeatureCollection" }>;
const SRC = { area: "play-area", camps: "play-camps", lkp: "play-lkp" } as const;
/** How near a click has to be to a staging point to choose it (px). */
const CAMP_HIT_PX = 18;

const token = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

function areaData(): FC {
  const { north, south, west, east } = AREA_BOUNDS;
  return {
    type: "FeatureCollection",
    features: [
      ...sectorRings().map((s) => ({ type: "Feature" as const, properties: { kind: "sector", id: s.id }, geometry: { type: "Polygon" as const, coordinates: [s.ring] } })),
      { type: "Feature", properties: { kind: "area" }, geometry: { type: "Polygon", coordinates: [[[west, north], [east, north], [east, south], [west, south], [west, north]]] } },
    ],
  };
}

function campData(camp: string | null): FC {
  return { type: "FeatureCollection", features: STAGING.map((s) => ({ type: "Feature", properties: { name: s.name, chosen: s.name === camp ? 1 : 0 }, geometry: { type: "Point", coordinates: [s.lon, s.lat] } })) };
}

function lkpData(lkp: LatLon | null): FC {
  return { type: "FeatureCollection", features: lkp ? [{ type: "Feature", properties: { label: "Last known point" }, geometry: { type: "Point", coordinates: [lkp.lon, lkp.lat] } }] : [] };
}

function install(map: MlMap, camp: string | null, lkp: LatLon | null): void {
  if (map.getSource(SRC.area)) return;
  const accent = token("--accent", "#ff7a1a");
  const text = token("--text", "#f2f2f0");
  const text2 = token("--text-2", "#a1a1aa");
  const bg = token("--bg", "#0a0b0d");
  const team = token("--team", "#6ea8fe");
  map.addSource(SRC.area, { type: "geojson", data: areaData() });
  map.addLayer({ id: "play-sector-fill", type: "fill", source: SRC.area, filter: ["==", ["get", "kind"], "sector"], paint: { "fill-color": accent, "fill-opacity": 0.06 } });
  map.addLayer({ id: "play-sector-line", type: "line", source: SRC.area, filter: ["==", ["get", "kind"], "sector"], paint: { "line-color": text2, "line-width": 1, "line-opacity": 0.55 } });
  map.addLayer({ id: "play-area-line", type: "line", source: SRC.area, filter: ["==", ["get", "kind"], "area"], paint: { "line-color": accent, "line-width": 2.5 } });
  map.addLayer({
    id: "play-sector-label",
    type: "symbol",
    source: SRC.area,
    filter: ["==", ["get", "kind"], "sector"],
    layout: { "text-field": ["get", "id"], "text-font": FONT, "text-size": 12, "symbol-placement": "point" },
    paint: { "text-color": text2, "text-halo-color": bg, "text-halo-width": 1.2 },
  });
  map.addSource(SRC.camps, { type: "geojson", data: campData(camp) });
  map.addLayer({
    id: "play-camp",
    type: "circle",
    source: SRC.camps,
    paint: { "circle-radius": ["case", ["==", ["get", "chosen"], 1], 9, 6], "circle-color": team, "circle-stroke-color": ["case", ["==", ["get", "chosen"], 1], text, bg], "circle-stroke-width": ["case", ["==", ["get", "chosen"], 1], 3, 1.5] },
  });
  map.addLayer({
    id: "play-camp-label",
    type: "symbol",
    source: SRC.camps,
    layout: { "text-field": ["case", ["==", ["get", "chosen"], 1], ["concat", "Base camp · ", ["get", "name"]], ["get", "name"]], "text-font": FONT, "text-size": 12, "text-anchor": "left", "text-offset": [1.1, 0], "text-allow-overlap": false },
    paint: { "text-color": text, "text-halo-color": bg, "text-halo-width": 1.5 },
  });
  map.addSource(SRC.lkp, { type: "geojson", data: lkpData(lkp) });
  map.addLayer({ id: "play-lkp-ring", type: "circle", source: SRC.lkp, paint: { "circle-radius": 14, "circle-color": accent, "circle-opacity": 0.18, "circle-stroke-color": accent, "circle-stroke-width": 1.5 } });
  map.addLayer({ id: "play-lkp", type: "circle", source: SRC.lkp, paint: { "circle-radius": 6, "circle-color": accent, "circle-stroke-color": bg, "circle-stroke-width": 2 } });
  map.addLayer({
    id: "play-lkp-label",
    type: "symbol",
    source: SRC.lkp,
    layout: { "text-field": ["get", "label"], "text-font": FONT, "text-size": 13, "text-anchor": "bottom", "text-offset": [0, -1.4], "text-allow-overlap": true },
    paint: { "text-color": text, "text-halo-color": bg, "text-halo-width": 1.5 },
  });
}

function Layers({ lkp, camp, onLkp, onCamp }: { lkp: LatLon | null; camp: string | null; onLkp: (p: LatLon) => void; onCamp: (name: string) => void }) {
  const { map } = useMap();
  const latest = useRef({ lkp, camp, onLkp, onCamp });
  latest.current = { lkp, camp, onLkp, onCamp };

  useEffect(() => {
    if (!map) return undefined;
    // the whole area and every staging point in view, whatever the panel's size (a phone's strip, a desktop's half)
    const fit = () => {
      const el = map.getContainer();
      if (!el.clientWidth || !el.clientHeight) return;
      map.resize();
      const south = Math.min(AREA_BOUNDS.south, ...STAGING.map((s) => s.lat));
      const pad = Math.min(40, Math.round(Math.min(el.clientWidth, el.clientHeight) / 12));
      map.fitBounds([[AREA_BOUNDS.west - 0.0012, south - 0.0004], [AREA_BOUNDS.east, AREA_BOUNDS.north]], { padding: { top: pad + 28, bottom: pad, left: pad, right: pad }, duration: 0 });
    };
    const ready = () => {
      install(map, latest.current.camp, latest.current.lkp);
      fit();
    };
    if (map.isStyleLoaded()) ready();
    else map.once("load", ready);
    const sized = new ResizeObserver(() => fit());
    sized.observe(map.getContainer());
    const click = (e: MapMouseEvent) => {
      const near = STAGING.map((s) => ({ s, d: Math.hypot(...((p) => [p.x - e.point.x, p.y - e.point.y] as [number, number])(map.project([s.lon, s.lat]))) })).sort((a, b) => a.d - b.d)[0];
      if (near && near.d <= CAMP_HIT_PX) latest.current.onCamp(near.s.name);
      else latest.current.onLkp({ lat: e.lngLat.lat, lon: e.lngLat.lng });
    };
    const cursor = (e: MapMouseEvent) => {
      const hit = STAGING.some((s) => {
        const p = map.project([s.lon, s.lat]);
        return Math.hypot(p.x - e.point.x, p.y - e.point.y) <= CAMP_HIT_PX;
      });
      map.getCanvas().style.cursor = hit ? "pointer" : "crosshair";
    };
    map.on("click", click);
    map.on("mousemove", cursor);
    map.getCanvas().style.cursor = "crosshair";
    return () => {
      sized.disconnect();
      map.off("load", ready);
      map.off("click", click);
      map.off("mousemove", cursor);
    };
  }, [map]);

  useEffect(() => {
    (map?.getSource(SRC.lkp) as GeoJSONSource | undefined)?.setData(lkpData(lkp));
  }, [map, lkp]);
  useEffect(() => {
    (map?.getSource(SRC.camps) as GeoJSONSource | undefined)?.setData(campData(camp));
  }, [map, camp]);
  return null;
}

export function PlayMap({ lkp, camp, onLkp, onCamp, className = "" }: { lkp: LatLon | null; camp: string | null; onLkp: (p: LatLon) => void; onCamp: (name: string) => void; className?: string }) {
  const style = useMemo(() => {
    const key = import.meta.env.VITE_MAPTILER_KEY?.trim() || undefined;
    return basemapStyle(chooseBasemapMode(key, navigator.onLine), key, readBasemapColors());
  }, []);
  const center = useMemo<[number, number]>(() => [(AREA_BOUNDS.west + AREA_BOUNDS.east) / 2, (AREA_BOUNDS.north + AREA_BOUNDS.south) / 2 - 0.003], []);
  return (
    <div role="group" aria-label="Search area map: click inside the outline for the last known point, or a staging point for base camp" className={`overflow-hidden ${className}`}>
      <MapProvider className="h-full w-full" initialCenter={center} initialZoom={14.2} mapStyle={style}>
        <Layers lkp={lkp} camp={camp} onLkp={onLkp} onCamp={onCamp} />
      </MapProvider>
    </div>
  );
}
