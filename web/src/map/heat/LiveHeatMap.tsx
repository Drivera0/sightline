// The live mission's map (LANE_C §5.5 C-H1, with a first pass of lane B's clue and team layers): the
// heat from `useMission().mapBase` + `mapUpdates` (search/live.ts, a checkpoint every 25 updates),
// animated as each `map.updated` arrives (reduced motion: no tween); sector outlines with their POA
// now; the last-known point; clues; teams at their last position. Demo caches keep HeatLayer.
// The fleet moves: drones and teams glide between reports (map/base/fleetMotion.ts), a re-tasked leg
// fades out with a dashed trail to the new one (legLayer.ts), each drone's ring says its simulated
// link (ok, degraded, lost), and dots travel along a drone's relay for a cut-off team (relayLayer.ts).
// One requestAnimationFrame loop, only while something moves.
// One icon set (shell/icons.tsx, map/base/iconImages.ts): drone, team, clue, base camp, last known point and
// the find, each a 2 px stroke at one size on its own small disc; base camp and teams sit on a dark halo
// that keeps the heat out from under them. Only a drone's active leg is drawn solid; legs it has flown fade
// to 20 %, planned ones are dashed. Click a sector to act on it (the console's popover); in Task mode the
// click assigns; drop a team's T-card on a sector to assign it.
// Labels: a drone shows only "D2 88%", a team only "T3"; their full lines (name, battery,
// the link in words, last heard; callsign, status, position age) are hover/focus tooltips and in the
// hidden text summary. The marks' labels are placed in one pass across every kind (map/base/pointLabels.ts):
// the find, the last known point, base camp, teams, drones, clues, in that order; each next to its mark,
// else further out with a leader line, else left out; never over another label or another mark. Teams
// waiting at base camp share one chip ("T1 T2 T3 at base"). Clues show only their icon at the console's
// zoom (the text on hover, and from CLUE_TEXT_ZOOM in). The sector POA labels are placed by MapLibre after
// them and move inside their sector rather than vanish.
// Built by lane A for lanes C and B (issues #64, #74).
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { Marker, Popup, type GeoJSONSource, type Map } from "maplibre-gl";
import type { Clue, FleetState, MapBase, MapUpdate, Mission, Proposal, Team } from "../../contract";
import { ensureIconImages } from "../base/iconImages";
import { sectorAt, sectorCentre } from "../../search/sectorCells";
import { useConsole } from "../../command/consoleStore";
import { usePick } from "../pick";
import { clueArcFeatures, clueFeatures } from "../base/clueLayer";
import { droneFeatures, droneLinkWords } from "../base/droneLayer";
import { ensureFleetImages, FLEET_IMAGES } from "../base/fleetImages";
import { FleetGlide, glidePoints, type LonLat } from "../base/fleetMotion";
import { legFeatures, noteCancels, retaskAnimating, retaskFeatures, type SeenCancel } from "../base/legLayer";
import { point, type MissionFeature } from "../base/missionFeature";
import { relayFeatures } from "../base/relayLayer";
import { OnePopup } from "../base/onePopup";
import { showMe } from "../../command/showMe";
import { teamFeatures, teamShort } from "../base/teamLayer";
import { atBaseText, layoutPointLabels, leaderEnd, leaderStart, type PointLabelInput, teamsAtBase } from "../base/pointLabels";
import type { Box } from "../base/camera";
import { useMission, type DroneLink } from "../../lib/mission";
import { isTyping } from "../../lib/keys";
import { KeyHint } from "../../shell/components";
import { Icon, type IconName } from "../../shell/icons";
import { clock, useClock } from "../../lib/time";
import { useSelection } from "../../lib/selection";
import type { SectorNow } from "../../lib/api";
import { prefersReducedMotion } from "../../metrics/motion";
import { LiveHeat, lookedAt } from "../../search/live";
import { basemapStyle, chooseBasemapMode, readBasemapColors } from "../base/basemap";
import { MapProvider, useMap } from "../MapView";
import { surfaceData } from "./classes";
import { evidenceless, HATCH_KIND, searchedMask, smoothKinds, smoothSurface, wholeGridKinds } from "./smooth";
import { cluesToFlash, type ClueSeen, FLASH_MS, flashFeatures, ringAlpha, seenOf } from "./clueFlash";
import { CLASS_ROWS, ContourGlyph, swatchColor } from "./Legend";
import { basemapKind, basemapLabelLayer, type BasemapKind, CONSOLE_PALETTES, consolePalettes, type HeatPalette, muteImagery } from "./palette";
import { useTheme } from "../../shell/theme";
import { gridCorners, HeatRaster, kindColors, kindPixels, surfaceTheme } from "./raster";
import { type CandidatePlace, useBeatLayer, useFocusLayers } from "./focusLayers";
import { ensureSurfaceLayers, pushSurface, setSurfaceMode, setSurfacePalette, surfaceIds } from "./surface";
import { plainWords } from "../../command/terms";

// The one glyph set the site serves (public/basemap/fonts). A symbol layer without "text-font" asks for
// MapLibre's default stack, which is not there: a 404 and no labels.
const GLYPH_FONT = ["Noto Sans Regular"];

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
  halos: "live-heat-halos",
  selected: "live-heat-sector-selected",
  labels: "live-heat-labels",
  leaders: "live-heat-leaders",
  /** A sound heard on a bearing: its arc (clueLayer.ts clueArcFeatures). */
  clueArcs: "live-heat-clue-arcs",
} as const;
/** The probability surface: the raster (LIVE_IDS.heat) while it tweens, class fills and contours at rest. */
export const LIVE_SURFACE_IDS = surfaceIds("live-heat-", LIVE_IDS.heat);
/**
 * A change of the heat (a review answer, a clue, a photo) tweens cell by cell over this long (V3 §2), and
 * the raster and the class fills crossfade in and out of it, so the surface visibly evolves, never swaps.
 */
export const HEAT_TWEEN_MS = 750;
/** The heat changes at most this often (ms): its fade, then a moment to see it. */
export const HEAT_SPACING_MS = 900;

/**
 * `value`, changing at most once every `ms`: a change within `ms` of the last waits, and the latest value
 * comes in when the wait is over. The first value (and reduced motion's) comes in at once.
 */
export function useSpaced<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const at = useRef(-Infinity);
  useEffect(() => {
    if (value === shown) return undefined;
    const now = performance.now();
    const wait = at.current + ms - now;
    if (wait <= 0 || prefersReducedMotion()) {
      at.current = now;
      setShown(value);
      return undefined;
    }
    const id = window.setTimeout(() => {
      at.current = performance.now();
      setShown(value);
    }, wait);
    return () => window.clearTimeout(id);
  }, [value, shown, ms]);
  return shown;
}
/** The crossfades: into the tween (the contours fade out) and out of it (the new fills and contours fade in). */
export const HEAT_FADE_IN_MS = 150;
export const HEAT_FADE_OUT_MS = 220;

