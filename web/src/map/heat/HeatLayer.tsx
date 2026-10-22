// Lane C's map overlay: heat cells, sectors, surveyed outline, step slider, "search next", legend,
// found banner. Mount it through B's MapView: <MapView layers={<HeatLayer />} />.
// variant="review" is the quiet version beside the review queue: the same live heat (fainter, under
// the pins), the review ripple and a small readout, without the replay and the side panel.
import { type ReactNode, useContext, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MapLayerMouseEvent, MapMouseEvent } from "maplibre-gl";
import type { CacheBundle } from "../../contract";
import type { CandidateShare } from "../../search/update";
import { CacheContext, useCache } from "../../lib/cache";
import { useReview, type HistoryEntry } from "../../review/store";
import { prefersReducedMotion } from "../../metrics/motion";
import { detectionById, effectiveAnswers, heldCells, stateAtStep, useSearch } from "../../search/store";
import { Panel } from "../../shell/components";
import { useMap, type MapContextValue } from "../MapView";
import { flownFrames } from "../base/features";
import { OVERLAY_ATTR, readOverlays } from "../base/camera";
import { placeLabel } from "./labelPlacement";
import { FoundBanner } from "./FoundBanner";
import { likelyPatches, probabilityShares } from "./geometry";
import { cellKinds, surfaceData } from "./classes";
import { basemapKind, type BasemapKind, HEAT_PALETTES, muteImagery } from "./palette";
import { pushSurface, setSurfaceMode, setSurfacePalette } from "./surface";
import {
  buildOverlapIndex,
  eligibleCells,
  firstPhotographedStep,
  frameOverlaps,
  overlapAtStep,
  photographedCells,
} from "./coverage";
import { ensureDroneImage } from "./droneImage";
import { ensureHotspotBadges } from "./hotspotImages";
import {
  breathFactor,
  ensureHeatLayers,
  HEAT_BASE_OPACITY,
  HEAT_SURFACE_IDS,
  heatTheme,
  HOTSPOT_HIT_LAYERS,
  type HeatVariant,
  pushHotspots,
  pushRipple,
  pushSectorLabels,
  pushSectors,
  type PlaceLabel,
  raiseLkp,
  readHeatColors,
  refreshHeatSource,
  RIPPLE_MS,
  setActiveHotspot,
  setBreath,
  setHotspotPulse,
  setFlightPathVisible,
  setCandidateBoundary,
  setHeldBoundary,
  setRippleFrame,
  setSurveyedBoundary,
  setUnsureBoundary,
} from "./layers";
import { classSwatches, Legend } from "./Legend";
import { SimulatedLine, simulatedLineFor } from "../base/SimulatedLine";
import { NextSearch } from "./NextSearch";
import { PanelSlotContext, ROOMY_LAYOUT_QUERY, useMediaQuery, WIDE_LAYOUT_QUERY } from "./panelSlot";
import { HeatRaster, kindColors, kindPixels, sweepDelays } from "./raster";
import { SectorList } from "./SectorList";
import {
  candidateMask,
  cellAt,
  sectorsWithSightings,
  sightingAreaText,
  sightingAtCell,
  sightingOf,
  sightingReading,
  withoutCandidates,
} from "./sightings";
import { buildSectors, currentSector, rankSectors, sectorBounds, sectorName, sectorStatuses } from "./sectors";
import { StepSlider } from "./StepSlider";
import { REPLAY_HEAT_TWEEN_MS, useFlightReplay } from "./useFlightReplay";
import { unsureMask, unsureReadoutText } from "./unsure";

type PanelTab = "legend" | "sectors" | "next";
/** The segmented control above the panels on narrow screens: where to search next comes first. */
const PANEL_TABS: readonly { id: PanelTab; label: string }[] = [
  { id: "next", label: "Search next" },
  { id: "sectors", label: "Sectors" },
  { id: "legend", label: "Legend" },
];

/**
 * Panels floating over the map use a thicker, darker material than the shell's glass: the pale end
 * of the heat ramp under a 5 % white glass left their secondary text unreadable (Apple HIG,
 * Materials: thicker materials give better contrast for text over bright content).
 */
const OVER_MAP = "bg-bg/90!";

/** How long an answer's change to the map takes to settle, and the Search next build-up. */
export const ANSWER_TWEEN_MS = 650;
export const BUILD_UP_MS = 1500;
/** Share of the build-up timeline each cell takes to fade in (the rest is its place in the flight). */
export const BUILD_UP_FADE = 0.2;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** useMap() without throwing, so a mount outside MapProvider renders nothing instead of crashing. */
function useOptionalMap(): MapContextValue | null {
  try {
    return useMap();
  } catch {
    return null;
  }
}

const frameIndexes = new WeakMap<CacheBundle["detections"], Map<string, string>>();

/** The frame a detection was found in (detections.json is keyed by frame). */
export function frameOfDetection(detections: CacheBundle["detections"], detectionId: string): string | undefined {
  let index = frameIndexes.get(detections);
  if (!index) {
    index = new Map();
    for (const [frameId, list] of Object.entries(detections.frames)) for (const d of list) index.set(d.id, frameId);
    frameIndexes.set(detections, index);
  }
  return index.get(detectionId);
}

function isUsableMapFile(bundle: CacheBundle): boolean {
  const m = bundle.map;
  return Boolean(m?.grid && m.prior?.p && m.prior.p.length === m.grid.rows * m.grid.cols && m.steps);
}

