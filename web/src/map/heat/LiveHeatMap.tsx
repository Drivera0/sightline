// The live mission's map (LANE_C §5.5 C-H1, with a first pass of lane B's clue and team layers): the
// heat from `useMission().mapBase` + `mapUpdates` (search/live.ts, a checkpoint every 25 updates),
// animated as each `map.updated` arrives (reduced motion: no tween); sector outlines with their POA
// now; the last-known point; clues; teams at their last position. Demo caches keep HeatLayer.
// The fleet moves: drones glide between telemetry ticks (map/base/fleetMotion.ts), a re-tasked leg
// fades out with a dashed trail to the new one (legLayer.ts), each drone's ring says its simulated
// link (ok, degraded, lost), and dots travel along a drone's relay for a cut-off team (relayLayer.ts).
// One requestAnimationFrame loop, only while something moves.
// Labels: a drone shows only "D2 88%" and a SIM chip, a team only "T3"; their full lines (name, battery,
// the link in words, last heard; callsign, status, position age) are hover/focus tooltips and in the
// hidden text summary. Labels never overlap: MapLibre's symbol collision moves or drops them. Layers
// higher up are placed first: drones, then the last known point and clues, then teams, then sector POA
// labels (which move inside their sector rather than vanish). Inside a layer `symbol-sort-key` decides
// (lost link first; last known point before clues; likeliest sector first). Drones bunched at home
// after a recall try eight spots around their dot before a label is dropped.
// Built by lane A for lanes C and B (issues #64, #74).
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { Marker, Popup, type GeoJSONSource, type Map } from "maplibre-gl";
import type { Clue, FleetState, MapBase, MapUpdate, Proposal, Team } from "../../contract";
import { usePick } from "../pick";
import { clueFeatures } from "../base/clueLayer";
import { droneFeatures, droneLinkWords } from "../base/droneLayer";
import { ensureFleetImages, FLEET_IMAGES } from "../base/fleetImages";
import { FleetGlide, type LonLat } from "../base/fleetMotion";
import { legFeatures, noteCancels, retaskAnimating, retaskFeatures, type SeenCancel } from "../base/legLayer";
import { point, type MissionFeature } from "../base/missionFeature";
import { relayFeatures } from "../base/relayLayer";
import { teamFeatures } from "../base/teamLayer";
import { useMission, type DroneLink } from "../../lib/mission";
import { isTyping } from "../../lib/keys";
import { clock, useClock } from "../../lib/time";
import { useSelection } from "../../lib/selection";
import type { SectorNow } from "../../lib/api";
import { prefersReducedMotion } from "../../metrics/motion";
import { LiveHeat, lookedAt } from "../../search/live";
import { basemapStyle, chooseBasemapMode, readBasemapColors } from "../base/basemap";
import { MapProvider, useMap } from "../MapView";
import { cellKinds, surfaceData } from "./classes";
import { cluesToFlash, type ClueSeen, FLASH_MS, flashFeatures, seenOf } from "./clueFlash";
import { CLASS_ROWS, ContourGlyph, OUTSIDE_LABEL, swatchColor } from "./Legend";
import { basemapKind, basemapLabelLayer, type BasemapKind, HEAT_PALETTES, type HeatPalette, muteImagery } from "./palette";
import { gridCorners, HeatRaster, kindColors, kindPixels, surfaceTheme } from "./raster";
import { ensureSurfaceLayers, pushSurface, setSurfaceMode, setSurfacePalette, surfaceIds } from "./surface";

export const LIVE_IDS = {
  heat: "live-heat-cells",
  sectors: "live-heat-sectors",
  sectorLabels: "live-heat-sector-labels",
  points: "live-heat-points",
  legs: "live-heat-legs",
  pointLabels: "live-heat-point-labels",
  teamLabels: "live-heat-team-labels",
  drones: "live-heat-drones",
  droneLabels: "live-heat-drone-labels",
  droneSim: "live-heat-drone-sim",
  relay: "live-heat-relay",
} as const;
/** The probability surface: the raster (LIVE_IDS.heat) while it tweens, class fills and contours at rest. */
export const LIVE_SURFACE_IDS = surfaceIds("live-heat-", LIVE_IDS.heat);
const TWEEN_MS = 600;

type Feature = { type: "Feature"; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } };
const fc = (features: Feature[]) => ({ type: "FeatureCollection" as const, features });
/** The flash of a clue just added or confirmed (clueFlash.ts). */
const FLASH_ID = "sl-clue-flash";
/** A theme token (MapLibre cannot read CSS variables). */
const cssVar = (name: string, fallback: string) =>
  (typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(name).trim()) || fallback;
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
      properties: { text: `${s.sector_id} · ${pct(s.poa)}`, poa: s.poa },
      geometry: { type: "Point", coordinates: [lon, lat] },
    });
  }
  return { lines, labels };
}