type Feature = { type: "Feature"; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } };
const fc = (features: Feature[]) => ({ type: "FeatureCollection" as const, features });
/** The flash of a clue just added or confirmed (clueFlash.ts). */
const FLASH_ID = "sl-clue-flash";
/** The hatch over ground no photo has looked at yet: 1 px diagonal lines in the text colour, the layer at 0.12. */
const HATCH_IMAGE = "sl-unphotographed-hatch-1px";
function hatchImage(color: string): ImageData | null {
  if (typeof document === "undefined") return null;
  const el = document.createElement("canvas");
  el.width = el.height = 8;
  const ctx = el.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  // one pixel per step along the diagonal: a crisp 1 px line that tiles seamlessly
  ctx.fillStyle = color;
  for (let k = 0; k < 8; k++) ctx.fillRect(k, 7 - k, 1, 1);
  return ctx.getImageData(0, 0, 8, 8);
}
/** A theme token (MapLibre cannot read CSS variables). */
const cssVar = (name: string, fallback: string) =>
  (typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(name).trim()) || fallback;
// one decimal under 10 %: a sector a clue raised from 2.9 to 5.5 % must not read "3 %" and "5 %" on the map
const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)} %`;

/** Sector outlines and their "B3 · 6 %" labels (sectors from a server before #83 have no outline). */
export function sectorFeatures(sectors: readonly SectorNow[], teamIn: (sector: string) => string | null = () => null): { lines: Feature[]; labels: Feature[] } {
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
      properties: { text: `${s.sector_id} · ${pct(s.poa)}${teamIn(s.sector_id) ? ` · ${teamIn(s.sector_id)}` : ""}`, poa: s.poa },
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
  mission: Pick<Mission, "base_camp" | "found"> | null = null,
): MissionFeature[] {
  const callsign = (id: string) => teams.find((t) => t.id === id)?.callsign ?? (id === "command" ? "command" : id);
  const camp = mission?.base_camp;
  const found = mission?.found;
  return [
    ...(camp ? [point("base", "base", camp.name && !/^base camp$/i.test(camp.name.trim()) ? `Base camp: ${camp.name}` : "Base camp", "text", camp.lon, camp.lat)] : []),
    ...(found ? [point("found", "found", `Found by ${callsign(found.team)} in ${found.sector}`, "found", found.lon, found.lat)] : []),
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
  mission = null,
  tasks = [],
  actions,
  candidateAt,
  onBasemap,
  onEvidence,
  onReady,
}: Omit<LiveHeatMapProps, "mapBase"> & { base: MapBase; onBasemap?: (kind: BasemapKind) => void; onEvidence?: (any: boolean) => void }): ReactNode {
  const { map, onPick } = useMap();
  const links = useMission((s) => s.links);
  const { tz } = useClock();
  const glide = useMemo(() => new FleetGlide(), []);
  // the teams glide too (the clock reports them ten times a second, like the drones)
  const teamGlide = useMemo(() => new FleetGlide(), []);
  const seen = useRef<Record<string, SeenCancel>>({});
  const firstLook = useRef(true);
  const pending = usePick((s) => s.pending);
  const heat = useMemo(() => new LiveHeat(base), [base]);
  const raster = useMemo(() => new HeatRaster(base.grid), [base]);
  const [basemap, setBasemap] = useState<BasemapKind>("dark");
  const themeName = useTheme();
  const theme = useMemo(
    () => surfaceTheme({ veil: cssVar("--bg", "#0a0b0d"), held: cssVar("--text", "#f2f2f0") }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [themeName],
  );
  // the heat on the colour system's --prob tokens, for the theme on screen
  const palettes = useMemo(() => consolePalettes(themeName), [themeName]);
  const surface = useRef<ReturnType<typeof surfaceData> | null>(null);
  const appliedPalette = useRef<BasemapKind | null>(null);
  // Ready means *this* map has the sources: StrictMode (and a new mission) replace the map instance.
  const [readyMap, setReadyMap] = useState<Map | null>(null);
  const ready = map !== null && readyMap === map;
  const drawn = useRef(false);
  // once the layers are in, the next quiet moment (or 1.5 s at most) means the map is on screen
  const told = useRef(false);
  useEffect(() => {
    if (!ready || !map || told.current || !onReady) return undefined;
    const tell = () => {
      if (told.current) return;
      told.current = true;
      onReady();
    };
    const timer = window.setTimeout(tell, 1500);
    map.once("idle", tell);
    return () => {
      window.clearTimeout(timer);
      map.off("idle", tell);
    };
  }, [ready, map, onReady]);
  const droneTargets = useRef<Record<string, MapTarget>>({});
  // the marks as last drawn (drones where they glide to), for the one-pass label placement
  const pointsNow = useRef<MissionFeature[]>([]);
  const dronesNow = useRef<MissionFeature[]>([]);
  const fitZoom = useRef<number | null>(null);
  const relabel = useRef<() => void>(() => {});
  const teamTargets = useRef<Record<string, MapTarget>>({});

  useEffect(() => {
    if (!map) return undefined;
    const install = () => {
      // The heat sits under the basemap's roads and labels; its palette follows the basemap (palette.ts).
      // This runs on every styledata: the palette is set again only after a basemap switch.
      const kind = basemapKind(map);
      const palette = palettes[kind];
      const mode = raster.animating ? "raster" : "vector";
      const added = ensureSurfaceLayers(map, LIVE_SURFACE_IDS, raster.canvas, base.grid, palette, theme, 1, mode, basemapLabelLayer(map));
      if (added || appliedPalette.current !== kind) {
        setSurfacePalette(map, LIVE_SURFACE_IDS, palette, theme, 1);
        appliedPalette.current = kind;
        setBasemap(kind);
        onBasemap?.(kind);
      }
      muteImagery(map, true);
      // the console's "not photographed yet": a light hatch over the heat, not a veil under it
      const hatchLayer = LIVE_SURFACE_IDS.fills[HATCH_KIND] as string;
      if (!map.hasImage(HATCH_IMAGE)) {
        const img = hatchImage(cssVar("--text", "#f2f2f0"));
        if (img) map.addImage(HATCH_IMAGE, img, { pixelRatio: 1 });
      }
      if (map.getLayer(hatchLayer) && map.getPaintProperty(hatchLayer, "fill-pattern") !== HATCH_IMAGE) {
        map.setPaintProperty(hatchLayer, "fill-pattern", HATCH_IMAGE);
        map.setPaintProperty(hatchLayer, "fill-antialias", true);
        if (map.getLayer(LIVE_SURFACE_IDS.casing90)) map.moveLayer(hatchLayer, LIVE_SURFACE_IDS.casing90);
      }
      if (added && surface.current) pushSurface(map, LIVE_SURFACE_IDS, surface.current);
      for (const id of [LIVE_IDS.clueArcs, LIVE_IDS.sectors, LIVE_IDS.sectorLabels, LIVE_IDS.points, LIVE_IDS.legs, LIVE_IDS.drones, LIVE_IDS.relay, LIVE_IDS.selected, LIVE_IDS.labels, LIVE_IDS.leaders]) {
        if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: fc([]) });
      }
      const color = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
      ensureFleetImages(map, { background: color("--bg", "#0a0b0d"), border: color("--text-3", "#8a8a93"), text: color("--text", "#f2f2f0") });
      ensureIconImages(map, {
        disc: color("--bg", "#0a0b0d"), accent: color("--accent", "#ff7a1a"), warn: color("--warn", "#ffc48f"), ok: color("--ok", "#7ee2a0"),
        info: color("--accent-soft", "#ffb27a"), muted: color("--text-3", "#8a8a93"), text: color("--text", "#f2f2f0"),
        team: color("--team", "#6ea8fe"), drone: color("--drone", "#2ec4b6"), clue: color("--clue", "#f5b544"), found: color("--found", "#5fd38d"), alert: color("--alert", "#f26b5e"),
      });
      if (!map.getLayer(LIVE_IDS.sectors)) {
        const tone = (): unknown => ["match", ["get", "tone"], "accent", color("--accent", "#ff7a1a"), "warn", color("--warn", "#ffc48f"), "ok", color("--ok", "#7ee2a0"),
          "info", color("--accent-soft", "#ffb27a"), "muted", color("--text-3", "#8a8f98"), color("--text", "#f2f2f0")]; // prettier-ignore
        // legs: only the active (flying) leg solid; flown legs at 20 %; approved-not-yet-flown and proposed dashed
        map.addLayer({ id: LIVE_IDS.legs, type: "line", source: LIVE_IDS.legs, filter: ["==", ["get", "style"], "flying"],
          layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": color("--drone", "#2ec4b6"), "line-opacity": 0.85, "line-width": 1.5 } }); // prettier-ignore
        map.addLayer({ id: `${LIVE_IDS.legs}-past`, type: "line", source: LIVE_IDS.legs, filter: ["==", ["get", "style"], "past"],
          paint: { "line-color": color("--text", "#f2f2f0"), "line-opacity": 0.2, "line-width": 1.5 } }); // prettier-ignore
        map.addLayer({ id: `${LIVE_IDS.legs}-planned`, type: "line", source: LIVE_IDS.legs, filter: ["==", ["get", "style"], "approved"],
          paint: { "line-color": color("--drone", "#2ec4b6"), "line-opacity": 0.7, "line-width": 1.5, "line-dasharray": [2, 2] } }); // prettier-ignore
        // a re-task: the cancelled leg fades out; a dashed trail from where the drone turned to its new leg
        map.addLayer({ id: `${LIVE_IDS.legs}-cancelled`, type: "line", source: LIVE_IDS.legs, filter: ["==", ["get", "style"], "cancelled"],
          paint: { "line-color": color("--drone", "#2ec4b6"), "line-opacity": ["*", 0.85, ["get", "fade"]] as never, "line-width": 2 } }); // prettier-ignore
        map.addLayer({ id: `${LIVE_IDS.legs}-diverted`, type: "line", source: LIVE_IDS.legs, filter: ["==", ["get", "style"], "diverted"],
          paint: { "line-color": color("--text-2", "#a1a1aa"), "line-opacity": 0.9, "line-width": 1.5, "line-dasharray": [1.5, 1.5] } }); // prettier-ignore
        // relay for a cut-off team: a thin dashed link and dots moving along it towards the drones
        map.addLayer({ id: LIVE_IDS.relay, type: "line", source: LIVE_IDS.relay, filter: ["==", ["get", "kind"], "relay"],
          paint: { "line-color": color("--drone", "#2ec4b6"), "line-opacity": 0.6, "line-width": 1, "line-dasharray": [1, 2] } }); // prettier-ignore
        map.addLayer({ id: `${LIVE_IDS.relay}-dots`, type: "circle", source: LIVE_IDS.relay, filter: ["==", ["get", "kind"], "relay-dot"],
          paint: { "circle-radius": 2.5, "circle-color": color("--drone", "#2ec4b6"), "circle-stroke-color": color("--bg", "#0a0b0d"), "circle-stroke-width": 0.5 } }); // prettier-ignore
        map.addLayer({ id: `${LIVE_IDS.legs}-proposed`, type: "line", source: LIVE_IDS.legs, filter: ["==", ["get", "style"], "proposed"],
          paint: { "line-color": tone() as never, "line-opacity": 0.45, "line-width": 1.2, "line-dasharray": [2, 2] } }); // prettier-ignore
        // a sound heard on a bearing: the arc where it could be, a light amber tint under a dashed amber edge
        map.addLayer({ id: `${LIVE_IDS.clueArcs}-fill`, type: "fill", source: LIVE_IDS.clueArcs, paint: { "fill-color": color("--clue", "#f5b544"), "fill-opacity": 0.14 } });
        map.addLayer({ id: LIVE_IDS.clueArcs, type: "line", source: LIVE_IDS.clueArcs,
          paint: { "line-color": color("--clue", "#f5b544"), "line-opacity": 0.9, "line-width": 1.5, "line-dasharray": [3, 2] } }); // prettier-ignore
        map.addLayer({ id: LIVE_IDS.sectors, type: "line", source: LIVE_IDS.sectors, paint: { "line-color": color("--text", "#f2f2f0"), "line-opacity": 0.35, "line-width": 1 } });
        // the sector whose popover is open
        map.addLayer({ id: `${LIVE_IDS.selected}-fill`, type: "fill", source: LIVE_IDS.selected, paint: { "fill-color": color("--accent", "#ff7a1a"), "fill-opacity": 0.08 } });
        map.addLayer({ id: LIVE_IDS.selected, type: "line", source: LIVE_IDS.selected, paint: { "line-color": color("--accent", "#ff7a1a"), "line-opacity": 0.9, "line-width": 2 } });
        map.addLayer({
          id: LIVE_IDS.sectorLabels,
          type: "symbol",
          source: LIVE_IDS.sectorLabels,
          // POA labels stay: placed after the clue and drone labels, they move inside their sector to a free spot.
          layout: {
            "text-field": ["get", "text"],
            "text-font": GLYPH_FONT,
            "text-size": 13,
            "text-variable-anchor": ["center", "top", "bottom", "left", "right"],
            "text-radial-offset": 1.4,
            "text-allow-overlap": false,
            "symbol-sort-key": ["-", 0, ["get", "poa"]],
          },
          paint: { "text-color": color("--text", "#f2f2f0"), "text-halo-color": color("--bg", "#0a0b0d"), "text-halo-width": 1.5 },
        });
        // base camp's and the teams' halos: a dark disc that keeps the heat out from under them
        map.addLayer({
          id: LIVE_IDS.halos,
          type: "circle",
          source: LIVE_IDS.points,
          filter: ["in", ["get", "kind"], ["literal", ["base", "team", "found"]]],
          paint: { "circle-radius": 18, "circle-color": color("--bg", "#0a0b0d"), "circle-opacity": 0.72, "circle-blur": 0.35 },
        });
        // every mark is an icon of the one set, coloured by its tone
        map.addLayer({
          id: LIVE_IDS.points,
          type: "symbol",
          source: LIVE_IDS.points,
          layout: {
            "icon-image": ["concat", "icon-", ["get", "kind"], "-", ["get", "tone"]] as never,
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
            "symbol-sort-key": ["match", ["get", "kind"], "found", 0, "base", 1, "team", 2, 3] as never,
          },
        });
        // the marks' footprints: invisible squares in MapLibre's collision index, so the sector POA labels
        // (placed after them) keep off every mark; the marks' own labels are placed by pointLabels.ts
        map.addLayer({
          id: LIVE_IDS.teamLabels,
          type: "symbol",
          source: LIVE_IDS.points,
          layout: { "icon-image": FLEET_IMAGES.hit, "icon-allow-overlap": true },
        });
        // drones: the ring is the link (ok green, degraded amber, lost in the accent and thicker); the tooltip says it in words
        // drones: the drone icon, its colour the link (ok in the text colour, degraded amber, lost in the accent)
        map.addLayer({
          id: LIVE_IDS.drones,
          type: "symbol",
          source: LIVE_IDS.drones,
          layout: {
            "icon-image": ["match", ["get", "link"], "lost", "icon-drone-alert", "degraded", "icon-drone-warn", "icon-drone-drone"] as never,
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
          },
        });
        map.addLayer({
          id: LIVE_IDS.droneLabels,
          type: "symbol",
          source: LIVE_IDS.drones,
          layout: { "icon-image": FLEET_IMAGES.hit, "icon-allow-overlap": true },
        });
        // a label moved off its mark: a thin leader line back to the mark
        map.addLayer({
          id: LIVE_IDS.leaders,
          type: "line",
          source: LIVE_IDS.leaders,
          paint: { "line-color": color("--text-2", "#a1a1aa"), "line-opacity": 0.7, "line-width": 1 },
        });
        // every mark's label, placed in one pass (pointLabels.ts): the find, the last known point, base camp,
        // teams, drones, clues; MapLibre draws them where they were put and keeps the sector labels off them
        map.addLayer({
          id: LIVE_IDS.pointLabels,
          type: "symbol",
          source: LIVE_IDS.labels,
          layout: {
            "text-field": ["get", "text"],
            "text-font": GLYPH_FONT,
            "text-size": ["get", "size"] as never,
            "text-anchor": ["get", "anchor"] as never,
            "text-offset": ["get", "offset"] as never,
            "text-max-width": 40,
            "text-allow-overlap": true,
            "text-ignore-placement": false,
            "text-padding": 0,
          },
          paint: { "text-color": ["get", "color"] as never, "text-halo-color": color("--bg", "#0a0b0d"), "text-halo-width": 1.5 },
        });
      }
      setReadyMap(map);
    };
    raster.setOnDraw((playing) => {
      const src = map.getSource(LIVE_IDS.heat) as { play?: () => void; pause?: () => void } | undefined;
      src?.play?.();
      if (!playing) src?.pause?.();
      // the tween over: the new fills go on the map now (held back while it ran, so nothing jumped)
      if (!playing && heldSurface.current) {
        pushSurface(map, LIVE_SURFACE_IDS, heldSurface.current);
        heldSurface.current = null;
      }
      const palette = palettes[appliedPalette.current ?? "dark"];
      const fade = prefersReducedMotion() ? undefined : { ms: playing ? HEAT_FADE_IN_MS : HEAT_FADE_OUT_MS, palette, theme, opacity: 1 };
      setSurfaceMode(map, LIVE_SURFACE_IDS, playing ? "raster" : "vector", fade);
    });
    if (map.isStyleLoaded()) install();
    else map.once("load", install);
    map.on("styledata", install);
    // more room at the bottom: drones near the grid's south edge stay off the attribution row
    map.fitBounds([gridCorners(base.grid)[3], gridCorners(base.grid)[1]], { padding: { top: 24, left: 24, right: 24, bottom: 56 }, duration: 0 });
    fitZoom.current = map.getZoom();
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
  }, [map, raster, base, theme, palettes]);

  // The heat: new updates are applied incrementally and the change is tweened (the raster), then the
  // same classes are drawn as fills and contours.
  // the classes over the whole search area (the prior is known everywhere); what no photo has seen yet
  // the ground a search lowered (photos or a ground team that found nobody): darker and cooler under the classes
  // one slow fade at a time: the map log read at most every HEAT_SPACING_MS, the latest when the wait is over
  // (the guided time-lapse lands photos ten times a second; the heat must not flicker with each)
  const heatLog = useSpaced(updates, HEAT_SPACING_MS);
  const searched = useMemo(() => (ready ? searchedMask(base.prior.p.length, heatLog) : null), [ready, base, heatLog]);
  const fresh = useMemo(() => (ready ? wholeGridKinds(heat.sync(heatLog).p, null, searched) : null), [ready, heat, heatLog, searched]);
  // the same picture again (the demo reloads its state on every action) is not a change: no tween
  const lastKinds = useRef<typeof fresh>(null);
  if (fresh !== lastKinds.current && !sameKinds(fresh, lastKinds.current)) lastKinds.current = fresh;
  const kinds = lastKinds.current;
  useEffect(() => {
    if (kinds) onEvidence?.(!evidenceless(kinds));
    // a notification only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kinds]);
  const photographed = useMemo(() => (ready ? (base.photographed ? Uint8Array.from(base.photographed) : lookedAt(base, heatLog)) : null), [ready, base, heatLog]);
  const colors = useMemo(() => kindColors(palettes[basemap], theme), [basemap, theme, palettes]);
  // a new picture's fills wait for its tween to end (the raster draws the change meanwhile)
  const heldSurface = useRef<ReturnType<typeof surfaceData> | null>(null);
  const pushedKinds = useRef<typeof kinds>(null);
  useEffect(() => {
    if (!map || !kinds) return;
    surface.current = smoothSurface(base.grid, kinds, photographed, undefined, searched);
    const tweens = drawn.current && pushedKinds.current !== kinds && !prefersReducedMotion();
    pushedKinds.current = kinds;
    if (tweens) heldSurface.current = surface.current;
    else {
      heldSurface.current = null;
      pushSurface(map, LIVE_SURFACE_IDS, surface.current);
    }
  }, [map, base, kinds, photographed, searched]);
  useEffect(() => {
    if (!kinds) return;
    const pixels = kindPixels(smoothKinds(base.grid, kinds), colors);
    if (!drawn.current || prefersReducedMotion()) raster.show(pixels);
    else raster.animate(pixels, { durationMs: HEAT_TWEEN_MS });
    drawn.current = true;
  }, [raster, kinds, colors, base]);

  useEffect(() => {
    if (!map || !ready) return undefined;
    const short = (id: string | null) => (id ? (teams.find((t) => t.id === id) ? teamShort(teams.find((t) => t.id === id)!) : id) : null);
    const teamIn = (sector: string) => short(tasks.find((t) => t.sector_id === sector && (t.state === "assigned" || t.state === "in_progress"))?.team_id ?? null);
    const { lines, labels } = sectorFeatures(sectors, teamIn);
    setData(map, LIVE_IDS.sectors, lines);
    setData(map, LIVE_IDS.sectorLabels, labels);
    const points = pointFeatures(base, clues, teams, null, now ?? new Date(), (iso) => clock(iso, tz), mission);
    const callsign = (id: string) => teams.find((t) => t.id === id)?.callsign ?? id;
    setData(map, LIVE_IDS.clueArcs, clueArcFeatures(clues, teams, callsign) as unknown as Feature[]);
    // the teams glide from where they are drawn to their newest report, as the drones do
    const reduced = prefersReducedMotion();
    const targets: Record<string, LonLat> = {};
    for (const p of points) if (p.properties.kind === "team" && p.geometry.type === "Point") targets[p.properties.id] = p.geometry.coordinates as LonLat;
    teamGlide.update(targets, performance.now(), reduced);
    let raf = 0;
    let first = true;
    const frame = () => {
      const t = performance.now();
      const placed = glidePoints(points, teamGlide.positions(t), "team");
      setData(map, LIVE_IDS.points, placed);
      pointsNow.current = placed;
      if (first) syncTargets(map, teamTargets.current, placed.filter((p) => p.properties.kind === "team"), "team");
      else for (const p of placed) if (p.properties.kind === "team") teamTargets.current[p.properties.id]?.marker.setLngLat(p.geometry.coordinates as LonLat);
      first = false;
      relabel.current();
      if (!reduced && teamGlide.animating(t)) raf = requestAnimationFrame(frame);
    };
    frame();
    return () => cancelAnimationFrame(raf);
  }, [map, ready, base, sectors, clues, teams, now, tz, mission, tasks, teamGlide]);

  // Every mark's label in one pass (map/base/pointLabels.ts): found, last known point, base camp, teams,
  // drones, clues; each next to its mark or, displaced, with a leader line; again whenever the view moves.
  useEffect(() => {
    if (!map || !ready) return undefined;
    let raf = 0;
    const run = () => {
      raf = 0;
      try {
        const { labels, leaders } = placedLabels(map, pointsNow.current, dronesNow.current, fitZoom.current);
        setData(map, LIVE_IDS.labels, labels);
        setData(map, LIVE_IDS.leaders, leaders);
      } catch {
        /* the map is going away */
      }
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(run);
    };
    relabel.current = schedule;
    map.on("move", schedule);
    map.on("resize", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(raf);
      relabel.current = () => {};
      map.off("move", schedule);
      map.off("resize", schedule);
    };
  }, [map, ready]);

  // One popup at a time, anchored to its pin (onePopup.ts): a pin's opens closing any other and the
  // sector popover; the sector popover opening closes it.
  const one = useMemo(() => (map ? new OnePopup(() => new Popup({ closeButton: true, offset: 14, maxWidth: "300px" }), map, () => useConsole.getState().closeSector()) : null), [map]);
  useEffect(() => () => one?.close(), [one]);
  useEffect(
    () =>
      useConsole.subscribe((s, was) => {
        if (s.sector && s.sector !== was.sector) one?.close();
      }),
    [one],
  );
  // A clue's text on hover while the map is zoomed out (its label shows only from CLUE_TEXT_ZOOM)
  useEffect(() => {
    if (!map || !ready) return undefined;
    const tip = new Popup({ closeButton: false, closeOnClick: false, offset: 14, className: "sl-clue-tip" });
    const show = (e: { features?: { properties: Record<string, unknown> }[]; lngLat: { lng: number; lat: number } }) => {
      const f = e.features?.find((x) => x.properties.kind === "clue")?.properties;
      if (!f || one?.isOpen) return tip.remove(); // the pin's own popup is open: no second one
      const el = document.createElement("div");
      el.className = "text-small";
      el.style.color = "#111";
      el.textContent = String(f.label);
      tip.setLngLat([e.lngLat.lng, e.lngLat.lat]).setDOMContent(el).addTo(map);
    };
    const hide = () => tip.remove();
    // a bearing's arc: what was heard, who heard it, the bearing and range (a mark under the pointer wins)
    const arcFill = `${LIVE_IDS.clueArcs}-fill`;
    const showArc = (e: { features?: { properties: Record<string, unknown> }[]; lngLat: { lng: number; lat: number }; point: { x: number; y: number } }) => {
      const f = e.features?.[0]?.properties;
      if (!f || one?.isOpen) return tip.remove();
      if (map.queryRenderedFeatures([e.point.x, e.point.y] as never, { layers: [LIVE_IDS.points].filter((id) => map.getLayer(id)) }).length) return;
      const el = document.createElement("div");
      el.className = "text-small";
      el.style.color = "#111";
      el.style.whiteSpace = "pre-line";
      el.textContent = String(f.label);
      tip.setLngLat([e.lngLat.lng, e.lngLat.lat]).setDOMContent(el).addTo(map);
    };
    map.on("mousemove", LIVE_IDS.points, show as never);
    map.on("mouseleave", LIVE_IDS.points, hide);
    map.on("mousemove", arcFill, showArc as never);
    map.on("mouseleave", arcFill, hide);
    return () => {
      tip.remove();
      map.off("mousemove", LIVE_IDS.points, show as never);
      map.off("mouseleave", LIVE_IDS.points, hide);
      map.off("mousemove", arcFill, showArc as never);
      map.off("mouseleave", arcFill, hide);
    };
  }, [map, ready, one]);

  // The sector popover: a click on a sector (not on a mark) opens it; in Task mode the click assigns.
  const selSector = useConsole((s) => s.sector);
  useEffect(() => {
    if (!map || !ready) return undefined;
    const onClick = (e: { point: { x: number; y: number }; lngLat: { lng: number; lat: number } }) => {
      const marks = map.queryRenderedFeatures([e.point.x, e.point.y] as never, { layers: [LIVE_IDS.points, LIVE_IDS.drones].filter((id) => map.getLayer(id)) });
      if (marks.length) return;
      const s = sectorAt(sectors, e.lngLat.lng, e.lngLat.lat);
      const ui = useConsole.getState();
      if (!s) return ui.closeSector();
      if (ui.picking && actions) {
        if (ui.picking.kind === "team") actions.assign(ui.picking.id, s.sector_id);
        else actions.droneLeg(s.sector_id, ui.picking.id);
        return ui.pick(null);
      }
      ui.openSector(s.sector_id, e.point.x, e.point.y);
    };
    map.on("click", onClick as never);
    return () => {
      map.off("click", onClick as never);
    };
  }, [map, ready, sectors, actions]);
  // the popover opened from elsewhere (the sectors table): put it at the sector's centre; outline the sector
  useEffect(() => {
    if (!map || !ready) return;
    const s = selSector ? sectors.find((x) => x.sector_id === selSector.id) : null;
    setData(map, LIVE_IDS.selected, s?.polygon ? [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [s.polygon] } }] : []);
    if (s && selSector && !Number.isFinite(selSector.x)) {
      const c = sectorCentre(s);
      if (c) {
        const pt = map.project([c.lon, c.lat]);
        useConsole.getState().openSector(s.sector_id, pt.x, pt.y);
      }
    }
  }, [map, ready, selSector, sectors]);
  // drop a team's T-card on a sector: assign it there (a drone's: fly a leg over it); while dragging, the
  // sector under the pointer is outlined, so the drop target is seen before the drop
  useEffect(() => {
    if (!map || !ready || !actions) return undefined;
    const el = map.getContainer();
    const TEAM = "application/x-sightline-team";
    const DRONE = "application/x-sightline-drone";
    const ours = (e: DragEvent) => !!e.dataTransfer && (e.dataTransfer.types.includes(TEAM) || e.dataTransfer.types.includes(DRONE));
    const sectorOf = (e: DragEvent) => {
      const r = el.getBoundingClientRect();
      const at = map.unproject([e.clientX - r.left, e.clientY - r.top]);
      return sectorAt(sectors, at.lng, at.lat);
    };
    const shape = (s: { polygon?: [number, number][] | null } | null | undefined) =>
      s?.polygon ? [{ type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: [s.polygon] } }] : [];
    let hovered: string | null = null;
    const restore = () => {
      hovered = null;
      const open = useConsole.getState().sector;
      setData(map, LIVE_IDS.selected, shape(open ? sectors.find((x) => x.sector_id === open.id) : null));
    };
    const over = (e: DragEvent) => {
      if (!ours(e)) return;
      e.preventDefault();
      el.classList.add("sl-drop-on");
      const s = sectorOf(e);
      if ((s?.sector_id ?? null) === hovered) return;
      hovered = s?.sector_id ?? null;
      setData(map, LIVE_IDS.selected, shape(s));
    };
    const leave = (e: DragEvent) => {
      // moving onto a child of the map is not leaving it
      if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
      el.classList.remove("sl-drop-on");
      restore();
    };
    const drop = (e: DragEvent) => {
      el.classList.remove("sl-drop-on");
      restore();
      const team = e.dataTransfer?.getData(TEAM);
      const drone = e.dataTransfer?.getData(DRONE);
      if (!team && !drone) return;
      e.preventDefault();
      useConsole.getState().drag(null);
      const s = sectorOf(e);
      if (!s) return;
      if (team) actions.assign(team, s.sector_id);
      else if (drone) actions.droneLeg(s.sector_id, drone);
    };
    el.addEventListener("dragover", over);
    el.addEventListener("dragleave", leave);
    el.addEventListener("drop", drop);
    return () => {
      el.removeEventListener("dragover", over);
      el.removeEventListener("dragleave", leave);
      el.removeEventListener("drop", drop);
    };
  }, [map, ready, sectors, actions]);

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
      map.addLayer({ id: `${FLASH_ID}-fill`, type: "fill", source: FLASH_ID, paint: { "fill-color": cssVar("--clue", "#f2b84b"), "fill-opacity": 0 } });
      map.addLayer({ id: `${FLASH_ID}-line`, type: "line", source: FLASH_ID, filter: ["==", ["get", "kind"], "circle"], paint: { "line-color": cssVar("--clue", "#f2b84b"), "line-width": 2.5, "line-opacity": 0 } });
    }
    setData(map, FLASH_ID, flashFeatures(base, fresh, updates, teams) as unknown as Feature[]);
    const start = performance.now();
    let raf = 0;
    const frame = (t: number) => {
      // (a frame's timestamp can be a little before `start`)
      const f = Math.min(1, Math.max(0, (t - start) / FLASH_MS));
      // one ring in the clue's colour: it comes in over the first tenth, then fades slowly (no flashing)
      const a = ringAlpha(f);
      map.setPaintProperty(`${FLASH_ID}-fill`, "fill-opacity", 0.35 * a);
      map.setPaintProperty(`${FLASH_ID}-line`, "line-opacity", a);
      map.setPaintProperty(`${FLASH_ID}-line`, "line-width", 2.5 + 3 * f);
      if (f < 1) raf = requestAnimationFrame(frame);
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
    let legsDrawn = false;
    let wasRetasking = false;
    const legs = legFeatures(fleet, proposals);
    const frame = () => {
      const t = performance.now();
      const drawn = glide.positions(t);
      const retasking = retaskAnimating(seen.current, t);
      const moving = glide.animating(t) || retasking;
      if (moving || !settled) {
        const placed = drones.map((f) => (drawn[f.properties.id] ? { ...f, geometry: { type: "Point" as const, coordinates: drawn[f.properties.id] } } : f));
        setData(map, LIVE_IDS.drones, placed);
        dronesNow.current = placed;
        relabel.current();
        for (const [id, t] of Object.entries(droneTargets.current)) if (drawn[id]) t.marker.setLngLat(drawn[id]);
        // the legs only change with the fleet, or while a cancelled one fades (not on every frame of a glide)
        if (!legsDrawn || retasking || wasRetasking) setData(map, LIVE_IDS.legs, [...legs, ...retaskFeatures(fleet, seen.current, t, reduced)]);
        legsDrawn = true;
        wasRetasking = retasking;
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
    const onClick = (e: { features?: { properties: Record<string, unknown>; geometry?: { type: string; coordinates: unknown } }[] }) => {
      const hit = e.features?.[0];
      const f = hit?.properties;
      if (!f?.id) return;
      if (f.popup && one) {
        // the clue's details (B-C1), anchored to the pin (not where the click landed)
        const at = hit?.geometry?.type === "Point" ? (hit?.geometry.coordinates as [number, number]) : null;
        const click = (e as unknown as { lngLat: { lng: number; lat: number } }).lngLat;
        one.open(`${String(f.kind)}:${String(f.id)}`, at ?? [click.lng, click.lat], String(f.popup));
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
  }, [map, ready, one]);
  const selectedTeam = useSelection((s) => s.selectedTeamId);
  useEffect(() => {
    const t = teams.find((x) => x.id === selectedTeam);
    if (map && t?.position) map.flyTo({ center: [t.position.lon, t.position.lat], zoom: Math.max(map.getZoom(), 16), duration: prefersReducedMotion() ? 0 : 800 });
  }, [map, selectedTeam, teams]);
  // the subject strip's LKP button: centre the map on the last known point
  const centre = useConsole((s) => s.centre);
  useEffect(() => {
    if (map && centre) map.flyTo({ center: [centre.lon, centre.lat], zoom: Math.max(map.getZoom(), 15), duration: prefersReducedMotion() ? 0 : 800 });
  }, [map, centre]);
  // a clue picked in the timeline: fly to it and say what it is (the one popup, unless its pin's is open)
  const selectedClue = useSelection((s) => s.selectedClueId);
  useEffect(() => {
    const c = clues.find((x) => x.id === selectedClue);
    if (!map || !c || !one) return;
    map.flyTo({ center: [c.lon, c.lat], zoom: Math.max(map.getZoom(), 16), duration: prefersReducedMotion() ? 0 : 800 });
    if (one.key !== `clue:${c.id}`) one.open(`clue:${c.id}`, [c.lon, c.lat], `${c.id} ${c.kind}: ${c.text}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, selectedClue, one]);

  // Add a clue where it was found: right-click the map, or press and hold on a touch screen (V3 §3)
  useEffect(() => {
    if (!map || !ready) return undefined;
    const add = (at: { lng: number; lat: number }) => showMe({ kind: "addClue", at: { lat: at.lat, lon: at.lng } });
    const onMenu = (e: { lngLat: { lng: number; lat: number }; preventDefault?: () => void; originalEvent?: Event }) => {
      e.originalEvent?.preventDefault();
      add(e.lngLat);
    };
    let timer = 0;
    const cancel = () => window.clearTimeout(timer);
    const onTouch = (e: { lngLat: { lng: number; lat: number }; points?: unknown[] }) => {
      cancel();
      if ((e.points?.length ?? 1) !== 1) return;
      const at = e.lngLat;
      timer = window.setTimeout(() => add(at), LONG_PRESS_MS);
    };
    map.on("contextmenu", onMenu as never);
    map.on("touchstart", onTouch as never);
    map.on("touchmove", cancel);
    map.on("touchend", cancel);
    map.on("touchcancel", cancel);
    return () => {
      cancel();
      map.off("contextmenu", onMenu as never);
      map.off("touchstart", onTouch as never);
      map.off("touchmove", cancel);
      map.off("touchend", cancel);
      map.off("touchcancel", cancel);
    };
  }, [map, ready]);

  // What Needs you has in focus (a candidate, a proposal) and a new assignment's route (focusLayers.ts)
  useFocusLayers(map, ready, { sectors, proposals, tasks, teams, mission, candidateAt });
  // the guided time-lapse's beat: what the caption names, outlined for the beat (focusLayers.ts)
  useBeatLayer(map, ready, { sectors, teams });

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

