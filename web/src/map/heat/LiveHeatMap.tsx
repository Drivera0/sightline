// The live mission's map (LANE_C §5.5 C-H1, with a first pass of lane B's clue and team layers): the
// heat from `useMission().mapBase` + `mapUpdates` (search/live.ts, a checkpoint every 25 updates),
// animated as each `map.updated` arrives (reduced motion: no tween); sector outlines with their POA
// now; the last-known point; clues; teams at their last position. Demo caches keep HeatLayer.
// Built by lane A for lanes C and B (issues #64, #74).
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { GeoJSONSource, Map } from "maplibre-gl";
import type { Clue, MapBase, MapUpdate, Team } from "../../contract";
import type { SectorNow } from "../../lib/api";
import { prefersReducedMotion } from "../../metrics/motion";
import { LiveHeat, lookedAt } from "../../search/live";
import { basemapStyle, chooseBasemapMode, readBasemapColors } from "../base/basemap";
import { MapProvider, useMap } from "../MapView";
import { heatScaleMax } from "./geometry";
import { gridCorners, HeatRaster, heatPixels, paletteFromTokens, readRasterTokens } from "./raster";

export const LIVE_IDS = {
  heat: "live-heat-cells",
  sectors: "live-heat-sectors",
  sectorLabels: "live-heat-sector-labels",
  points: "live-heat-points",
  pointLabels: "live-heat-point-labels",
} as const;
const TWEEN_MS = 600;

type Feature = { type: "Feature"; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } };
const fc = (features: Feature[]) => ({ type: "FeatureCollection" as const, features });
const pct = (x: number) => `${Math.round(x * 100)} %`;

/** Sector outlines and their "B3 · 6 %" labels (sectors from a server before #83 have no outline). */
export function sectorFeatures(sectors: readonly SectorNow[]): { lines: Feature[]; labels: Feature[] } {
  const lines: Feature[] = [];
  const labels: Feature[] = [];
  for (const s of sectors) {
    if (!s.polygon?.length) continue;
    lines.push({ type: "Feature", properties: { id: s.sector_id }, geometry: { type: "LineString", coordinates: s.polygon } });
    const ring = s.polygon.slice(0, -1);
    const lon = ring.reduce((a, c) => a + c[0], 0) / ring.length;
    const lat = ring.reduce((a, c) => a + c[1], 0) / ring.length;
    labels.push({
      type: "Feature",
      properties: { text: `${s.sector_id} · ${pct(s.poa)}` },
      geometry: { type: "Point", coordinates: [lon, lat] },
    });
  }
  return { lines, labels };
}

/** The last-known point, clues and teams with a known position, as labelled points. */
export function pointFeatures(base: MapBase, clues: readonly Clue[], teams: readonly Team[]): Feature[] {
  const pt = (kind: string, label: string, lon: number, lat: number): Feature => ({
    type: "Feature",
    properties: { kind, label },
    geometry: { type: "Point", coordinates: [lon, lat] },
  });
  return [
    pt("lkp", "Last known point", base.lkp.lon, base.lkp.lat),
    ...clues.map((c) => pt("clue", `${c.id} ${c.kind}`, c.lon, c.lat)),
    ...teams.filter((t) => t.position).map((t) => pt("team", t.callsign, t.position!.lon, t.position!.lat)),
  ];
}