export function HeatLayer({ variant = "search" }: { variant?: HeatVariant }) {
  const provided = useContext(CacheContext);
  const stored = useCache((s) => s.data);
  const status = useCache((s) => s.status);
  const bundle = provided ?? stored;
  const mapCtx = useOptionalMap();

  if (!mapCtx) return null;
  if (!bundle) {
    return (
      <Overlay>
        <Panel className="pointer-events-auto absolute left-3 top-3 text-small text-text-2" role="status">
          {status === "error" ? "Search map could not be loaded." : "Loading search map…"}
        </Panel>
      </Overlay>
    );
  }
  if (!isUsableMapFile(bundle)) {
    return (
      <Overlay>
        <Panel className="pointer-events-auto absolute left-3 top-3 text-small text-text-2" role="alert">
          map.json is missing or does not match its grid; no search map to show.
        </Panel>
      </Overlay>
    );
  }
  return <HeatOverlay bundle={bundle} mapCtx={mapCtx} variant={variant} />;
}

/**
 * Sector label placement on the live map: a label goes where its text box is fully inside the map and
 * clear of every panel drawn over it (marked with OVERLAY_ATTR), or is hidden (labelPlacement.ts).
 */
function livePlacement(map: MapContextValue["map"]): PlaceLabel | undefined {
  if (!map) return undefined;
  try {
    const container = map.getContainer();
    const c = container.getBoundingClientRect();
    if (!(c.width > 0 && c.height > 0)) return undefined;
    const view = { left: 0, top: 0, right: c.width, bottom: c.height };
    const blockers = readOverlays(container.parentElement).map(({ rect }) => ({
      left: rect.left - c.left,
      top: rect.top - c.top,
      right: rect.right - c.left,
      bottom: rect.bottom - c.top,
    }));
    return (candidates, text) => placeLabel(candidates, text, (at) => map.project(at), view, blockers);
  } catch {
    return undefined;
  }
}

/** Mark a panel drawn over the map, so the camera frames around it and labels avoid it (camera.ts). */
const overlay = (side: "left" | "right" | "top" | "bottom" | "corner") => ({ [OVERLAY_ATTR]: side });

function Overlay({ children }: { children: ReactNode }) {
  return <div className="pointer-events-none absolute inset-0 z-10">{children}</div>;
}

/** The answer that changed between two histories (appended, or removed by undo), or null (reset, reload). */
export function changedEntry(prev: readonly HistoryEntry[], next: readonly HistoryEntry[]): HistoryEntry | null {
  if (next.length === prev.length + 1) return next.at(-1) ?? null;
  if (next.length === prev.length - 1) return prev.at(-1) ?? null;
  return null;
}

const pct2 = (x: number) => `${(x * 100).toFixed(2)}%`;