/** Press and hold this long on a touch screen to add a clue there (ms). */
export const LONG_PRESS_MS = 550;

/** From this zoom (and at least one step in from the console's fitted view) clues show their text; below it the icon, and the text on hover. */
export const CLUE_TEXT_ZOOM = 15;
export const clueTextShown = (zoom: number, fitted: number | null) => zoom >= Math.max(CLUE_TEXT_ZOOM, (fitted ?? 0) + 0.75);

/** Panels drawn over the map (the legend, the scrubber, a popover), in the map container's pixels. */
function overlayBoxes(container: HTMLElement): Box[] {
  const figure = container.closest("figure");
  const host = figure?.parentElement;
  const at = container.getBoundingClientRect();
  const els: Element[] = [...(figure?.querySelectorAll(":scope > figcaption") ?? [])];
  for (const el of host ? [...host.children] : []) {
    if (el === figure) continue;
    // a full-width wrapper (pointer-events none) holds the real panel: take its children
    els.push(...(getComputedStyle(el).pointerEvents === "none" ? [...el.children] : [el]));
  }
  return els
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({ left: r.left - at.left, top: r.top - at.top, right: r.right - at.left, bottom: r.bottom - at.top }));
}

/** The labels and leader lines for the marks as drawn now (pointLabels.ts does the placing). */
function placedLabels(map: Map, points: readonly MissionFeature[], drones: readonly MissionFeature[], fitted: number | null): { labels: Feature[]; leaders: Feature[] } {
  const c = map.getContainer();
  const view = { left: 0, top: 0, right: c.clientWidth, bottom: c.clientHeight };
  const toneColor: Record<string, string> = {
    accent: cssVar("--accent", "#ff7a1a"), warn: cssVar("--warn", "#ffc48f"), ok: cssVar("--ok", "#7ee2a0"),
    info: cssVar("--accent-soft", "#ffb27a"), muted: cssVar("--text-3", "#8a8f98"), text: cssVar("--text", "#f2f2f0"),
    team: cssVar("--team", "#6ea8fe"), drone: cssVar("--drone", "#2ec4b6"), clue: cssVar("--clue", "#f5b544"), found: cssVar("--found", "#5fd38d"), alert: cssVar("--alert", "#f26b5e"),
  }; // prettier-ignore
  const ll = (f: MissionFeature) => f.geometry.coordinates as [number, number];
  const px = (f: MissionFeature) => map.project(ll(f));
  const camp = points.find((f) => f.properties.kind === "base");
  const teams = points.filter((f) => f.properties.kind === "team");
  const atBase = new Set(teamsAtBase(teams.map((f) => ({ id: f.properties.id, lon: ll(f)[0], lat: ll(f)[1] })), camp ? { lon: ll(camp)[0], lat: ll(camp)[1] } : null));
  const clueText = clueTextShown(map.getZoom(), fitted);
  const inputs: (PointLabelInput & { color: string; geo: [number, number] })[] = [];
  for (const f of points) {
    const k = f.properties.kind;
    const base = { id: `${k}:${f.properties.id}`, at: px(f), geo: ll(f) };
    if (k === "found") inputs.push({ ...base, kind: "found", text: f.properties.label, size: 13, required: true, color: toneColor.found! });
    else if (k === "lkp") inputs.push({ ...base, kind: "lkp", text: f.properties.label, required: true, color: toneColor.text! });
    else if (k === "base") inputs.push({ ...base, kind: "base", text: f.properties.label, color: toneColor.text! });
    else if (k === "team" && !atBase.has(f.properties.id)) inputs.push({ ...base, kind: "team", text: String(f.properties.short ?? f.properties.id), color: toneColor[f.properties.tone] ?? toneColor.text! });
    else if (k === "clue" && clueText) inputs.push({ ...base, kind: "clue", text: f.properties.label, color: toneColor.text! });
  }
  if (camp && atBase.size) {
    const shorts = teams.filter((f) => atBase.has(f.properties.id)).map((f) => String(f.properties.short ?? f.properties.id));
    inputs.push({ id: "team:at-base", kind: "team", text: atBaseText(shorts), at: px(camp), geo: ll(camp), color: toneColor.text! });
  }
  for (const f of drones) {
    inputs.push({ id: `drone:${f.properties.id}`, kind: "drone", text: `${f.properties.short ?? f.properties.id} ${f.properties.battery ?? ""}`.trim(), size: 13, at: px(f), geo: ll(f), color: f.properties.tone === "warn" ? toneColor.warn! : toneColor.drone! });
  }
  const icons = [...points, ...drones].map(px);
  const placed = layoutPointLabels(inputs, icons, view, overlayBoxes(c));
  const labels: Feature[] = [];
  const leaders: Feature[] = [];
  for (const l of inputs) {
    const p = placed.get(l.id);
    if (!p) continue;
    const size = l.size ?? 11;
    labels.push({ type: "Feature", properties: { text: l.text, anchor: p.anchor, offset: [p.offset[0] / size, p.offset[1] / size], size, color: l.color }, geometry: { type: "Point", coordinates: l.geo } });
    if (p.displaced) {
      const end = leaderEnd(l.at, p.box);
      const start = leaderStart(l.at, end);
      const a = map.unproject([start.x, start.y]);
      const b = map.unproject([end.x, end.y]);
      leaders.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[a.lng, a.lat], [b.lng, b.lat]] } });
    }
  }
  return { labels, leaders };
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
  /** Called once the map has its layers and has drawn them (a still stand-in can fade out then). */
  onReady?: () => void;
  /** The mission record: base camp and the find are drawn from it. */
  mission?: Mission | null;
  /** The sectors' tasks: a sector's label names the team in it. */
  tasks?: readonly { sector_id: string; state: string; team_id: string | null }[];
  /** The console's direct actions: a click in Task mode and a dropped T-card assign through these. */
  actions?: { assign: (team: string, sector: string) => void; droneLeg: (sector: string, drone?: string) => void };
  /** Where a candidate is (its pin and its photo's footprint): the map highlights the one in focus. */
  candidateAt?: (id: string) => CandidatePlace | null;
}