function LiveLayers({ base, updates, sectors, clues, teams }: Omit<LiveHeatMapProps, "mapBase"> & { base: MapBase }): ReactNode {
  const { map } = useMap();
  const heat = useMemo(() => new LiveHeat(base), [base]);
  const raster = useMemo(() => new HeatRaster(base.grid), [base]);
  const scaleMax = useMemo(() => heatScaleMax(base.prior.p), [base]);
  // Ready means *this* map has the sources: StrictMode (and a new mission) replace the map instance.
  const [readyMap, setReadyMap] = useState<Map | null>(null);
  const ready = map !== null && readyMap === map;
  const drawn = useRef(false);

  useEffect(() => {
    if (!map) return undefined;
    const install = () => {
      if (!map.getSource(LIVE_IDS.heat)) {
        map.addSource(LIVE_IDS.heat, { type: "canvas", canvas: raster.canvas, coordinates: gridCorners(base.grid), animate: false });
        map.addLayer({ id: LIVE_IDS.heat, type: "raster", source: LIVE_IDS.heat, paint: { "raster-opacity": 0.85, "raster-resampling": "nearest", "raster-fade-duration": 0 } });
      }
      for (const id of [LIVE_IDS.sectors, LIVE_IDS.sectorLabels, LIVE_IDS.points]) {
        if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: fc([]) });
      }
      const color = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
      if (!map.getLayer(LIVE_IDS.sectors)) {
        map.addLayer({ id: LIVE_IDS.sectors, type: "line", source: LIVE_IDS.sectors, paint: { "line-color": color("--text", "#f2f2f0"), "line-opacity": 0.5, "line-width": 1 } });
        map.addLayer({
          id: LIVE_IDS.sectorLabels,
          type: "symbol",
          source: LIVE_IDS.sectorLabels,
          layout: { "text-field": ["get", "text"], "text-size": 11 },
          paint: { "text-color": color("--text", "#f2f2f0"), "text-halo-color": color("--bg", "#0a0b0d"), "text-halo-width": 1.5 },
        });
        map.addLayer({
          id: LIVE_IDS.points,
          type: "circle",
          source: LIVE_IDS.points,
          paint: {
            "circle-radius": ["match", ["get", "kind"], "lkp", 6, 5],
            "circle-color": ["match", ["get", "kind"], "lkp", color("--accent", "#ff7a1a"), "clue", color("--warn", "#ffc48f"), color("--ok", "#7ee2a0")],
            "circle-stroke-color": color("--bg", "#0a0b0d"),
            "circle-stroke-width": 1.5,
          },
        });
        map.addLayer({
          id: LIVE_IDS.pointLabels,
          type: "symbol",
          source: LIVE_IDS.points,
          layout: { "text-field": ["get", "label"], "text-size": 11, "text-offset": [0, 1.2], "text-anchor": "top" },
          paint: { "text-color": color("--text", "#f2f2f0"), "text-halo-color": color("--bg", "#0a0b0d"), "text-halo-width": 1.5 },
        });
      }
      setReadyMap(map);
    };
    raster.setOnDraw((playing) => {
      const src = map.getSource(LIVE_IDS.heat) as { play?: () => void; pause?: () => void } | undefined;
      src?.play?.();
      if (!playing) src?.pause?.();
    });
    if (map.isStyleLoaded()) install();
    else map.once("load", install);
    map.on("styledata", install);
    map.fitBounds([gridCorners(base.grid)[3], gridCorners(base.grid)[1]], { padding: 24, duration: 0 });
    return () => {
      map.off("load", install);
      map.off("styledata", install);
      raster.stop();
    };
  }, [map, raster, base]);

  // The heat: new updates are applied incrementally and the change is tweened.
  useEffect(() => {
    if (!ready) return;
    const state = heat.sync(updates);
    const covered = lookedAt(base, updates);
    const pixels = heatPixels(state, covered, new Uint8Array(covered.length), paletteFromTokens(readRasterTokens()), scaleMax);
    if (!drawn.current || prefersReducedMotion()) raster.show(pixels);
    else raster.animate(pixels, { durationMs: TWEEN_MS });
    drawn.current = true;
  }, [ready, heat, raster, base, updates, scaleMax]);

  useEffect(() => {
    if (!map || !ready) return;
    const { lines, labels } = sectorFeatures(sectors);
    setData(map, LIVE_IDS.sectors, lines);
    setData(map, LIVE_IDS.sectorLabels, labels);
    setData(map, LIVE_IDS.points, pointFeatures(base, clues, teams));
  }, [map, ready, base, sectors, clues, teams]);

  return null;
}

function setData(map: Map, id: string, features: Feature[]) {
  (map.getSource(id) as GeoJSONSource | undefined)?.setData?.(fc(features) as unknown as Parameters<GeoJSONSource["setData"]>[0]);
}

export interface LiveHeatMapProps {
  mapBase: MapBase | null;
  updates: readonly MapUpdate[];
  sectors: readonly SectorNow[];
  clues: readonly Clue[];
  teams: readonly Team[];
}

export function LiveHeatMap({ mapBase, ...rest }: LiveHeatMapProps): ReactNode {
  const style = useMemo(() => {
    const key = import.meta.env.VITE_MAPTILER_KEY?.trim() || undefined;
    return basemapStyle(chooseBasemapMode(key, navigator.onLine), key, readBasemapColors());
  }, []);
  const center = useMemo<[number, number] | undefined>(() => (mapBase ? [mapBase.lkp.lon, mapBase.lkp.lat] : undefined), [mapBase]);
  if (!mapBase) return <p className="text-small text-text-3">The map appears once the mission has its search area.</p>;
  return (
    <figure aria-label="Live map" className="flex flex-col gap-2">
      <div className="h-[420px] overflow-hidden rounded-lg border border-border">
        <MapProvider className="h-full w-full" initialCenter={center} initialZoom={15} mapStyle={style}>
          <LiveLayers base={mapBase} {...rest} />
        </MapProvider>
      </div>
      <figcaption className="text-small text-text-3">
        Where the person could be now, on the cells a photo has looked at (darker: more likely); grey: not photographed yet.
        {" "}
        {rest.updates.length} map updates · sectors show their POA now.
      </figcaption>
    </figure>
  );
}