/** The last-known point, then lane B's layers: clues, teams and drones (map/base/*Layer.ts). */
export function pointFeatures(
  base: MapBase,
  clues: readonly Clue[],
  teams: readonly Team[],
  fleet: FleetState | null = null,
  now: Date = new Date(),
  time?: (iso: string) => string,
): MissionFeature[] {
  const callsign = (id: string) => teams.find((t) => t.id === id)?.callsign ?? (id === "command" ? "command" : id);
  return [
    point("lkp", "", "Last known point", "accent", base.lkp.lon, base.lkp.lat),
    ...clueFeatures(clues, callsign, time),
    ...teamFeatures(teams, now),
    ...droneFeatures(fleet),
  ];
}

function LiveLayers({
  base,
  updates,
  sectors,
  clues,
  teams,
  fleet = null,
  proposals = [],
  now,
  onBasemap,
}: Omit<LiveHeatMapProps, "mapBase"> & { base: MapBase; onBasemap?: (kind: BasemapKind) => void }): ReactNode {
  const { map, onPick } = useMap();
  const links = useMission((s) => s.links);
  const { tz } = useClock();
  const glide = useMemo(() => new FleetGlide(), []);
  const seen = useRef<Record<string, SeenCancel>>({});
  const firstLook = useRef(true);
  const pending = usePick((s) => s.pending);
  const heat = useMemo(() => new LiveHeat(base), [base]);
  const raster = useMemo(() => new HeatRaster(base.grid), [base]);
  const [basemap, setBasemap] = useState<BasemapKind>("dark");
  const theme = useMemo(
    () => surfaceTheme({ veil: cssVar("--bg", "#0a0b0d"), held: cssVar("--text", "#f2f2f0") }),
    [],
  );
  const surface = useRef<ReturnType<typeof surfaceData> | null>(null);
  const appliedPalette = useRef<BasemapKind | null>(null);
  // Ready means *this* map has the sources: StrictMode (and a new mission) replace the map instance.
  const [readyMap, setReadyMap] = useState<Map | null>(null);
  const ready = map !== null && readyMap === map;
  const drawn = useRef(false);
  const droneTargets = useRef<Record<string, MapTarget>>({});
  const teamTargets = useRef<Record<string, MapTarget>>({});

  useEffect(() => {
    if (!map) return undefined;
    const install = () => {
      // The heat sits under the basemap's roads and labels; its palette follows the basemap (palette.ts).
      // This runs on every styledata: the palette is set again only after a basemap switch.
      const kind = basemapKind(map);
      const palette = HEAT_PALETTES[kind];
      const mode = raster.animating ? "raster" : "vector";
      const added = ensureSurfaceLayers(map, LIVE_SURFACE_IDS, raster.canvas, base.grid, palette, theme, 1, mode, basemapLabelLayer(map));
      if (added || appliedPalette.current !== kind) {
        setSurfacePalette(map, LIVE_SURFACE_IDS, palette, theme, 1);
        appliedPalette.current = kind;
        setBasemap(kind);
        onBasemap?.(kind);
      }
      muteImagery(map, true);
      if (added && surface.current) pushSurface(map, LIVE_SURFACE_IDS, surface.current);
      for (const id of [LIVE_IDS.sectors, LIVE_IDS.sectorLabels, LIVE_IDS.points, LIVE_IDS.legs, LIVE_IDS.drones, LIVE_IDS.relay]) {
        if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: fc([]) });
      }
      const color = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
      ensureFleetImages(map, { background: color("--bg", "#0a0b0d"), border: color("--text-3", "#8a8a93"), text: color("--text", "#f2f2f0") });
      if (!map.getLayer(LIVE_IDS.sectors)) {
        const tone = (): unknown => ["match", ["get", "tone"], "accent", color("--accent", "#ff7a1a"), "warn", color("--warn", "#ffc48f"), "ok", color("--ok", "#7ee2a0"),
          "info", color("--accent-soft", "#ffb27a"), "muted", color("--text-3", "#8a8f98"), color("--text", "#f2f2f0")]; // prettier-ignore
        // legs: proposed faint and dashed, approved solid, flying solid and thicker (B-T1)
        map.addLayer({ id: LIVE_IDS.legs, type: "line", source: LIVE_IDS.legs, filter: ["in", ["get", "style"], ["literal", ["approved", "flying"]]],
          paint: { "line-color": tone() as never, "line-opacity": 0.85, "line-width": ["match", ["get", "style"], "flying", 2.5, 1.5] } }); // prettier-ignore
        // a re-task: the cancelled leg fades out; a dashed trail from where the drone turned to its new leg
        map.addLayer({ id: `${LIVE_IDS.legs}-cancelled`, type: "line", source: LIVE_IDS.legs, filter: ["==", ["get", "style"], "cancelled"],
          paint: { "line-color": color("--accent", "#ff7a1a"), "line-opacity": ["*", 0.85, ["get", "fade"]] as never, "line-width": 2 } }); // prettier-ignore
        map.addLayer({ id: `${LIVE_IDS.legs}-diverted`, type: "line", source: LIVE_IDS.legs, filter: ["==", ["get", "style"], "diverted"],
          paint: { "line-color": color("--text-2", "#a1a1aa"), "line-opacity": 0.9, "line-width": 1.5, "line-dasharray": [1.5, 1.5] } }); // prettier-ignore
        // relay for a cut-off team: a thin dashed link and dots moving along it towards the drones
        map.addLayer({ id: LIVE_IDS.relay, type: "line", source: LIVE_IDS.relay, filter: ["==", ["get", "kind"], "relay"],
          paint: { "line-color": color("--accent-soft", "#ffb27a"), "line-opacity": 0.6, "line-width": 1, "line-dasharray": [1, 2] } }); // prettier-ignore
        map.addLayer({ id: `${LIVE_IDS.relay}-dots`, type: "circle", source: LIVE_IDS.relay, filter: ["==", ["get", "kind"], "relay-dot"],
          paint: { "circle-radius": 2.5, "circle-color": color("--accent-soft", "#ffb27a"), "circle-stroke-color": color("--bg", "#0a0b0d"), "circle-stroke-width": 0.5 } }); // prettier-ignore
        map.addLayer({ id: `${LIVE_IDS.legs}-proposed`, type: "line", source: LIVE_IDS.legs, filter: ["==", ["get", "style"], "proposed"],
          paint: { "line-color": tone() as never, "line-opacity": 0.45, "line-width": 1.2, "line-dasharray": [2, 2] } }); // prettier-ignore
        map.addLayer({ id: LIVE_IDS.sectors, type: "line", source: LIVE_IDS.sectors, paint: { "line-color": color("--text", "#f2f2f0"), "line-opacity": 0.5, "line-width": 1 } });
        map.addLayer({
          id: LIVE_IDS.sectorLabels,
          type: "symbol",
          source: LIVE_IDS.sectorLabels,
          // POA labels stay: placed after the clue and drone labels, they move inside their sector to a free spot.
          layout: {
            "text-field": ["get", "text"],
            "text-size": 11,
            "text-variable-anchor": ["center", "top", "bottom", "left", "right"],
            "text-radial-offset": 1.4,
            "text-allow-overlap": false,
            "symbol-sort-key": ["-", 0, ["get", "poa"]],
          },
          paint: { "text-color": color("--text", "#f2f2f0"), "text-halo-color": color("--bg", "#0a0b0d"), "text-halo-width": 1.5 },
        });
        map.addLayer({
          id: LIVE_IDS.points,
          type: "circle",
          source: LIVE_IDS.points,
          paint: {
            "circle-radius": ["match", ["get", "kind"], "lkp", 6, "drone", 6, 5],
            "circle-color": tone() as never,
            "circle-stroke-color": color("--bg", "#0a0b0d"),
            "circle-stroke-width": 1.5,
          },
        });
        // teams: "T3" only (the full line is the tooltip). Added below the clue labels, so placed after them.
        map.addLayer({
          id: LIVE_IDS.teamLabels,
          type: "symbol",
          source: LIVE_IDS.points,
          filter: ["==", ["get", "kind"], "team"],
          layout: {
            "icon-image": FLEET_IMAGES.hit,
            "icon-allow-overlap": true,
            "text-field": ["get", "short"],
            "text-size": 11,
            "text-variable-anchor": ["right", "left", "top", "bottom", "top-right", "bottom-right", "top-left", "bottom-left"],
            "text-radial-offset": 0.9,
            "text-allow-overlap": false,
            "text-optional": true,
          },
          paint: { "text-color": tone() as never, "text-halo-color": color("--bg", "#0a0b0d"), "text-halo-width": 1.5 },
        });
        map.addLayer({
          id: LIVE_IDS.pointLabels,
          type: "symbol",
          source: LIVE_IDS.points,
          filter: ["!=", ["get", "kind"], "team"],
          // the invisible square keeps other labels off the dot; a label that has no room is dropped, the dot stays
          layout: {
            "icon-image": FLEET_IMAGES.hit,
            "icon-allow-overlap": true,
            "text-field": ["get", "label"],
            "text-size": 11,
            "text-variable-anchor": ["top", "bottom", "right", "left"],
            "text-radial-offset": 1.1,
            "text-allow-overlap": false,
            "text-optional": true,
            "symbol-sort-key": ["match", ["get", "kind"], "lkp", 0, 1],
          },
          paint: { "text-color": color("--text", "#f2f2f0"), "text-halo-color": color("--bg", "#0a0b0d"), "text-halo-width": 1.5 },
        });
        // drones: the ring is the link (ok green, degraded amber, lost in the accent and thicker); the tooltip says it in words
        map.addLayer({
          id: LIVE_IDS.drones,
          type: "circle",
          source: LIVE_IDS.drones,
          paint: {
            "circle-radius": 6,
            "circle-color": tone() as never,
            "circle-stroke-color": ["match", ["get", "link"], "lost", color("--accent", "#ff7a1a"), "degraded", color("--warn", "#ffc48f"), color("--ok", "#7ee2a0")] as never,
            "circle-stroke-width": ["match", ["get", "link"], "lost", 3.5, "degraded", 3, 2] as never,
          },
        });
        map.addLayer({
          id: LIVE_IDS.droneLabels,
          type: "symbol",
          source: LIVE_IDS.drones,
          // "D2 88%": the id, then the battery a little smaller (the label amber when the battery is low)
          layout: {
            "icon-image": FLEET_IMAGES.hit,
            "icon-allow-overlap": true,
            "text-field": ["format", ["get", "short"], {}, " ", {}, ["get", "battery"], { "font-scale": 0.85 }] as never,
            "text-size": 11.5,
            // bunched at home after a recall: each label tries eight spots around its dot before it is dropped
            "text-variable-anchor": ["left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right"],
            "text-radial-offset": 0.9,
            "text-allow-overlap": false,
            "text-optional": true,
            "symbol-sort-key": ["match", ["get", "link"], "lost", 0, "degraded", 1, 2],
          },
          paint: {
            "text-color": ["match", ["get", "tone"], "warn", color("--warn", "#ffc48f"), color("--text", "#f2f2f0")] as never,
            "text-halo-color": color("--bg", "#0a0b0d"),
            "text-halo-width": 1.5,
          },
        });
        // a SIM chip on every simulated drone, always drawn (it never hides another label)
        map.addLayer({
          id: LIVE_IDS.droneSim,
          type: "symbol",
          source: LIVE_IDS.drones,
          filter: ["==", ["get", "sim"], true],
          layout: { "icon-image": FLEET_IMAGES.sim, "icon-anchor": "bottom", "icon-offset": [0, -7], "icon-allow-overlap": true, "icon-ignore-placement": true },
        });
      }
      setReadyMap(map);
    };
    raster.setOnDraw((playing) => {
      const src = map.getSource(LIVE_IDS.heat) as { play?: () => void; pause?: () => void } | undefined;
      src?.play?.();
      if (!playing) src?.pause?.();
      setSurfaceMode(map, LIVE_SURFACE_IDS, playing ? "raster" : "vector");
    });
    if (map.isStyleLoaded()) install();
    else map.once("load", install);
    map.on("styledata", install);
    // more room at the bottom: drones near the grid's south edge stay off the attribution row
    map.fitBounds([gridCorners(base.grid)[3], gridCorners(base.grid)[1]], { padding: { top: 24, left: 24, right: 24, bottom: 56 }, duration: 0 });
    return () => {
      map.off("load", install);
      map.off("styledata", install);
      raster.stop();
      try {
        muteImagery(map, false);
      } catch {
        /* map gone */
      }
    };
    // onBasemap is a notification only; a new one does not need the layers again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, raster, base, theme]);

  // The heat: new updates are applied incrementally and the change is tweened (the raster), then the
  // same classes are drawn as fills and contours.
  const kinds = useMemo(() => {
    if (!ready) return null;
    const covered = lookedAt(base, updates);
    return cellKinds(heat.sync(updates).p, covered, new Uint8Array(covered.length));
  }, [ready, heat, base, updates]);
  const colors = useMemo(() => kindColors(HEAT_PALETTES[basemap], theme), [basemap, theme]);
  useEffect(() => {
    if (!map || !kinds) return;
    surface.current = surfaceData(base.grid, kinds);
    pushSurface(map, LIVE_SURFACE_IDS, surface.current);
  }, [map, base, kinds]);
  useEffect(() => {
    if (!kinds) return;
    const pixels = kindPixels(kinds, colors);
    if (!drawn.current || prefersReducedMotion()) raster.show(pixels);
    else raster.animate(pixels, { durationMs: TWEEN_MS });
    drawn.current = true;
  }, [raster, kinds, colors]);

  useEffect(() => {
    if (!map || !ready) return;
    const { lines, labels } = sectorFeatures(sectors);
    setData(map, LIVE_IDS.sectors, lines);
    setData(map, LIVE_IDS.sectorLabels, labels);
    const points = pointFeatures(base, clues, teams, null, now ?? new Date(), (iso) => clock(iso, tz));
    setData(map, LIVE_IDS.points, points);
    syncTargets(map, teamTargets.current, points.filter((p) => p.properties.kind === "team"), "team");
  }, [map, ready, base, sectors, clues, teams, now, tz]);

  // A clue added or confirmed: its circle and the cells it reweighted flash and fade, so the cause
  // (the clue) and the effect (the map) are seen together. Reduced motion: no flash.
  const cluesSeen = useRef<ClueSeen | null>(null);
  useEffect(() => {
    if (!map || !ready) return undefined;
    const fresh = cluesToFlash(cluesSeen.current, clues);
    cluesSeen.current = seenOf(clues);
    if (fresh.length === 0 || prefersReducedMotion()) return undefined;
    if (!map.getSource(FLASH_ID)) {
      map.addSource(FLASH_ID, { type: "geojson", data: fc([]) as never });
      map.addLayer({ id: `${FLASH_ID}-fill`, type: "fill", source: FLASH_ID, paint: { "fill-color": cssVar("--accent", "#ff7a1a"), "fill-opacity": 0 } });
      map.addLayer({ id: `${FLASH_ID}-line`, type: "line", source: FLASH_ID, paint: { "line-color": cssVar("--accent", "#ff7a1a"), "line-width": 3, "line-opacity": 0 } });
    }
    setData(map, FLASH_ID, flashFeatures(base, fresh, updates) as unknown as Feature[]);
    const start = performance.now();
    let raf = 0;
    const frame = (t: number) => {
      // (a frame's timestamp can be a little before `start`)
      const f = Math.min(1, Math.max(0, (t - start) / FLASH_MS));
      // two quick pulses, then the fade
      const k = 1 - f;
      const a = Math.min(1, Math.max(0, k * (0.65 + 0.35 * Math.cos(f * 4 * Math.PI))));
      map.setPaintProperty(`${FLASH_ID}-fill`, "fill-opacity", 0.6 * a);
      map.setPaintProperty(`${FLASH_ID}-line`, "line-opacity", a);
      if (k > 0) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      if (map.getLayer(`${FLASH_ID}-fill`)) {
        map.setPaintProperty(`${FLASH_ID}-fill`, "fill-opacity", 0);
        map.setPaintProperty(`${FLASH_ID}-line`, "line-opacity", 0);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, ready, clues]);

  // The fleet: drones glide to each new report, a re-task animates out, relay dots travel. One
  // animation frame loop, running only while something moves (reduced motion: one still frame).
  useEffect(() => {
    if (!map || !ready) return undefined;
    const reduced = prefersReducedMotion();
    const start = performance.now();
    const targets: Record<string, LonLat> = {};
    for (const d of fleet?.drones ?? []) if (d.position) targets[d.id] = [d.position.lon, d.position.lat];
    glide.update(targets, start, reduced);
    seen.current = noteCancels(fleet, seen.current, start, glide.positions(start), firstLook.current);
    firstLook.current = false;
    const clock = now ?? new Date();
    const drones = droneFeatures(fleet, links.drones, clock);
    syncTargets(map, droneTargets.current, drones, "drone");
    let raf = 0;
    let settled = false;
    const frame = () => {
      const t = performance.now();
      const drawn = glide.positions(t);
      const moving = glide.animating(t) || retaskAnimating(seen.current, t);
      if (moving || !settled) {
        setData(map, LIVE_IDS.drones, drones.map((f) => (drawn[f.properties.id] ? { ...f, geometry: { type: "Point", coordinates: drawn[f.properties.id] } } : f)));
        for (const [id, t] of Object.entries(droneTargets.current)) if (drawn[id]) t.marker.setLngLat(drawn[id]);
        setData(map, LIVE_IDS.legs, [...legFeatures(fleet, proposals), ...retaskFeatures(fleet, seen.current, t, reduced)]);
        settled = !moving;
      }
      const relays = relayFeatures(links, teams, drawn, t, reduced);
      setData(map, LIVE_IDS.relay, relays);
      if (!reduced && (moving || relays.length > 0)) raf = requestAnimationFrame(frame);
    };
    frame();
    return () => cancelAnimationFrame(raf);
  }, [map, ready, glide, fleet, proposals, links, teams, now]);
  // the drones' and teams' hover/focus targets go with the map instance
  useEffect(() => {
    const groups = [droneTargets.current, teamTargets.current];
    return () => {
      for (const all of groups) {
        for (const [id, t] of Object.entries(all)) {
          t.marker.remove();
          delete all[id];
        }
      }
    };
  }, [map]);

  // Clicking a team, drone or clue selects it (D-M2); selecting a team elsewhere (the roster) flies here.
  useEffect(() => {
    if (!map || !ready) return undefined;
    const onClick = (e: { features?: { properties: Record<string, unknown> }[] }) => {
      const f = e.features?.[0]?.properties;
      if (!f?.id) return;
      if (f.popup && map) {
        // the clue's details (B-C1): text only, never HTML from the mission
        const el = document.createElement("div");
        el.className = "text-small";
        el.style.whiteSpace = "pre-line";
        el.style.color = "#111";
        el.textContent = String(f.popup);
        const at = (e as unknown as { lngLat: { lng: number; lat: number } }).lngLat;
        new Popup({ closeButton: true }).setLngLat([at.lng, at.lat]).setDOMContent(el).addTo(map);
      }
      const sel = useSelection.getState();
      if (f.kind === "team") sel.selectTeam(String(f.id));
      else if (f.kind === "drone") sel.selectDrone(String(f.id));
      else if (f.kind === "clue") sel.selectClue(String(f.id));
    };
    map.on("click", LIVE_IDS.points, onClick as never);
    map.on("click", LIVE_IDS.drones, onClick as never);
    return () => {
      map.off("click", LIVE_IDS.points, onClick as never);
      map.off("click", LIVE_IDS.drones, onClick as never);
    };
  }, [map, ready]);
  const selectedTeam = useSelection((s) => s.selectedTeamId);
  useEffect(() => {
    const t = teams.find((x) => x.id === selectedTeam);
    if (map && t?.position) map.flyTo({ center: [t.position.lon, t.position.lat], zoom: Math.max(map.getZoom(), 16), duration: prefersReducedMotion() ? 0 : 800 });
  }, [map, selectedTeam, teams]);

  // A pick asked for elsewhere on the page (the clue form): B's onPick answers it.
  useEffect(() => {
    if (!pending || !ready) return undefined;
    return onPick(
      (p) => pending(p),
      () => pending(null),
    );
  }, [pending, ready, onPick]);

  return null;
}

/** A drone's or team's hover and keyboard target: a transparent button over its dot, with its full line as a tooltip. */
interface MapTarget {
  marker: Marker;
  el: HTMLButtonElement;
  tip: HTMLSpanElement;
}

const TARGET_CLASS =
  "group h-5 w-5 cursor-pointer rounded-full bg-transparent hover:z-10 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const TIP_CLASS =
  "pointer-events-none absolute bottom-full left-1/2 mb-3 hidden w-max max-w-[280px] -translate-x-1/2 whitespace-pre-line rounded-md border border-border bg-bg/90 px-2.5 py-1.5 text-left text-caption text-text shadow-lg group-hover:block group-focus-visible:block";

/** One button per drone (or team) on the map: created, moved, given its latest line, or removed. */
function syncTargets(map: Map, targets: Record<string, MapTarget>, features: readonly MissionFeature[], kind: "drone" | "team"): void {
  const ids = new Set(features.map((f) => f.properties.id));
  for (const [id, t] of Object.entries(targets)) {
    if (ids.has(id)) continue;
    t.marker.remove();
    delete targets[id];
  }
  for (const f of features) {
    const id = f.properties.id;
    let t = targets[id];
    if (!t) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = TARGET_CLASS;
      if (kind === "drone") el.dataset.droneTarget = id;
      else el.dataset.teamTarget = id;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const sel = useSelection.getState();
        if (kind === "drone") sel.selectDrone(id);
        else sel.selectTeam(id);
      });
      const tip = document.createElement("span");
      tip.className = TIP_CLASS;
      tip.setAttribute("aria-hidden", "true"); // the button's label says the same
      el.appendChild(tip);
      t = { marker: new Marker({ element: el }).setLngLat(f.geometry.coordinates as [number, number]).addTo(map), el, tip };
      targets[id] = t;
    } else if (kind === "team") {
      t.marker.setLngLat(f.geometry.coordinates as [number, number]); // drones are moved by the glide
    }
    t.el.setAttribute("aria-label", f.properties.label);
    t.tip.textContent = f.properties.popup ?? f.properties.label;
  }
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
  fleet?: FleetState | null;
  /** Pending proposals: their drone legs are drawn faint and dashed. */
  proposals?: readonly Proposal[];
  /** The clock for position ages (the demo mission passes its own). */
  now?: Date;
  /** Fill the parent's height (the command console), with the legend floating on the map. */
  fill?: boolean;
}