const TEAM_WORDS: Record<Team["status"], string> = { standby: "standby", assigned: "assigned", searching: "searching", returning: "returning", off_duty: "off duty", overdue: "overdue" };
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
      ? `Clues: ${clues.map((c) => `${c.kind}: ${plainWords(c.text)} (${c.reported_by === "command" ? "the command post" : callsign(c.reported_by)}, ${c.confirmed ? "confirmed" : "unconfirmed"})`).join("; ")}.`
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
  // the basemap in the theme's colours: a theme switch draws the map again in the other one
  const themeName = useTheme();
  const palettes = useMemo(() => consolePalettes(themeName), [themeName]);
  const style = useMemo(() => {
    const key = import.meta.env.VITE_MAPTILER_KEY?.trim() || undefined;
    return basemapStyle(chooseBasemapMode(key, navigator.onLine), key, readBasemapColors());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeName]);
  const center = useMemo<[number, number] | undefined>(() => (mapBase ? [mapBase.lkp.lon, mapBase.lkp.lat] : undefined), [mapBase]);
  const picking = usePick((s) => s.pending !== null);
  const [basemap, setBasemap] = useState<BasemapKind>("dark");
  const [evidence, setEvidence] = useState(true);
  if (!mapBase) return <p className="text-small text-text-3">The map appears once the mission has its search area.</p>;
  if (fill) {
    return (
      <figure aria-label="Live map" aria-describedby={describedBy} className={`relative h-full min-h-[360px] overflow-hidden rounded-lg border border-border ${ATTRIBUTION_CLASS}`}>
        {description}
        <MapProvider className="h-full w-full" initialCenter={center} initialZoom={15} mapStyle={style}>
          <LiveLayers base={mapBase} {...rest} onBasemap={setBasemap} onEvidence={setEvidence} />
        </MapProvider>
        {picking && (
          <p role="status" className="absolute right-3 top-3 z-10 rounded-full border border-accent bg-bg/85 px-3 py-1 text-small text-accent-soft">
            Click the map to place the clue (Esc cancels).
          </p>
        )}
        <FloatingLegend palette={palettes[basemap]} evidence={evidence} />
      </figure>
    );
  }
  return (
    <figure aria-label="Live map" aria-describedby={describedBy} className="flex flex-col gap-2">
      {description}
      <div className={`h-[420px] overflow-hidden rounded-lg border border-border ${ATTRIBUTION_CLASS}`}>
        <MapProvider className="h-full w-full" initialCenter={center} initialZoom={15} mapStyle={style}>
          <LiveLayers base={mapBase} {...rest} onBasemap={setBasemap} onEvidence={setEvidence} />
        </MapProvider>
      </div>
      {picking && (
        <p role="status" className="text-small text-accent-soft">
          Click the map to place the clue (Esc cancels).
        </p>
      )}
      <figcaption className="flex flex-col gap-1.5 text-small text-text-3">
        <HeatKeyRow palette={palettes[basemap]} evidence={evidence} />
        <MapLegend />
        <span>
          {HEAT_CAPTION}{" "}
          Each sector shows its share of the probability (POA).
        </span>
      </figcaption>
    </figure>
  );
}