function HeatOverlay({ bundle, mapCtx, variant }: { bundle: CacheBundle; mapCtx: MapContextValue; variant: HeatVariant }) {
  const { map, flyTo } = mapCtx;
  const isSearch = variant === "search";
  const mapFile = bundle.map;
  const grid = mapFile.grid;
  const bind = useSearch((s) => s.bind);
  const data = useSearch((s) => s.data);
  const state = useSearch((s) => s.state);
  const stepIndex = useSearch((s) => s.stepIndex);
  const stepCount = useSearch((s) => s.stepCount);
  const setStepIndex = useSearch((s) => s.setStepIndex);
  const foundDetectionId = useSearch((s) => s.foundDetectionId);
  const sightings = useSearch((s) => s.sightings);
  const unsureAreas = useSearch((s) => s.unsure);
  // Follows the system setting live, so the build-up (and its Skip pill) never runs under reduced motion.
  const reduced = useMediaQuery(REDUCED_MOTION_QUERY, prefersReducedMotion());

  useEffect(() => {
    bind({ map: bundle.map, detections: bundle.detections });
    // Review happens after the whole flight: show every frame, whatever the replay was left at.
    if (!isSearch) setStepIndex(bundle.map.steps.length);
  }, [bind, bundle.map, bundle.detections, isSearch, setStepIndex]);

  const frames = useMemo(
    () => [...bundle.survey.frames].sort((a, b) => a.flight_index - b.flight_index),
    [bundle.survey.frames],
  );
  // Frames in step order (map.json steps are in flight order; matched by id).
  const stepFrames = useMemo(() => {
    const byId = new Map(bundle.survey.frames.map((f) => [f.id, f]));
    return mapFile.steps.flatMap((s) => {
      const f = byId.get(s.frame_id);
      return f ? [f] : [];
    });
  }, [bundle.survey.frames, mapFile.steps]);

  // Per cell, the largest share of it inside any one of the first `stepIndex` photos (coverage.ts):
  // precomputed once per survey, then cheap per step.
  const overlapIndex = useMemo(
    () =>
      buildOverlapIndex(frameOverlaps(grid, bundle.survey.frames.map((f) => f.footprint)), grid.rows * grid.cols, "max"),
    [grid, bundle.survey.frames],
  );
  const firstStep = useMemo(() => firstPhotographedStep(overlapIndex), [overlapIndex]);
  const overlap = useMemo(() => overlapAtStep(overlapIndex, stepIndex), [overlapIndex, stepIndex]);
  const covered = useMemo(() => photographedCells(overlap), [overlap]);
  // The panels, the sectors and the search-next circles follow the replay at a lower priority than
  // the heat, so a commit during play never holds up the drone's next animation frame.
  const panelState = useDeferredValue(state);
  const panelOverlap = useDeferredValue(overlap);
  const panelCovered = useDeferredValue(covered);
  const history = useReview((s) => s.history);
  const held = useMemo(
    () => heldCells({ map: mapFile, detections: bundle.detections }, history),
    [mapFile, bundle.detections, history],
  );
  const hasSurveyed = useMemo(() => covered.some((c) => c === 1), [covered]);
  const path = useMemo(() => stepFrames.map((f) => [f.pose.lon, f.pose.lat] as [number, number]), [stepFrames]);
  const ready = data?.map === mapFile && state !== null;

  // Hover (or tap) a candidate sighting's area or pin: its reading in a small card by the pointer.
  const [hoverSighting, setHoverSighting] = useState<{ sighting: CandidateShare; x: number; y: number; flip: boolean } | null>(
    null,
  );
  const sightingsRef = useRef(sightings);
  sightingsRef.current = ready ? sightings : [];
  useEffect(() => {
    if (!map) return undefined;
    const at = (e: MapMouseEvent) => {
      const s = sightingAtCell(sightingsRef.current, cellAt(grid, [e.lngLat.lng, e.lngLat.lat]));
      if (!s) return setHoverSighting(null);
      let width = 0;
      try {
        width = map.getContainer().clientWidth;
      } catch {
        /* map gone */
      }
      setHoverSighting({ sighting: s, x: e.point.x, y: e.point.y, flip: width > 0 && e.point.x > width - 300 });
    };
    const leave = () => setHoverSighting(null);
    map.on?.("mousemove", at);
    map.on?.("click", at);
    map.on?.("mouseout", leave);
    return () => {
      map.off?.("mousemove", at);
      map.off?.("click", at);
      map.off?.("mouseout", leave);
    };
  }, [map, grid]);
  useEffect(() => {
    // An undone or not-yet-flown sighting closes its card.
    setHoverSighting((h) => (h && !sightings.some((s) => s.cells.includes(h.sighting.cells[0] ?? -1)) ? null : h));
  }, [sightings]);

  // Candidate sightings (flown "Person" answers): drawn darkest and ringed, not as awaiting review.
  const candidate = useMemo(() => candidateMask(grid.rows * grid.cols, ready ? sightings : []), [grid, ready, sightings]);
  const heldShown = useMemo(() => withoutCandidates(held, candidate), [held, candidate]);
  // Flown "Unsure" answers: still held (same raster look), but ringed in amber instead of the dashed
  // "awaiting review" outline, so an unresolved area is not overlooked. The map itself is unchanged.
  const shownUnsure = useMemo(() => (ready ? (unsureAreas ?? []) : []), [ready, unsureAreas]);
  const unsure = useMemo(() => unsureMask(grid.rows * grid.cols, shownUnsure), [grid, shownUnsure]);
  const heldOutline = useMemo(() => withoutCandidates(heldShown, unsure), [heldShown, unsure]);

  // Sectors (computed in the browser; see sectors.ts).
  const sectorLayout = useMemo(() => buildSectors(grid, frames), [grid, frames]);
  const sightedSectors = useMemo(
    () => sectorsWithSightings(sectorLayout.cellSector, sectorLayout.sectors.map((s) => s.id), candidate),
    [sectorLayout, candidate],
  );
  const unsureSectors = useMemo(
    () => sectorsWithSightings(sectorLayout.cellSector, sectorLayout.sectors.map((s) => s.id), unsure),
    [sectorLayout, unsure],
  );
  // Each click on the Search next list's unsure entry flies to the next unsure area.
  const unsureCursor = useRef(0);
  const statuses = useMemo(
    () => (ready && panelState ? sectorStatuses(sectorLayout, panelState, panelCovered) : []),
    [ready, panelState, sectorLayout, panelCovered],
  );
  const currentId = isSearch ? (currentSector(sectorLayout, stepIndex, stepCount)?.id ?? null) : null;
  const [hoverId, setHoverId] = useState<string | null>(null);
  // Narrow screens: the panels go below the map (see panelSlot.ts).
  const slot = useContext(PanelSlotContext);
  const wide = useMediaQuery(WIDE_LAYOUT_QUERY, true);
  const panelSlot = isSearch && !wide ? slot : null;
  const [panelTab, setPanelTab] = useState<PanelTab>("next");
  // Below 1280 px the floating legend folds into a pill, so it does not cover the photographed area.
  const roomy = useMediaQuery(ROOMY_LAYOUT_QUERY, true);
  const [legendOpen, setLegendOpen] = useState(false);
  const legendPillRef = useRef<HTMLButtonElement>(null);

  // Search patches are calculated once and shared by the map and panel, so their ranks cannot drift.
  const patchSet = useMemo(
    () =>
      isSearch && ready && panelState
        ? likelyPatches(grid, panelState.p, eligibleCells(panelOverlap, held), {
            canopy: mapFile.canopy,
            cellSector: sectorLayout.cellSector,
          })
        : { patches: [], surveyedProbability: 0, meanProbability: 0, otherShare: 0 },
    [isSearch, ready, panelState, panelOverlap, held, grid, mapFile.canopy, sectorLayout.cellSector],
  );
  const hotspots = patchSet.patches;

  // A search-next circle hovered (map or list) or picked (click on either): ringed on the map and
  // highlighted in the list. Hover wins while it lasts.
  const [hoverHot, setHoverHot] = useState<number | null>(null);
  const [pickedHot, setPickedHot] = useState<number | null>(null);
  const activeHot = [hoverHot, pickedHot].find((i) => i !== null && hotspots.some((patch) => patch.id === i)) ?? null;
  const activeHotRef = useRef(activeHot);
  activeHotRef.current = activeHot;

  // --- the probability surface ----------------------------------------------------------------
  // Classes by probability mass (classes.ts), coloured for the basemap under them (palette.ts): the
  // raster while it animates, GeoJSON fills and contours at rest (surface.ts).
  const [basemap, setBasemap] = useState<BasemapKind>("dark");
  const palette = HEAT_PALETTES[basemap];
  const theme = useMemo(() => heatTheme(readHeatColors()), []);
  const colors = useMemo(() => kindColors(palette, theme), [palette, theme]);
  const raster = useMemo(() => new HeatRaster(grid), [grid]);
  const kinds = useMemo(
    () => (ready && state ? cellKinds(state.p, covered, heldShown, candidate) : null),
    [ready, state, covered, heldShown, candidate],
  );
  const pixels = useMemo(() => (kinds ? kindPixels(kinds, colors) : null), [kinds, colors]);
  const surface = useMemo(() => (kinds ? surfaceData(grid, kinds) : null), [grid, kinds]);
  const [building, setBuilding] = useState(false);
  const appliedPalette = useRef<BasemapKind | null>(null);

  // The latest values, for the style-reload installer.
  const latest = useRef({ covered, heldOutline, candidate, unsure, hotspots, statuses, currentId, hoverId, surface, palette });
  latest.current = { covered, heldOutline, candidate, unsure, hotspots, statuses, currentId, hoverId, surface, palette };
  const [showPath, setShowPath] = useState(true);
  const showPathRef = useRef(showPath);
  showPathRef.current = showPath;
  // The flight replay: one animation clock for the drone, the trail, the photo highlight and the
  // slider's thumb; the store's step is committed a few times a second (useFlightReplay.ts).
  const footprints = useMemo(() => stepFrames.map((f) => f.footprint), [stepFrames]);
  const replay = useFlightReplay({ map, enabled: isSearch, path, footprints, stepIndex, stepCount, setStepIndex, reduced });
  const playingRef = useRef(replay.playing);
  playingRef.current = replay.playing;
  const redrawReplayRef = useRef(replay.redraw);
  redrawReplayRef.current = replay.redraw;

  useEffect(() => {
    if (!map) return undefined;
    raster.setOnDraw((playing) => {
      try {
        refreshHeatSource(map, playing);
        // While it moves the raster shows; at rest the fills and contours of the same picture. The
        // replay keeps the raster between its tweens (its fills are pushed at the pause).
        setSurfaceMode(map, HEAT_SURFACE_IDS, playing || playingRef.current ? "raster" : "vector");
      } catch {
        /* style reloading; install() pushes again */
      }
    });
    return () => raster.stop();
  }, [map, raster]);

  // The imagery is muted while the heat is on the map, and put back when it goes.
  useEffect(() => {
    if (!map) return undefined;
    return () => {
      try {
        muteImagery(map, false);
      } catch {
        /* map gone */
      }
    };
  }, [map]);

  // The fills and contours follow every new picture. While the replay plays only the raster shows,
  // so they wait for the pause (saves a GeoJSON re-tile every commit).
  const replayPlaying = replay.playing;
  useEffect(() => {
    if (!map || !surface || replayPlaying) return;
    try {
      pushSurface(map, HEAT_SURFACE_IDS, surface);
      // Paused with the raster at rest: hand over once these fills are drawn.
      if (!raster.animating) setSurfaceMode(map, HEAT_SURFACE_IDS, "vector");
    } catch {
      /* style reloading; install() pushes again */
    }
  }, [map, raster, surface, replayPlaying]);

  // Install the layers once the style is ready, and again whenever a style reload drops them.
  useEffect(() => {
    if (!map) return undefined;
    const install = () => {
      try {
        const colors = readHeatColors();
        const now = latest.current;
        // The palette follows the basemap: a switch reloads the style and lands here.
        const kind = basemapKind(map);
        const palette = HEAT_PALETTES[kind];
        const opacity = HEAT_BASE_OPACITY[variant];
        // Runs on every styledata (any style change, the breath's too): the palette is set again only
        // after a basemap switch, the fills only when a reload dropped them, and muting the imagery
        // twice changes nothing (MapLibre ignores a paint value equal to the current one).
        const added = ensureHeatLayers(map, raster, grid, now.covered, colors, variant, palette, raster.animating ? "raster" : "vector");
        if (added || appliedPalette.current !== kind) {
          setSurfacePalette(map, HEAT_SURFACE_IDS, palette, heatTheme(colors), opacity);
          appliedPalette.current = kind;
        }
        muteImagery(map, true);
        if (added && now.surface) pushSurface(map, HEAT_SURFACE_IDS, now.surface);
        if (kind !== now.palette.kind) setBasemap(kind);
        if (isSearch) {
          ensureDroneImage(map, colors.outline);
          ensureHotspotBadges(map, { accent: colors.accent, veil: colors.veil });
        }
        refreshHeatSource(map, raster.animating);
        setHeldBoundary(map, grid, now.covered, now.heldOutline);
        setCandidateBoundary(map, grid, now.candidate);
        setUnsureBoundary(map, grid, now.unsure);
        pushSectors(map, grid, now.statuses, now.currentId, now.hoverId, livePlacement(map));
        if (isSearch) {
          setSurveyedBoundary(map, grid, now.covered);
          setFlightPathVisible(map, showPathRef.current);
          pushHotspots(map, grid, now.hotspots);
          setActiveHotspot(map, activeHotRef.current);
          raiseLkp(map);
          redrawReplayRef.current();
        }
      } catch {
        // Style not ready yet; the next 'styledata' or 'load' event tries again.
      }
    };
    const onStyleData = () => {
      if (map.isStyleLoaded()) install();
    };
    if (map.isStyleLoaded()) install();
    else map.once("load", install);
    map.on("styledata", onStyleData);
    return () => {
      map.off("load", install);
      map.off("styledata", onStyleData);
    };
  }, [map, raster, grid, variant, isSearch]);

  // Recolour: build up on first show (Search next), tween after an answer, jump when scrubbing.
  const shownOnce = useRef(false);
  const prevHistory = useRef(history);
  const prevStep = useRef(stepIndex);
  useEffect(() => {
    if (!pixels || !state) return;
    const historyChanged = prevHistory.current !== history;
    const stepChanged = prevStep.current !== stepIndex;
    prevHistory.current = history;
    prevStep.current = stepIndex;
    if (!shownOnce.current) {
      shownOnce.current = true;
      if (reduced) {
        raster.show(pixels);
      } else if (isSearch) {
        // Cells sweep in from "not yet searched" in the order the flight photographed them.
        const from = kindPixels(cellKinds(state.p, new Uint8Array(covered.length), heldShown, candidate), colors);
        setBuilding(true);
        raster.animate(pixels, { durationMs: BUILD_UP_MS, delays: sweepDelays(firstStep, stepCount), fade: BUILD_UP_FADE }, from);
      } else {
        raster.animate(pixels, { durationMs: ANSWER_TWEEN_MS }, new Uint8ClampedArray(pixels.length));
      }
      return;
    }
    setBuilding(false);
    if (historyChanged && !stepChanged && !reduced) raster.animate(pixels, { durationMs: ANSWER_TWEEN_MS });
    // Playing: the heat flows from one commit to the next instead of stepping (from what is on screen).
    else if (stepChanged && playingRef.current && !reduced) raster.animate(pixels, { durationMs: REPLAY_HEAT_TWEEN_MS });
    else raster.show(pixels);
    // Only a new picture starts an animation; the refs above say why it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pixels]);

  // The build-up ends by itself; any interaction with the map finishes it at once, and so does
  // switching reduced motion on.
  useEffect(() => {
    if (!building) return undefined;
    if (reduced) {
      raster.finish();
      setBuilding(false);
      return undefined;
    }
    const end = window.setTimeout(() => setBuilding(false), BUILD_UP_MS + 50);
    const skip = () => {
      raster.finish();
      setBuilding(false);
    };
    const events = ["mousedown", "wheel", "touchstart"] as const;
    for (const e of events) map?.on?.(e, skip);
    window.addEventListener("keydown", skip);
    return () => {
      window.clearTimeout(end);
      for (const e of events) map?.off?.(e, skip);
      window.removeEventListener("keydown", skip);
    };
  }, [building, map, raster, reduced]);

  // A ripple at the pin that was just answered (or undone).
  useEffect(() => {
    return useReview.subscribe((next, prev) => {
      if (!map || next.history === prev.history || reduced) return;
      const entry = changedEntry(prev.history, next.history);
      const detection = entry ? detectionById(bundle.detections, entry.detectionId) : undefined;
      if (!entry || !detection) return;
      const colors = readHeatColors();
      const undone = next.history.length < prev.history.length;
      const color = undone
        ? colors.outline
        : entry.answer === "person"
          ? colors.ok
          : entry.answer === "unsure"
            ? colors.review
            : colors.outline;
      try {
        pushRipple(map, [detection.lon, detection.lat], color);
      } catch {
        return;
      }
      const start = performance.now();
      const tick = (now: number) => {
        const t = (now - start) / RIPPLE_MS;
        try {
          setRippleFrame(map, t);
          if (t < 1) requestAnimationFrame(tick);
          else pushRipple(map, null, color);
        } catch {
          /* map gone */
        }
      };
      requestAnimationFrame(tick);
    });
  }, [map, bundle.detections, reduced]);

  useEffect(() => {
    if (!map) return;
    try {
      setHeldBoundary(map, grid, covered, heldOutline);
      setCandidateBoundary(map, grid, candidate);
      setUnsureBoundary(map, grid, unsure);
    } catch {
      /* style reloading */
    }
  }, [map, grid, covered, heldOutline, candidate, unsure]);

  // The outline follows the photographed cells.
  useEffect(() => {
    if (!map || !isSearch) return;
    try {
      setSurveyedBoundary(map, grid, covered);
    } catch {
      /* style reloading; install() draws it */
    }
  }, [map, grid, covered, isSearch]);

  useEffect(() => {
    if (!map) return;
    try {
      pushSectors(map, grid, statuses, currentId, hoverId, livePlacement(map));
    } catch {
      /* style reloading */
    }
  }, [map, grid, statuses, currentId, hoverId]);

  // Re-place the sector labels as the camera moves (once per frame at most), so none is drawn
  // half off the map or under a panel.
  useEffect(() => {
    if (!map) return undefined;
    let frame = 0;
    const replace = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const now = latest.current;
        try {
          pushSectorLabels(map, grid, now.statuses, now.currentId, now.hoverId, livePlacement(map));
        } catch {
          /* style reloading */
        }
      });
    };
    map.on?.("move", replace);
    map.on?.("resize", replace);
    return () => {
      cancelAnimationFrame(frame);
      map.off?.("move", replace);
      map.off?.("resize", replace);
    };
  }, [map, grid]);

  // The legend switch; re-applied by install() after a basemap switch rebuilds lane B's layers.
  useEffect(() => {
    if (!map || !isSearch) return;
    try {
      setFlightPathVisible(map, showPath);
    } catch {
      /* style reloading; install() applies it again */
    }
  }, [map, showPath, isSearch]);

  useEffect(() => {
    if (!map || !isSearch) return;
    try {
      pushHotspots(map, grid, hotspots);
    } catch {
      /* style reloading; the next push redraws it */
    }
  }, [map, grid, hotspots, isSearch]);

  useEffect(() => {
    if (!map || !isSearch) return;
    try {
      setActiveHotspot(map, activeHot);
    } catch {
      /* style reloading; install() applies it again */
    }
  }, [map, isSearch, activeHot]);

  // Hover and click on a circle (its casing or its badge) highlight its row in the list.
  useEffect(() => {
    if (!map || !isSearch) return undefined;
    const idxOf = (e: MapLayerMouseEvent) => {
      const v = e.features?.[0]?.properties?.idx;
      return typeof v === "number" ? v : null;
    };
    const enter = (e: MapLayerMouseEvent) => {
      setHoverHot(idxOf(e));
      try {
        map.getCanvas().style.cursor = "pointer";
      } catch {
        /* map gone */
      }
    };
    const leave = () => {
      setHoverHot(null);
      try {
        map.getCanvas().style.cursor = "";
      } catch {
        /* map gone */
      }
    };
    const pick = (e: MapLayerMouseEvent) => setPickedHot(idxOf(e));
    for (const id of HOTSPOT_HIT_LAYERS) {
      map.on?.("mousemove", id, enter);
      map.on?.("mouseleave", id, leave);
      map.on?.("click", id, pick);
    }
    return () => {
      for (const id of HOTSPOT_HIT_LAYERS) {
        map.off?.("mousemove", id, enter);
        map.off?.("mouseleave", id, leave);
        map.off?.("click", id, pick);
      }
    };
  }, [map, isSearch]);

  // Breathing: a slow, small pulse of the heat, and the first search-next circle's pulse ring (Search
  // next only). Off for reduced motion, paused while the tab is hidden, about 20 updates a second;
  // only raster-opacity and the pulse ring's paint change.
  useEffect(() => {
    if (!map || !isSearch || reduced) return undefined;
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (document.hidden || now - last < 50) return;
      last = now;
      try {
        setBreath(map, breathFactor(now), HEAT_BASE_OPACITY.search, palette, theme);
        // The first search-next circle pulses gently (hidden while the drone flies).
        setHotspotPulse(map, now);
      } catch {
        /* style reloading */
      }
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      try {
        setBreath(map, 1, HEAT_BASE_OPACITY.search, palette, theme);
        setHotspotPulse(map, null);
      } catch {
        /* map gone */
      }
    };
  }, [map, isSearch, reduced, palette, theme]);

  // Candidate sighting cells are not "photographed and cleared": the readout leaves them out.
  const coveredClear = useMemo(() => withoutCandidates(panelCovered, candidate), [panelCovered, candidate]);
  const shares = useMemo(
    () => (ready && panelState ? probabilityShares(panelState, coveredClear) : null),
    [ready, panelState, coveredClear],
  );
  // Before any review answer: the same step with no answers (from the store's own inputs). Review only.
  const baseShares = useMemo(
    () => (!isSearch && ready && data ? probabilityShares(stateAtStep(data.map, stepIndex), coveredClear) : null),
    [isSearch, ready, data, stepIndex, coveredClear],
  );
  // Every detection whose latest answer is "Person" and whose photo the replay has flown, newest first.
  const flown = useMemo(() => flownFrames(mapFile.steps, stepIndex), [mapFile.steps, stepIndex]);
  const finds = useMemo(
    () =>
      foundDetectionId
        ? effectiveAnswers(history)
            .filter((e) => e.answer === "person")
            .reverse()
            .flatMap((e) => {
              const d = detectionById(bundle.detections, e.detectionId);
              const frameId = d ? frameOfDetection(bundle.detections, d.id) : undefined;
              return d && (!flown || (frameId !== undefined && flown.has(frameId))) ? [d] : [];
            })
        : [],
    [foundDetectionId, history, bundle.detections, flown],
  );
  // Below the map (narrow screens) a list click also brings the map back into view.
  const flyToPoint = (lon: number, lat: number) => {
    flyTo(lon, lat, 18);
    if (panelSlot) {
      try {
        map?.getContainer().scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
      } catch {
        /* map gone */
      }
    }
  };
  const flyToSector = (sectorId: string) => {
    const s = sectorLayout.sectors.find((x) => x.id === sectorId);
    if (!s || !map) return;
    try {
      map.fitBounds(sectorBounds(grid, s), { padding: 64, duration: reduced ? 0 : 800 });
      if (panelSlot) map.getContainer().scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
    } catch {
      /* map gone */
    }
  };

  const sightingCard = hoverSighting && (
    <div
      role="tooltip"
      data-testid="sighting-card"
      className={`pointer-events-none absolute z-20 w-64 rounded-[var(--radius-sm)] border border-ok/60 p-3 text-small shadow-lg backdrop-blur-md ${OVER_MAP}`}
      style={{
        left: hoverSighting.x,
        top: hoverSighting.y,
        transform: `translate(${hoverSighting.flip ? "calc(-100% - 14px)" : "14px"}, 14px)`,
      }}
    >
      <p className="text-text">{sightingReading(hoverSighting.sighting, sightings.length)}</p>
      <p className="mt-1 text-label text-text-2">{sightingAreaText(hoverSighting.sighting)}</p>
    </div>
  );

  if (!isSearch) {
    const answered = shares !== null && baseShares !== null && Math.abs(baseShares.surveyed - shares.surveyed) > 1e-12;
    return (
      <Overlay>
        <Panel {...overlay("corner")} className={`sl-rise pointer-events-auto absolute bottom-7 right-3 w-64 p-3 shadow-[0_16px_40px_-20px_rgba(0,0,0,0.9)] ${OVER_MAP}`}>
          <div className="flex flex-col gap-3">
            {shares && baseShares ? (
              <div className="flex flex-col gap-1" aria-live="polite">
                <span className="text-small text-text-2">Probability on photographed ground</span>
                <span className="font-mono text-body text-text" data-testid="review-readout">
                  {answered
                    ? `${pct2(baseShares.surveyed)} → ${pct2(shares.surveyed)}`
                    : pct2(shares.surveyed)}
                </span>
                <span className="text-label text-text-2">
                  {answered ? "Before review → now. " : ""}Each &ldquo;Not a person&rdquo; lowers it around that pin.
                </span>
                {sightings.length > 0 && (
                  <span className="text-label text-ok" data-testid="review-sightings">
                    {sightings.length === 1 ? "1 candidate sighting" : `${sightings.length} candidate sightings`}, not counted
                    as cleared: send a ground team to check.
                  </span>
                )}
                {shownUnsure.length > 0 && (
                  <span className="text-label text-warn" data-testid="review-unsure">
                    {unsureReadoutText(shownUnsure.length)}
                  </span>
                )}
              </div>
            ) : (
              <span className="text-small text-text-2" role="status">
                Computing search map…
              </span>
            )}
            <Legend
              compact
              simulatedPath={bundle.survey.simulated_path}
              hasSurveyed={hasSurveyed}
              hasSightings={sightings.length > 0}
              hasUnsure={shownUnsure.length > 0}
              palette={palette}
            />
            {/* Review's map is narrow: its one simulated line lives here, not in a corner the card covers. */}
            <SimulatedLine {...simulatedLineFor(bundle)} plain />
          </div>
        </Panel>
        {sightingCard}
      </Overlay>
    );
  }

  const foundBanner = finds.length > 0 && (
    <FoundBanner
      finds={finds}
      simulatedRadius={bundle.survey.simulated_path}
      onFlyTo={(f) => flyToPoint(f.lon, f.lat)}
      readingFor={(id) => {
        const s = sightingOf(sightings, id);
        return s ? `${sightingReading(s, sightings.length)}. ${sightingAreaText(s)}.` : undefined;
      }}
    />
  );
  const computing = (
    <span className="text-small text-text-2" role="status">
      Computing search map…
    </span>
  );
  const sectorList =
    ready && state && shares ? (
      <SectorList
        statuses={statuses}
        outside={shares.outside}
        currentId={currentId}
        hoverId={hoverId}
        onHover={setHoverId}
        onSelect={(s) => flyToSector(s.id)}
        layout={sectorLayout.kind}
        sighted={sightedSectors}
        unsureSectors={unsureSectors}
      />
    ) : null;
  const nextSearch =
    ready && state ? (
      <NextSearch
        map={mapFile}
        state={panelState ?? state}
        covered={panelCovered}
        overlap={panelOverlap}
        held={held}
        patchResult={patchSet}
        sectorNames={sectorLayout.sectors.map((sector) => sectorName(sector))}
        found={finds.length > 0}
        onSelect={(lon, lat, idx) => {
          setPickedHot(idx);
          flyToPoint(lon, lat);
        }}
        activeIdx={activeHot}
        onHover={setHoverHot}
        unsure={
          shownUnsure.length > 0
            ? {
                count: shownUnsure.length,
                sectorNames: rankSectors(statuses)
                  .filter((s) => unsureSectors.has(s.sector.id))
                  .map((s) => sectorName(s.sector)),
                onSelect: () => {
                  const a = shownUnsure[unsureCursor.current % shownUnsure.length];
                  unsureCursor.current += 1;
                  if (a) flyToPoint(a.lon, a.lat);
                },
              }
            : undefined
        }
      />
    ) : null;
  const legendFolds = !panelSlot && !roomy;
  const legend = (
    <Legend
      simulatedPath={bundle.survey.simulated_path}
      hasSurveyed={hasSurveyed}
      hasSightings={sightings.length > 0}
      hasUnsure={shownUnsure.length > 0}
      palette={palette}
      showPath={showPath}
      onShowPathChange={setShowPath}
      onCollapse={
        legendFolds
          ? () => {
              setLegendOpen(false);
              requestAnimationFrame(() => legendPillRef.current?.focus());
            }
          : undefined
      }
    />
  );
  const slider =
    stepCount > 0 ? (
      <StepSlider
        value={stepIndex}
        max={stepCount}
        playing={replay.playing}
        onTogglePlay={replay.toggle}
        onScrub={replay.scrub}
        onSkip={replay.skip}
        inputRef={replay.bindSlider}
      />
    ) : null;
  const buildingToast = building && !reduced && (
    <div className="pointer-events-auto absolute left-1/2 top-3 -translate-x-1/2">
      <button
        type="button"
        onClick={() => {
          raster.finish();
          setBuilding(false);
        }}
        className="sl-toast rounded-full border border-border bg-bg/90 px-4 py-1.5 text-small text-text-2 backdrop-blur hover:text-text"
      >
        Building the map along the flight… <span className="text-text">Skip</span>
      </button>
    </div>
  );

  // Narrow screens: the map keeps its whole area; the replay, a segmented control and the chosen
  // panel sit below it (in the shell's slot), with touch targets of at least 44 px.
  if (panelSlot) {
    const panelContent =
      panelTab === "legend" ? legend : panelTab === "sectors" ? (sectorList ?? computing) : (nextSearch ?? computing);
    return (
      <>
        <Overlay>
          {buildingToast}
          {sightingCard}
        </Overlay>
        {createPortal(
          <div className="flex flex-col gap-3" data-testid="search-panels-below">
            {slider && <Panel className="rounded-full px-3 py-2">{slider}</Panel>}
            {foundBanner && <Panel className="p-4">{foundBanner}</Panel>}
            <div
              role="tablist"
              aria-label="Search map panels"
              className="grid grid-cols-3 gap-1 rounded-full border border-border bg-surface p-1"
            >
              {PANEL_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`search-tab-${t.id}`}
                  aria-selected={panelTab === t.id}
                  aria-controls="search-tabpanel"
                  onClick={() => setPanelTab(t.id)}
                  className={`min-h-11 rounded-full px-2 text-small transition-colors ${
                    panelTab === t.id ? "bg-surface-strong text-text ring-1 ring-border" : "text-text-2 hover:text-text"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <Panel id="search-tabpanel" role="tabpanel" aria-labelledby={`search-tab-${panelTab}`} className="p-4">
              {panelContent}
            </Panel>
          </div>,
          panelSlot,
        )}
      </>
    );
  }

  return (
    <Overlay>
      <Panel {...overlay("left")} className={`sl-rise pointer-events-auto absolute left-3 top-3 max-h-[calc(100%-6.5rem)] w-80 overflow-y-auto p-4 shadow-[0_16px_40px_-20px_rgba(0,0,0,0.9)] ${OVER_MAP}`}>
        {/* In the side panel rather than over the map, so it never hides the grid. Sightings first,
            then where to search next (unsure areas at its top), then the sectors. */}
        {foundBanner && <div className="mb-4 border-b border-border pb-4">{foundBanner}</div>}
        {sectorList && nextSearch ? (
          <div className="flex flex-col gap-5">
            {nextSearch}
            <div className="border-t border-border pt-4">{sectorList}</div>
          </div>
        ) : (
          computing
        )}
      </Panel>
      {legendFolds && !legendOpen ? (
        <button
          type="button"
          ref={legendPillRef}
          {...overlay("corner")}
          aria-expanded={false}
          aria-controls="search-legend"
          onClick={() => setLegendOpen(true)}
          className={`pointer-events-auto absolute bottom-7 right-3 inline-flex h-8 items-center gap-2 rounded-full border border-border px-3 font-mono text-label uppercase tracking-wider text-text-2 shadow-[0_16px_40px_-20px_rgba(0,0,0,0.9)] backdrop-blur-md transition-colors hover:text-text ${OVER_MAP}`}
        >
          <span aria-hidden="true" className="flex h-1.5 w-6 overflow-hidden rounded-full">
            {classSwatches(palette).map((c) => (
              <span key={c} className="h-full flex-1" style={{ background: c }} />
            ))}
          </span>
          Reading the map
        </button>
      ) : (
        <Panel
          {...overlay("corner")}
          id="search-legend"
          // Capped below the basemap switch (top right), so the two never overlap on short screens.
          className={`sl-rise pointer-events-auto absolute bottom-7 right-3 max-h-[calc(100%-5.5rem)] w-64 overflow-y-auto p-4 shadow-[0_16px_40px_-20px_rgba(0,0,0,0.9)] ${OVER_MAP}`}
          style={{ animationDelay: legendFolds ? undefined : "80ms" }}
        >
          {legend}
        </Panel>
      )}
      {slider && (
        <Panel {...overlay("bottom")} className={`pointer-events-auto absolute bottom-3 left-1/2 w-[min(34rem,calc(100%-44rem))] min-w-72 -translate-x-1/2 rounded-full px-3 py-2 shadow-[0_16px_40px_-20px_rgba(0,0,0,0.9)] ${OVER_MAP}`}>
          {slider}
        </Panel>
      )}
      {buildingToast}
      {sightingCard}
    </Overlay>
  );
}