const TEAM_WORDS: Record<Team["status"], string> = { standby: "standby", assigned: "assigned", searching: "searching", returning: "returning", off_duty: "off duty" };
const pctWords = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;

/**
 * The map in words, for screen readers (the figure's description): every sector with its POA (likeliest
 * first), every team with its status, every clue, every drone. Rebuilt whenever the data changes.
 */
export function mapTextAlternative({
  sectors,
  teams,
  clues,
  fleet = null,
  links = {},
  now = new Date(),
}: Pick<LiveHeatMapProps, "sectors" | "teams" | "clues" | "fleet" | "now"> & { links?: Readonly<Record<string, DroneLink>> }): string[] {
  const callsign = (id: string) => teams.find((t) => t.id === id)?.callsign ?? id;
  const bySector = [...sectors].sort((a, b) => b.poa - a.poa);
  const drones = fleet?.drones ?? [];
  return [
    bySector.length
      ? `Sectors by probability (POA): ${bySector.map((s) => `${s.sector_id} ${s.label} ${pctWords(s.poa)}`).join("; ")}.`
      : "No sectors yet.",
    teams.length
      ? `Teams: ${teams.map((t) => `${t.callsign} ${TEAM_WORDS[t.status]}${t.position ? "" : ", no position"}`).join("; ")}.`
      : "No teams.",
    clues.length
      ? `Clues: ${clues.map((c) => `${c.id} ${c.kind}: ${c.text} (${callsign(c.reported_by)}, ${c.confirmed ? "confirmed" : "unconfirmed"})`).join("; ")}.`
      : "No clues yet.",
    drones.length
      ? `Drones${fleet?.simulated ? " (simulated)" : ""}: ${drones.map((d) => droneWords(d, links[d.id], now)).join("; ")}.`
      : "No drones on the map.",
  ];
}

