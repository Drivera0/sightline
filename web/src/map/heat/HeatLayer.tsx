// Lane C's map overlay: heat cells, surveyed outline, step slider, "search next", legend, found banner.
// Mount it through B's MapView: <MapView layers={<HeatLayer />} />.
import { type ReactNode, useContext, useEffect, useMemo, useRef } from "react";
import type { CacheBundle } from "../../contract";
import { CacheContext, useCache } from "../../lib/cache";
import { detectionById, useSearch } from "../../search/store";
import { Panel } from "../../shell/components";
import { useMap, type MapContextValue } from "../MapView";
import { FoundBanner } from "./FoundBanner";
import { coveredCells } from "./geometry";
import {
  cellFeaturesFor,
  ensureHeatLayers,
  HEAT_SOURCE_ID,
  pushHeatState,
  pushReplay,
  readHeatColors,
} from "./layers";
import { Legend } from "./Legend";
import { NextSearch } from "./NextSearch";
import { StepSlider } from "./StepSlider";

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

export function HeatLayer() {
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
  return <HeatOverlay bundle={bundle} mapCtx={mapCtx} />;
}

function Overlay({ children }: { children: ReactNode }) {
  return <div className="pointer-events-none absolute inset-0 z-10">{children}</div>;
}

function HeatOverlay({ bundle, mapCtx }: { bundle: CacheBundle; mapCtx: MapContextValue }) {
  const { map, flyTo } = mapCtx;
  const mapFile = bundle.map;
  const bind = useSearch((s) => s.bind);
  const boundMap = useSearch((s) => s.data?.map);
  const state = useSearch((s) => s.state);
  const stepIndex = useSearch((s) => s.stepIndex);
  const stepCount = useSearch((s) => s.stepCount);
  const setStepIndex = useSearch((s) => s.setStepIndex);
  const foundDetectionId = useSearch((s) => s.foundDetectionId);

  useEffect(() => {
    bind({ map: bundle.map, detections: bundle.detections });
  }, [bind, bundle.map, bundle.detections]);

  const covered = useMemo(() => coveredCells(mapFile), [mapFile]);
  const hasSurveyed = useMemo(() => covered.some((c) => c === 1), [covered]);
  // The drone's position after each step, in step order (one point per applied frame).
  const path = useMemo(() => {
    const poses = new Map(bundle.survey.frames.map((f) => [f.id, [f.pose.lon, f.pose.lat] as [number, number]]));
    return mapFile.steps.flatMap((s) => {
      const at = poses.get(s.frame_id);
      return at ? [at] : [];
    });
  }, [bundle.survey.frames, mapFile.steps]);
  const stepRef = useRef(stepIndex);
  stepRef.current = stepIndex;

  // What the map already shows per cell; NaN = unknown, push everything.
  const lastRef = useRef<Float64Array>(new Float64Array(0));
  const ready = boundMap === mapFile && state !== null;
  const stateRef = useRef(state);
  stateRef.current = ready ? state : null;

  // Install the layers once the style is ready, and again whenever a style reload drops them.
  useEffect(() => {
    if (!map) return undefined;
    const n = mapFile.grid.rows * mapFile.grid.cols;
    lastRef.current = new Float64Array(n).fill(Number.NaN);
    const install = () => {
      try {
        const added = ensureHeatLayers(
          map,
          cellFeaturesFor(mapFile.grid),
          mapFile.grid,
          covered,
          readHeatColors(),
        );
        if (added) lastRef.current = new Float64Array(n).fill(Number.NaN);
        const current = stateRef.current;
        if (current) pushHeatState(map, current, lastRef.current, covered);
        pushReplay(map, path, stepRef.current);
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
  }, [map, mapFile, covered, path]);

  // Recolour via feature state when the derived state changes. Never touches the GeoJSON.
  useEffect(() => {
    if (!map || !ready || !state) return;
    try {
      if (map.getSource(HEAT_SOURCE_ID)) pushHeatState(map, state, lastRef.current, covered);
    } catch {
      /* style reloading; install() pushes again */
    }
  }, [map, ready, state, covered]);

  // Move the drone and its trail with the replay slider.
  useEffect(() => {
    if (!map) return;
    try {
      pushReplay(map, path, stepIndex);
    } catch {
      /* style reloading; install() pushes again */
    }
  }, [map, path, stepIndex]);

  const foundDetection = foundDetectionId ? detectionById(bundle.detections, foundDetectionId) : undefined;

  return (
    <Overlay>
      <Panel className="sl-rise pointer-events-auto absolute left-3 top-3 max-h-[calc(100%-6.5rem)] w-72 overflow-y-auto p-4 shadow-[0_16px_40px_-20px_rgba(0,0,0,0.9)]">
        {/* In the side panel rather than over the map, so it never hides the grid. */}
        {foundDetection && (
          <div className="mb-4 border-b border-border pb-4">
            <FoundBanner detection={foundDetection} />
          </div>
        )}
        {ready && state ? (
          <NextSearch
            map={mapFile}
            state={state}
            covered={covered}
            onSelect={(lon, lat) => flyTo(lon, lat, 17)}
          />
        ) : (
          <span className="text-small text-text-2" role="status">
            Computing search map…
          </span>
        )}
      </Panel>
      <Panel className="sl-rise pointer-events-auto absolute bottom-3 right-3 w-64 p-4 shadow-[0_16px_40px_-20px_rgba(0,0,0,0.9)]" style={{ animationDelay: "80ms" }}>
        <Legend
          simulatedPath={bundle.survey.simulated_path}
          params={mapFile.params}
          manifest={bundle.manifest}
          hasSurveyed={hasSurveyed}
        />
      </Panel>
      {stepCount > 0 && (
        <Panel className="pointer-events-auto absolute bottom-3 left-1/2 w-[min(34rem,calc(100%-36rem))] min-w-72 -translate-x-1/2 rounded-full px-3 py-2 shadow-[0_16px_40px_-20px_rgba(0,0,0,0.9)]">
          <StepSlider value={stepIndex} max={stepCount} onChange={setStepIndex} />
        </Panel>
      )}
    </Overlay>
  );
}
