// Lane C's map overlay: heat cells, sectors, surveyed outline, step slider, "search next", legend,
// found banner. Mount it through B's MapView: <MapView layers={<HeatLayer />} />.
// variant="review" is the quiet version beside the review queue: the same live heat (fainter, under
// the pins), the review ripple and a small readout, without the replay and the side panel.
import { type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CacheBundle } from "../../contract";
import { CacheContext, useCache } from "../../lib/cache";
import { useReview, type HistoryEntry } from "../../review/store";
import { prefersReducedMotion } from "../../metrics/motion";
import { detectionById, effectiveAnswers, heldCells, stateAtStep, useSearch } from "../../search/store";
import { Panel } from "../../shell/components";
import { useMap, type MapContextValue } from "../MapView";
import { OVERLAY_ATTR, readOverlays } from "../base/camera";
import { placeLabel } from "./labelPlacement";
import { FoundBanner } from "./FoundBanner";
import { heatScaleMax, probabilityShares, topCellIndices } from "./geometry";
import {
  buildOverlapIndex,
  eligibleCells,
  firstPhotographedStep,
  frameOverlaps,
  overlapAtStep,
  photographedCells,
} from "./coverage";
import { ensureDroneImage } from "./droneImage";
import { lerpAngle, pointAtStep, stepDrone, trailAtStep, type DroneState } from "./droneMotion";
import {
  breathFactor,
  ensureHeatLayers,
  HEAT_BASE_OPACITY,
  type HeatVariant,
  pushDrone,
  pushHotspots,
  pushRipple,
  pushSectorLabels,
  pushSectors,
  type PlaceLabel,
  readHeatColors,
  refreshHeatSource,
  RIPPLE_MS,
  setBreath,
  setFlightPathVisible,
  setHeldBoundary,
  setRippleFrame,
  setSurveyedBoundary,
} from "./layers";
import { Legend, rampSwatches } from "./Legend";
import { SimulatedLine, simulatedLineFor } from "../base/SimulatedLine";
import { NextSearch } from "./NextSearch";
import { PanelSlotContext, ROOMY_LAYOUT_QUERY, useMediaQuery, WIDE_LAYOUT_QUERY } from "./panelSlot";
import { HeatRaster, heatPixels, paletteFromTokens, readRasterTokens, sweepDelays } from "./raster";
import { SectorList } from "./SectorList";
import { buildSectors, currentSector, sectorBounds, sectorStatuses } from "./sectors";
import { StepSlider } from "./StepSlider";

type PanelTab = "legend" | "sectors" | "next";
/** The segmented control above the panels on narrow screens. */
const PANEL_TABS: readonly { id: PanelTab; label: string }[] = [
  { id: "legend", label: "Legend" },
  { id: "sectors", label: "Sectors" },
  { id: "next", label: "Search next" },
];

/**
 * Panels floating over the map use a thicker, darker material than the shell's glass: the pale end
 * of the heat ramp under a 5 % white glass left their secondary text unreadable (Apple HIG,
 * Materials: thicker materials give better contrast for text over bright content).
 */
const OVER_MAP = "bg-bg/80!";

/** How long an answer's change to the map takes to settle, and the Search next build-up. */
export const ANSWER_TWEEN_MS = 650;
export const BUILD_UP_MS = 1500;
/** Share of the build-up timeline each cell takes to fade in (the rest is its place in the flight). */
export const BUILD_UP_FADE = 0.2;