/** "Drone 2 flying, battery 88%, link lost, last heard 5 min ago" (nothing about the link while it is ok). */
function droneWords(d: FleetState["drones"][number], link: DroneLink | undefined, now: Date): string {
  const words = droneLinkWords(link, now);
  return `${d.name} ${d.status}, battery ${Math.round(d.battery_pct)}%${words ? `, ${words}` : ""}`;
}

function MapDescription({ id, ...data }: { id: string } & Pick<LiveHeatMapProps, "sectors" | "teams" | "clues" | "fleet" | "now">) {
  const links = useMission((s) => s.links.drones);
  return (
    <div id={id} className="sr-only">
      {mapTextAlternative({ ...data, links }).map((line) => (
        <p key={line.slice(0, 40)}>{line}</p>
      ))}
    </div>
  );
}

export function LiveHeatMap({ mapBase, fill = false, ...rest }: LiveHeatMapProps): ReactNode {
  const describedBy = useId();
  const description = <MapDescription id={describedBy} sectors={rest.sectors} teams={rest.teams} clues={rest.clues} fleet={rest.fleet} now={rest.now} />;
  const style = useMemo(() => {
    const key = import.meta.env.VITE_MAPTILER_KEY?.trim() || undefined;
    return basemapStyle(chooseBasemapMode(key, navigator.onLine), key, readBasemapColors());
  }, []);
  const center = useMemo<[number, number] | undefined>(() => (mapBase ? [mapBase.lkp.lon, mapBase.lkp.lat] : undefined), [mapBase]);
  const picking = usePick((s) => s.pending !== null);
  const [basemap, setBasemap] = useState<BasemapKind>("dark");
  if (!mapBase) return <p className="text-small text-text-3">The map appears once the mission has its search area.</p>;
  if (fill) {
    return (
      <figure aria-label="Live map" aria-describedby={describedBy} className={`relative h-full min-h-[360px] overflow-hidden rounded-lg border border-border ${ATTRIBUTION_CLASS}`}>
        {description}
        <MapProvider className="h-full w-full" initialCenter={center} initialZoom={15} mapStyle={style}>
          <LiveLayers base={mapBase} {...rest} onBasemap={setBasemap} />
        </MapProvider>
        {picking && (
          <p role="status" className="absolute right-3 top-3 z-10 rounded-full border border-accent bg-bg/85 px-3 py-1 text-small text-accent-soft">
            Click the map to place the clue (Esc cancels).
          </p>
        )}
        <FloatingLegend updates={rest.updates.length} palette={HEAT_PALETTES[basemap]} />
      </figure>
    );
  }
  return (
    <figure aria-label="Live map" aria-describedby={describedBy} className="flex flex-col gap-2">
      {description}
      <div className={`h-[420px] overflow-hidden rounded-lg border border-border ${ATTRIBUTION_CLASS}`}>
        <MapProvider className="h-full w-full" initialCenter={center} initialZoom={15} mapStyle={style}>
          <LiveLayers base={mapBase} {...rest} onBasemap={setBasemap} />
        </MapProvider>
      </div>
      {picking && (
        <p role="status" className="text-small text-accent-soft">
          Click the map to place the clue (Esc cancels).
        </p>
      )}
      <figcaption className="flex flex-col gap-1.5 text-small text-text-3">
        <HeatKeyRow palette={HEAT_PALETTES[basemap]} />
        <MapLegend />
        <span>
          {HEAT_CAPTION}{" "}
          {rest.fleet?.simulated ? "Drones, their links and relays are simulated. " : ""}
          {rest.updates.length} map updates · each sector shows its share of the probability (POA).
        </span>
      </figcaption>
    </figure>
  );
}

