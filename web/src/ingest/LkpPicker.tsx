// New search: the last known position picked on the map (D-I1 with lane B's onPick, B-M3). Each click
// moves the point; the typed lat/lon fields stay the record. Built by lane A for lanes D and B (#51, #74).
import { useEffect, useMemo } from "react";
import type { GeoJSONSource } from "maplibre-gl";
import { basemapStyle, chooseBasemapMode, readBasemapColors } from "../map/base/basemap";
import { MapProvider, useMap } from "../map/MapView";

/** Mount Seymour, where the demo is; the map starts there until a position is typed or picked. */
export const DEFAULT_CENTER: [number, number] = [-122.9375, 49.375];
const SOURCE = "lkp-pick";

function PickLayer({ point, onPick }: { point: { lat: number; lon: number } | null; onPick: (p: { lat: number; lon: number }) => void }) {
  const { map, onPick: pick } = useMap();

  useEffect(() => {
    if (!map) return undefined;
    const install = () => {
      if (map.getSource(SOURCE)) return;
      map.addSource(SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#ff7a1a";
      map.addLayer({ id: SOURCE, type: "circle", source: SOURCE, paint: { "circle-radius": 7, "circle-color": accent, "circle-stroke-color": "#000", "circle-stroke-width": 1.5 } });
    };
    if (map.isStyleLoaded()) install();
    else map.once("load", install);
    // Pick again after every click: the point can be moved until the search starts.
    let stop = () => {};
    const again = () => {
      stop = pick((p) => {
        onPick(p);
        again();
      });
    };
    again();
    return () => {
      stop();
      map.off("load", install);
    };
  }, [map, pick, onPick]);

  useEffect(() => {
    const src = map?.getSource(SOURCE) as GeoJSONSource | undefined;
    src?.setData({
      type: "FeatureCollection",
      features: point ? [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [point.lon, point.lat] } }] : [],
    });
  }, [map, point]);
  return null;
}

export function LkpPicker({ point, onPick, className = "h-64 rounded-sm border border-border", zoom = 13 }: { point: { lat: number; lon: number } | null; onPick: (p: { lat: number; lon: number }) => void; className?: string; zoom?: number }) {
  const style = useMemo(() => {
    const key = import.meta.env.VITE_MAPTILER_KEY?.trim() || undefined;
    return basemapStyle(chooseBasemapMode(key, navigator.onLine), key, readBasemapColors());
  }, []);
  // the map is centred once (where the point was when it opened); later picks don't move it
  const center = useMemo<[number, number]>(() => (point ? [point.lon, point.lat] : DEFAULT_CENTER), []);
  return (
    <div role="group" className={`overflow-hidden ${className}`} aria-label="Pick the last known position on the map">
      <MapProvider className="h-full w-full" initialCenter={center} initialZoom={zoom} mapStyle={style}>
        <PickLayer point={point} onPick={onPick} />
      </MapProvider>
    </div>
  );
}