/** useMap() without throwing, so a mount outside MapProvider renders nothing instead of crashing. */
function useOptionalMap(): MapContextValue | null {
  try {
    return useMap();
  } catch {
    return null;
  }
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
  const reduced = useMemo(() => prefersReducedMotion(), []);

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
  const history = useReview((s) => s.history);
  const held = useMemo(
    () => heldCells({ map: mapFile, detections: bundle.detections }, history),
    [mapFile, bundle.detections, history],
  );
  const hasSurveyed = useMemo(() => covered.some((c) => c === 1), [covered]);
  const path = useMemo(() => stepFrames.map((f) => [f.pose.lon, f.pose.lat] as [number, number]), [stepFrames]);
  const ready = data?.map === mapFile && state !== null;

  // Sectors (computed in the browser; see sectors.ts).
  const sectorLayout = useMemo(() => buildSectors(grid, frames), [grid, frames]);
  const statuses = useMemo(
    () => (ready && state ? sectorStatuses(sectorLayout, state, covered) : []),
    [ready, state, sectorLayout, covered],
  );
  const currentId = isSearch ? (currentSector(sectorLayout, stepIndex, stepCount)?.id ?? null) : null;
  const [hoverId, setHoverId] = useState<string | null>(null);
  // Narrow screens: the panels go below the map (see panelSlot.ts).
  const slot = useContext(PanelSlotContext);
  const wide = useMediaQuery(WIDE_LAYOUT_QUERY, true);
  const panelSlot = isSearch && !wide ? slot : null;
  const [panelTab, setPanelTab] = useState<PanelTab>("legend");
  // Below 1280 px the floating legend folds into a pill, so it does not cover the photographed area.
  const roomy = useMediaQuery(ROOMY_LAYOUT_QUERY, true);
  const [legendOpen, setLegendOpen] = useState(false);
  const legendPillRef = useRef<HTMLButtonElement>(null);

  // The Search next cells (same rule as the panel), ringed on the map.
  const hotspots = useMemo(
    () => (isSearch && ready && state ? topCellIndices(state.p, 5, eligibleCells(overlap, held)) : []),
    [isSearch, ready, state, overlap, held],
  );

  // --- the raster ---------------------------------------------------------------------------
  const palette = useMemo(() => paletteFromTokens(readRasterTokens()), []);
  const raster = useMemo(() => new HeatRaster(grid), [grid]);
  // One colour scale for the whole replay: the top is the prior's likeliest cell (geometry.ts).
  const scaleMax = useMemo(() => heatScaleMax(mapFile.prior.p), [mapFile.prior.p]);
  const pixels = useMemo(
    () => (ready && state ? heatPixels(state, covered, held, palette, scaleMax) : null),
    [ready, state, covered, held, palette, scaleMax],
  );
  const [building, setBuilding] = useState(false);

  // The latest values, for the style-reload installer.
  const latest = useRef({ covered, held, hotspots, statuses, currentId, hoverId });
  latest.current = { covered, held, hotspots, statuses, currentId, hoverId };
  const [showPath, setShowPath] = useState(true);
  const showPathRef = useRef(showPath);
  showPathRef.current = showPath;
  const droneRef = useRef<DroneState>({ s: stepIndex, bearing: pointAtStep(path, stepIndex)?.bearing ?? 0 });
  const drawDroneRef = useRef<() => void>(() => {});
  drawDroneRef.current = () => {
    if (!map || !isSearch) return;
    const d = droneRef.current;
    const p = pointAtStep(path, d.s);
    const frame = p ? stepFrames[p.frame] : undefined;
    try {
      pushDrone(map, p ? p.at : null, d.bearing, trailAtStep(path, d.s), frame ? frame.footprint : null);
    } catch {
      /* style reloading */
    }
  };

  useEffect(() => {
    if (!map) return undefined;
    raster.setOnDraw((playing) => {
      try {
        refreshHeatSource(map, playing);
      } catch {
        /* style reloading; install() pushes again */
      }
    });
    return () => raster.stop();
  }, [map, raster]);

  // Install the layers once the style is ready, and again whenever a style reload drops them.
  useEffect(() => {
    if (!map) return undefined;
    const install = () => {
      try {
        const colors = readHeatColors();
        const now = latest.current;
        ensureHeatLayers(map, raster, grid, now.covered, colors, variant);
        if (isSearch) ensureDroneImage(map, colors.outline);
        refreshHeatSource(map, raster.animating);
        setHeldBoundary(map, grid, now.covered, now.held);
        pushSectors(map, grid, now.statuses, now.currentId, now.hoverId, livePlacement(map));
        if (isSearch) {
          setSurveyedBoundary(map, grid, now.covered);
          setFlightPathVisible(map, showPathRef.current);
          pushHotspots(map, grid, now.hotspots);
          drawDroneRef.current();
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
        const from = heatPixels(state, new Uint8Array(covered.length), held, palette, scaleMax);
        setBuilding(true);
        raster.animate(pixels, { durationMs: BUILD_UP_MS, delays: sweepDelays(firstStep, stepCount), fade: BUILD_UP_FADE }, from);
      } else {
        raster.animate(pixels, { durationMs: ANSWER_TWEEN_MS }, new Uint8ClampedArray(pixels.length));
      }
      return;
    }
    setBuilding(false);
    if (historyChanged && !stepChanged && !reduced) raster.animate(pixels, { durationMs: ANSWER_TWEEN_MS });
    else raster.show(pixels);
    // Only a new picture starts an animation; the refs above say why it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pixels]);

  // The build-up ends by itself; any interaction with the map finishes it at once.
  useEffect(() => {
    if (!building) return undefined;
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
  }, [building, map, raster]);

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
      setHeldBoundary(map, grid, covered, held);
    } catch {
      /* style reloading */
    }
  }, [map, grid, covered, held]);

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

  // The drone glides towards the slider's step and turns smoothly; it jumps with reduced motion.
  useEffect(() => {
    if (!map || !isSearch) return undefined;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(64, Math.max(0, now - last));
      last = now;
      const next = stepDrone(droneRef.current, path, stepIndex, dt, reduced);
      droneRef.current = next;
      drawDroneRef.current();
      const heading = pointAtStep(path, next.s)?.bearing ?? next.bearing;
      const settled = next.s === stepIndex && Math.abs(lerpAngle(next.bearing, heading, 1) - next.bearing) < 0.5;
      if (!settled && !reduced) frame = requestAnimationFrame(tick);
    };
    tick(performance.now());
    return () => cancelAnimationFrame(frame);
  }, [map, isSearch, path, stepIndex, reduced]);

  useEffect(() => {
    if (!map || !isSearch) return;
    try {
      pushHotspots(map, grid, hotspots);
    } catch {
      /* style reloading; the next push redraws it */
    }
  }, [map, grid, hotspots, isSearch]);

  // Breathing: a slow, small pulse of the heat and the hotspots (Search next only). Off for reduced
  // motion, paused while the tab is hidden, about 20 updates a second; only raster-opacity changes.
  useEffect(() => {
    if (!map || !isSearch || reduced) return undefined;
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (document.hidden || now - last < 50) return;
      last = now;
      try {
        setBreath(map, breathFactor(now), HEAT_BASE_OPACITY.search);
      } catch {
        /* style reloading */
      }
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      try {
        setBreath(map, 1, HEAT_BASE_OPACITY.search);
      } catch {
        /* map gone */
      }
    };
  }, [map, isSearch, reduced]);

  const shares = useMemo(() => (ready && state ? probabilityShares(state, covered) : null), [ready, state, covered]);
  // Before any review answer: the same step with no answers (from the store's own inputs).
  const baseShares = useMemo(
    () => (ready && data ? probabilityShares(stateAtStep(data.map, stepIndex), covered) : null),
    [ready, data, stepIndex, covered],
  );
  // Every detection whose latest answer is "Person", newest first.
  const finds = useMemo(
    () =>
      foundDetectionId
        ? effectiveAnswers(history)
            .filter((e) => e.answer === "person")
            .reverse()
            .flatMap((e) => {
              const d = detectionById(bundle.detections, e.detectionId);
              return d ? [d] : [];
            })
        : [],
    [foundDetectionId, history, bundle.detections],
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

  if (!isSearch) {
    const answered = shares !== null && baseShares !== null && Math.abs(baseShares.surveyed - shares.surveyed) > 1e-12;
    return (
      <Overlay>
        <Panel {...overlay("corner")} className={`sl-rise pointer-events-auto absolute bottom-3 right-3 w-64 p-3 shadow-[0_16px_40px_-20px_rgba(0,0,0,0.9)] ${OVER_MAP}`}>
          <div className="flex flex-col gap-3">
            {shares && baseShares ? (
              <div className="flex flex-col gap-1" aria-live="polite">
                <span className="text-small text-text-2">Probability on photographed ground</span>
                <span className="font-mono text-body text-text" data-testid="review-readout">
                  {answered
                    ? `${pct2(baseShares.surveyed)} → ${pct2(shares.surveyed)}`
                    : pct2(shares.surveyed)}
                </span>
                <span className="text-label text-text-3">
                  {answered ? "Before review → now. " : ""}Each &ldquo;Not a person&rdquo; lowers it around that pin.
                </span>
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
            />
            {/* Review's map is narrow: its one simulated line lives here, not in a corner the card covers. */}
            <SimulatedLine {...simulatedLineFor(bundle)} plain />
          </div>
        </Panel>
      </Overlay>
    );
  }

  const foundBanner = finds.length > 0 && (
    <FoundBanner finds={finds} simulatedRadius={bundle.survey.simulated_path} onFlyTo={(f) => flyToPoint(f.lon, f.lat)} />
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
      />
    ) : null;
  const nextSearch =
    ready && state ? (
      <NextSearch
        map={mapFile}
        state={state}
        covered={covered}
        overlap={overlap}
        held={held}
        found={finds.length > 0}
        onSelect={flyToPoint}
      />
    ) : null;
  const legendFolds = !panelSlot && !roomy;
  const legend = (
    <Legend
      simulatedPath={bundle.survey.simulated_path}
      hasSurveyed={hasSurveyed}
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
  const slider = stepCount > 0 ? <StepSlider value={stepIndex} max={stepCount} onChange={setStepIndex} /> : null;
  const buildingToast = building && (
    <div className="pointer-events-auto absolute left-1/2 top-3 -translate-x-1/2">
      <button
        type="button"
        onClick={() => {
          raster.finish();
          setBuilding(false);
        }}
        className="sl-toast rounded-full border border-border bg-bg/85 px-4 py-1.5 text-small text-text-2 backdrop-blur hover:text-text"
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
        <Overlay>{buildingToast}</Overlay>
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
        {/* In the side panel rather than over the map, so it never hides the grid. */}
        {foundBanner && <div className="mb-4 border-b border-border pb-4">{foundBanner}</div>}
        {sectorList && nextSearch ? (
          <div className="flex flex-col gap-5">
            {sectorList}
            <div className="border-t border-border pt-4">{nextSearch}</div>
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
          className={`pointer-events-auto absolute bottom-3 right-3 inline-flex h-8 items-center gap-2 rounded-full border border-border px-3 font-mono text-label uppercase tracking-wider text-text-2 shadow-[0_16px_40px_-20px_rgba(0,0,0,0.9)] backdrop-blur-md transition-colors hover:text-text ${OVER_MAP}`}
        >
          <span aria-hidden="true" className="flex h-1.5 w-6 overflow-hidden rounded-full">
            {rampSwatches().map((c) => (
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
          className={`sl-rise pointer-events-auto absolute bottom-3 right-3 max-h-[calc(100%-4.5rem)] w-64 overflow-y-auto p-4 shadow-[0_16px_40px_-20px_rgba(0,0,0,0.9)] ${OVER_MAP}`}
          style={{ animationDelay: legendFolds ? undefined : "80ms" }}
        >
          {legend}
        </Panel>
      )}
      {slider && (
        <Panel {...overlay("bottom")} className={`pointer-events-auto absolute bottom-3 left-1/2 w-[min(34rem,calc(100%-38rem))] min-w-72 -translate-x-1/2 rounded-full px-3 py-2 shadow-[0_16px_40px_-20px_rgba(0,0,0,0.9)] ${OVER_MAP}`}>
          {slider}
        </Panel>
      )}
      {buildingToast}
    </Overlay>
  );
}