/** The heat in words: the caption under the map and the floating legend's tooltip. */
export const HEAT_CAPTION =
  "Shading: the likeliest 50, 80 and 90 % of the probability on ground a photo has looked at (lighter on the dark map, redder on satellite: likelier); no shading: outside 90 % of estimated probability; dimmed: not photographed yet.";

/** The map's attribution on the app background, so a mark drawn under it stays readable and so does it. */
const ATTRIBUTION_CLASS =
  "[&_.maplibregl-ctrl-attrib]:bg-bg/85! [&_.maplibregl-ctrl-attrib]:text-text-3! [&_.maplibregl-ctrl-attrib_a]:text-text-2! [&_.maplibregl-ctrl-attrib]:rounded-tl-md";

const LEGEND_KEY = "sightline.mapLegend";

/** Open or closed as this browser last left it; closed the first time (the map comes first). */
export function legendOpenAtStart(): boolean {
  try {
    return globalThis.localStorage?.getItem(LEGEND_KEY) === "open";
  } catch {
    return false; // private mode: closed
  }
}

/**
 * The legend floating on the console's map: a small "Legend" pill with the map-update count (top left,
 * away from the scrubber along the bottom), opened by a click or the L key; open, two columns of at most
 * four lines under the pill.
 */
export function FloatingLegend({ updates, palette }: { updates: number; palette?: HeatPalette }) {
  const [open, setOpen] = useState(legendOpenAtStart);
  const bodyId = useId();
  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(LEGEND_KEY, open ? "open" : "closed");
    } catch {
      /* private mode: remembered for this page only */
    }
  }, [open]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "l" || e.key === "L") setOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <figcaption
      className={`absolute top-3 left-3 z-10 flex max-h-[calc(100%-1.5rem)] max-w-[calc(100%-1.5rem)] flex-col overflow-y-auto border border-border bg-bg/85 backdrop-blur-[16px] ${open ? "rounded-md px-3 py-2" : "rounded-full px-2.5 py-1"}`}
      title={`${HEAT_CAPTION} Each sector shows its share of the probability (POA).`}
    >
      <div className="order-2 mt-1.5 flex flex-col gap-1.5" id={bodyId} hidden={!open}>
        <HeatKeyRow palette={palette} />
        <MapLegend columns />
      </div>
      <div className="order-1 flex items-center gap-2.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-keyshortcuts="L"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 rounded-full text-caption text-text-2 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <svg aria-hidden="true" viewBox="0 0 10 10" className={`h-2.5 w-2.5 transition-transform ${open ? "rotate-90" : "-rotate-90"}`}>
            <path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          Legend
          <kbd aria-hidden="true" className="rounded-[3px] border border-border px-1 font-mono text-[10px] leading-[14px] text-text-3">L</kbd>
        </button>
        <span className="font-mono text-caption text-text-3">
          {updates} map updates{open ? " · sector labels show POA" : ""}
        </span>
      </div>
    </figcaption>
  );
}