/** The heat in words: the caption under the map and the floating legend's tooltip. */
export const HEAT_CAPTION =
  "Shading: where the estimated probability stands above an even spread, in three classes holding 50, 80 and 90 % of that extra (lighter on the dark map, redder on satellite: likelier); darker blue: ground a search lowered; no shading: about as likely as an even spread; hatched: no photo has looked there yet.";

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
 * The map's one legend, top left (away from the scrubber along the bottom): a small "Legend" pill, opened by
 * a click or the L key; open, the heat's line and the marks in two columns.
 */
export function FloatingLegend({ palette, evidence = true }: { updates?: number; palette?: HeatPalette; evidence?: boolean }) {
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
      className={`absolute top-3 left-3 z-10 flex max-h-[calc(100%-1.5rem)] max-w-[calc(100%-1.5rem)] flex-col overflow-y-auto border border-border bg-bg/90 backdrop-blur-[16px] ${open ? "rounded-md px-3 py-2" : "rounded-full px-2.5 py-1"}`}
      title={`${HEAT_CAPTION} Each sector shows its share of the probability (POA) and the team in it.`}
    >
      <div className="order-2 mt-2 flex flex-col gap-2" id={bodyId} hidden={!open}>
        <HeatKeyRow palette={palette} evidence={evidence} />
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
          <KeyHint>L</KeyHint>
        </button>
      </div>
    </figcaption>
  );
}