const Line = ({ className }: { className: string }) => <span className={`inline-block w-4 ${className}`} />;

/** Seven lines: the fill legend lays them out as two columns of at most four. */
const LEGEND: readonly { key: string; title?: string; content: ReactNode }[] = [
  { key: "lkp", content: <><Dot color="var(--accent)" />Last known point<Dot color="var(--warn)" className="ml-2" />Clue</> },
  { key: "teams", content: <><Dot color="var(--ok)" />Team searching<Dot color="var(--accent-soft)" className="ml-2" />assigned or returning</> },
  { key: "drone", title: "Hover or focus a drone for its name, battery, link and when it was last heard", content: <><SimChip />D2 88%: drone and battery; SIM: simulated</> },
  {
    key: "link",
    title: "A drone that lost its link flies its leg on its own",
    content: <><Ring color="var(--ok)" />Link ok<Ring color="var(--warn)" className="ml-2" />degraded<Ring color="var(--accent)" thick className="ml-2" />lost</>,
  },
  { key: "route", content: <><Line className="h-0.5 bg-accent" />Drone route<Line className="ml-2 border-t border-dashed border-text-3" />proposed, awaiting approval</> },
  { key: "retask", content: <><Line className="border-t border-dashed border-text-2" />Re-tasked: where a drone turned</> },
  { key: "relay", content: <><Line className="border-t-2 border-dotted border-accent-soft" />Relay: a drone carries a cut-off team</> },
];

function SimChip() {
  return <span className="inline-block rounded-[3px] border border-text-3 bg-bg px-0.5 font-mono text-[8px] leading-[10px] font-semibold text-text">SIM</span>;
}

function Ring({ color, thick = false, className = "" }: { color: string; thick?: boolean; className?: string }) {
  return <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-text ${className}`} style={{ boxShadow: `0 0 0 ${thick ? 2.5 : 1.5}px ${color}` }} />;
}

function Dot({ color, className = "" }: { color: string; className?: string }) {
  return <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${className}`} style={{ background: color }} />;
}

/** The heat in one line: the three classes, the two contour lines and the unshaded rest. */
export function HeatKeyRow({ palette = HEAT_PALETTES.dark }: { palette?: HeatPalette }) {
  return (
    <ul aria-label="Probability classes" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-text-2">
      <li className="flex items-center gap-1.5 whitespace-nowrap" title={CLASS_ROWS.map((r) => `${r.label}: ${r.hint}`).join(". ")}>
        {CLASS_ROWS.map((r) => (
          <span key={r.key} aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: swatchColor(palette[r.key]) }} />
        ))}
        Likeliest 50 · 80 · 90 % of probability
      </li>
      <li className="flex items-center gap-1.5 whitespace-nowrap">
        <ContourGlyph line={palette.contour50} casing={palette.casing} />
        50 % edge
        <ContourGlyph line={palette.contour90} casing={palette.casing} className="ml-2" />
        90 % edge
      </li>
      <li className="flex items-center gap-1.5 whitespace-nowrap">
        <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px] ring-1 ring-border" />
        No shading: {OUTSIDE_LABEL.toLowerCase()}
      </li>
    </ul>
  );
}

/** What the map's marks mean: the colours LiveLayers gives each kind and tone. `columns`: two columns, four lines. */
export function MapLegend({ columns = false }: { columns?: boolean }) {
  return (
    <ul
      aria-label="Map legend"
      className={`${columns ? "grid grid-flow-col grid-rows-4 gap-x-6" : "flex flex-wrap gap-x-4"} gap-y-1 text-caption text-text-2`}
    >
      {LEGEND.map((l) => (
        <li key={l.key} title={l.title} className="flex items-center gap-1.5 whitespace-nowrap">
          {l.content}
        </li>
      ))}
    </ul>
  );
}