const Line = ({ className }: { className: string }) => <span className={`inline-block w-4 ${className}`} />;
const Mark = ({ name, className = "text-text" }: { name: IconName; className?: string }) => <Icon name={name} size={14} className={`shrink-0 ${className}`} />;

/** Eight lines: the fill legend lays them out as two columns of at most four. */
const LEGEND: readonly { key: string; title?: string; content: ReactNode }[] = [
  { key: "base", content: <><Mark name="base" />Base camp<Mark name="lkp" className="ml-2 text-accent" />Last known point</> },
  { key: "teams", content: <><Mark name="team" className="text-team" />Team out<Mark name="team" className="ml-2 text-alert" />overdue<Mark name="team" className="ml-2 text-text-3" />at base</> },
  { key: "drone", title: "Hover or focus a drone for its name, battery, link and when it was last heard", content: <><Mark name="drone" className="text-drone" />Drone, battery<Mark name="drone" className="ml-2 text-warn" />link degraded</> },
  { key: "clue", content: <><Mark name="clue" className="text-clue" />Clue<Mark name="found" className="ml-2 text-found" />Found</> },
  { key: "route", content: <><Line className="h-0.5 bg-drone" />Drone flight line<Line className="ml-2 h-0.5 bg-team" />team route</> },
  { key: "past", content: <><Line className="h-0.5 bg-text/20" />Flown<Line className="ml-2 border-t border-dashed border-drone" />planned</> },
  { key: "retask", content: <><Line className="border-t border-dashed border-text-2" />Sent elsewhere: where a drone turned</> },
  { key: "relay", content: <><Line className="border-t-2 border-dotted border-drone" />Relay: a drone carries a cut-off team</> },
];

/** What the console's legend says while nothing stands out of an even spread (a flat prior, no search yet). */
export const NO_EVIDENCE_LABEL = "No evidence yet: every cell as likely as the next, so nothing is shaded";

/** The unshaded ground on the console: about as likely as an even spread (never "empty"). */
export const EVEN_LABEL = "about as likely as an even spread";

/**
 * The heat in one line: the three classes, the two edges, searched ground and the hatch. With no evidence
 * (`evidence` false: nothing above or below an even spread) it says so instead of listing shades nobody sees.
 */
export function HeatKeyRow({ palette = CONSOLE_PALETTES.dark, evidence = true }: { palette?: HeatPalette; evidence?: boolean }) {
  const hatch = { background: "repeating-linear-gradient(135deg, transparent 0 3px, color-mix(in srgb, var(--text) 45%, transparent) 3px 4px)" };
  return (
    <ul aria-label="Probability classes" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-text-2">
      {evidence ? (
        <>
          <li className="flex items-center gap-1.5 whitespace-nowrap" title={`Lighter is likelier. ${CLASS_ROWS.map((r) => `${r.label}: ${r.hint}`).join(". ")}, of the probability above an even spread.`}>
            {[...CLASS_ROWS].reverse().map((r) => (
              <span key={r.key} aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: swatchColor(palette[r.key]) }} />
            ))}
            Likelier than even: 90 · 80 · 50 % of the extra
          </li>
          <li className="flex items-center gap-1.5 whitespace-nowrap">
            <ContourGlyph line={palette.contour50} casing={palette.casing} />
            50 % edge
            <ContourGlyph line={palette.contour90} casing={palette.casing} className="ml-2" />
            90 % edge
          </li>
          {palette.searched && (
            <li className="flex items-center gap-1.5 whitespace-nowrap">
              <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px] ring-1 ring-border" style={{ background: swatchColor(palette.searched) }} />
              Darker: searched, lowered
            </li>
          )}
          <li className="flex items-center gap-1.5 whitespace-nowrap">
            <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px] ring-1 ring-border" />
            No shading: {EVEN_LABEL}
          </li>
        </>
      ) : (
        <li className="flex items-center gap-1.5 whitespace-nowrap">
          <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px] ring-1 ring-border" />
          {NO_EVIDENCE_LABEL}
        </li>
      )}
      <li className="flex items-center gap-1.5 whitespace-nowrap">
        <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px] ring-1 ring-border" style={hatch} />
        Hatched: not photographed yet
      </li>
    </ul>
  );
}

/** What the map's marks mean: the icons LiveLayers draws for each kind and tone. `columns`: two columns, four lines. */
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

/** Two cell-kind pictures are the same (or both missing). */
export function sameKinds(a: ArrayLike<number> | null, b: ArrayLike<number> | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
