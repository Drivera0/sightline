import {
  createContext,
  type PropsWithChildren,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Map as MapLibreMap,
  type Map,
  type MapLayerMouseEvent,
  type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useBundle } from "../lib/cache";
import { useSelection } from "../lib/selection";
import { Badge } from "../shell/components";
import { SimulatedLine, simulatedLineFor } from "./base/SimulatedLine";
import { useReview } from "../review/store";
import { prefersReducedMotion } from "../metrics/motion";
import type { CacheBundle } from "../contract";
import { gridBounds, surveyBounds, viewBounds } from "./base/features";
import { EASE_MS, insidePaddedViewport, measuredPadding, OVERLAY_ATTR, paddingOffset, surveyPadding } from "./base/camera";
import {
  basemapStyle,
  chooseBasemapMode,
  ensurePmtilesProtocol,
  readBasemapColors,
  type BasemapMode,
} from "./base/basemap";
import { MAP_LAYER_IDS } from "./base/layerIds";
import { setHoveredPin, setSelectedPin, syncBaseLayers, syncDetectionSource } from "./base/layers";

const DEFAULT_CENTER: [number, number] = [-122.945, 49.37];
const EMPTY_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [],
};

export interface MapProviderProps extends PropsWithChildren {
  className?: string;
  initialCenter?: [lon: number, lat: number];
  initialZoom?: number;
  mapStyle?: string | StyleSpecification;
}

export interface MapContextValue {
  map: Map | null;
  flyTo: (lon: number, lat: number, zoom?: number) => void;
}

const MapContext = createContext<MapContextValue | null>(null);

// Own the single MapLibre instance and expose it to all map layers.
export function MapProvider({
  children,
  className,
  initialCenter = DEFAULT_CENTER,
  initialZoom = 14,
  mapStyle = EMPTY_STYLE,
}: MapProviderProps): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<Map | null>(null);

  useEffect(() => {
    if (!containerRef.current) return undefined;

    ensurePmtilesProtocol();
    const instance = new MapLibreMap({
      container: containerRef.current,
      center: initialCenter,
      zoom: initialZoom,
      style: mapStyle,
      attributionControl: { compact: false },
    });
    setMap(instance);

    return () => {
      setMap(null);
      instance.remove();
    };
  }, [initialCenter, initialZoom, mapStyle]);

  const flyTo = useCallback(
    (lon: number, lat: number, zoom?: number) => {
      map?.flyTo({ center: [lon, lat], zoom });
    },
    [map],
  );
  const value = useMemo(() => ({ map, flyTo }), [flyTo, map]);

  return (
    <MapContext.Provider value={value}>
      <div ref={containerRef} className={className} data-testid="map-canvas" />
      {children}
    </MapContext.Provider>
  );
}

// Give child layers access to the map and shared fly-to behavior.
export function useMap(): MapContextValue {
  const value = useContext(MapContext);
  if (!value) {
    throw new Error("useMap must be used within MapProvider");
  }
  return value;
}

export interface MapViewProps extends Omit<MapProviderProps, "children"> {
  layers?: ReactNode;
  /** Fly to the selected candidate once the map loads (the review step). */
  focusSelection?: boolean;
}

interface BasemapToggleProps {
  mode: BasemapMode;
  satelliteAvailable: boolean;
  onChange: (mode: BasemapMode) => void;
}

// Report browser connectivity without assuming navigator exists during non-browser rendering.
function browserIsOnline(): boolean {
  return typeof navigator === "undefined" ? false : navigator.onLine;
}

// Let the operator switch between satellite imagery and the bundled offline map.
function BasemapToggle({
  mode,
  satelliteAvailable,
  onChange,
}: BasemapToggleProps): ReactNode {
  const baseClass =
    "rounded-[var(--radius-sm)] px-3 py-2 font-mono text-xs transition-colors";
  const activeClass = "bg-[var(--surface-strong)] text-[var(--text)]";
  const inactiveClass = "text-[var(--text-2)] hover:bg-[var(--surface)]";

  return (
    <div
      aria-label="Basemap"
      className="pointer-events-auto flex rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)]/85 p-1 shadow-lg backdrop-blur-md"
      role="group"
    >
      <button
        aria-pressed={mode === "satellite"}
        className={`${baseClass} ${mode === "satellite" ? activeClass : inactiveClass}`}
        disabled={!satelliteAvailable}
        onClick={() => onChange("satellite")}
        title={
          satelliteAvailable
            ? "Use MapTiler satellite imagery"
            : "Requires a MapTiler key and network connection"
        }
        type="button"
      >
        Satellite
      </button>
      <button
        aria-pressed={mode === "offline"}
        className={`${baseClass} ${mode === "offline" ? activeClass : inactiveClass}`}
        onClick={() => onChange("offline")}
        type="button"
      >
        Offline
      </button>
    </div>
  );
}

/**
 * Frame the photographed area (not the outer sectors), clear of the panels drawn over the map: the
 * padding is measured from the panels on screen (marked with OVERLAY_ATTR), so the survey sits in the
 * visible gap at any width. Search next's panels overlay the map on wide screens.
 */
function fitSurvey(map: Map, bundle: CacheBundle, panelsOverMap: boolean, duration: number): void {
  const container = map.getContainer();
  const overlay =
    panelsOverMap && typeof window !== "undefined" && (window.matchMedia?.("(min-width: 1024px)").matches ?? false);
  const measured = measuredPadding(container) ?? undefined;
  map.fitBounds(surveyBounds(bundle.survey) ?? gridBounds(bundle.map.grid), {
    padding: surveyPadding(container.clientWidth, container.clientHeight, overlay, measured),
    duration,
  });
}

/** Padding clear of the panels over the map (Review's readout card), for its overview and eases. */
function reviewPadding(map: Map) {
  const container = map.getContainer();
  return surveyPadding(container.clientWidth, container.clientHeight, false, measuredPadding(container) ?? undefined);
}

// "Fit to survey": back to the whole photographed area after panning or zooming around.
function FitSurveyButton({ panelsOverMap }: { panelsOverMap: boolean }): ReactNode {
  const bundle = useBundle();
  const { map } = useMap();
  return (
    <button
      type="button"
      disabled={!map}
      onClick={() => map && fitSurvey(map, bundle, panelsOverMap, prefersReducedMotion() ? 0 : 600)}
      title="Show the whole photographed area"
      className="pointer-events-auto inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)]/85 px-3 py-3 font-mono text-xs text-[var(--text-2)] shadow-lg backdrop-blur-md transition-colors hover:text-[var(--text)]"
    >
      <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
        <path
          d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      Fit to survey
    </button>
  );
}

// Keep the rendered map layers synchronized with cache and shared selection state.
function BaseMapLayers({ focusSelection = false }: { focusSelection?: boolean }): ReactNode {
  const bundle = useBundle();
  const { map } = useMap();
  const selectedDetectionId = useSelection((state) => state.selectedDetectionId);
  const selectDetection = useSelection((state) => state.selectDetection);
  const reviewAnswers = useReview((state) => state.answers);

  useEffect(() => {
    if (!map) return undefined;

    // Add cache features after the style is ready and frame the complete search grid.
    const renderLayers = () => {
      syncBaseLayers(map, bundle, useReview.getState().answers);
      setSelectedPin(map, useSelection.getState().selectedDetectionId);
      // Review opens on the overview, then eases in to the candidate under review. Search next opens
      // on the photographed area, clear of its panels.
      if (focusSelection) map.fitBounds(viewBounds(bundle.survey, bundle.map.grid), { padding: reviewPadding(map), duration: 0 });
      else fitSurvey(map, bundle, true, 0);
      const selected = useSelection.getState().selectedDetectionId;
      const detection = selected
        ? Object.values(bundle.detections.frames)
            .flat()
            .find((candidate) => candidate.id === selected)
        : undefined;
      if (focusSelection && detection) {
        map.easeTo({
          center: [detection.lon, detection.lat],
          zoom: 17,
          offset: paddingOffset(reviewPadding(map)),
          duration: prefersReducedMotion() ? 0 : EASE_MS,
        });
      }
      map.on("click", MAP_LAYER_IDS.pins, selectPin);
      map.on("mousemove", MAP_LAYER_IDS.pins, showPointer);
      map.on("mouseleave", MAP_LAYER_IDS.pins, hidePointer);
      // The centre icon too: zoomed out, the 10 m circle is only a few pixels across.
      map.on("click", MAP_LAYER_IDS.pinMarkers, selectPin);
      map.on("mousemove", MAP_LAYER_IDS.pinMarkers, showPointer);
      map.on("mouseleave", MAP_LAYER_IDS.pinMarkers, hidePointer);
    };
    // Send a clicked detection through Lane D's shared selection store.
    const selectPin = (event: MapLayerMouseEvent) => {
      const detectionId = event.features?.[0]?.properties?.detectionId;
      if (typeof detectionId === "string") selectDetection(detectionId);
    };
    // Indicate that detection polygons are interactive, and show the hovered pin's label.
    const showPointer = (event: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const detectionId = event.features?.[0]?.properties?.detectionId;
      setHoveredPin(map, typeof detectionId === "string" ? detectionId : null);
    };
    // Restore the default cursor and hide the label after leaving a detection polygon.
    const hidePointer = () => {
      map.getCanvas().style.cursor = "";
      setHoveredPin(map, null);
    };

    if (map.isStyleLoaded()) renderLayers();
    else map.once("load", renderLayers);

    return () => {
      map.off("load", renderLayers);
      map.off("click", MAP_LAYER_IDS.pins, selectPin);
      map.off("mousemove", MAP_LAYER_IDS.pins, showPointer);
      map.off("click", MAP_LAYER_IDS.pinMarkers, selectPin);
      map.off("mousemove", MAP_LAYER_IDS.pinMarkers, showPointer);
      map.off("mouseleave", MAP_LAYER_IDS.pinMarkers, hidePointer);
      map.off("mouseleave", MAP_LAYER_IDS.pins, hidePointer);
    };
  }, [bundle, focusSelection, map, selectDetection]);

  useEffect(() => {
    if (map) syncDetectionSource(map, bundle, reviewAnswers);
  }, [bundle, map, reviewAnswers]);

  useEffect(() => {
    if (map) setSelectedPin(map, selectedDetectionId);
  }, [map, selectedDetectionId]);

  useEffect(() => {
    if (!selectedDetectionId || !map || !map.isStyleLoaded()) return;
    const detection = Object.values(bundle.detections.frames)
      .flat()
      .find((candidate) => candidate.id === selectedDetectionId);
    if (!detection) return;
    // Calm: a pin already comfortably in view needs no move; otherwise pan to it, keeping the zoom.
    const container = map.getContainer();
    const point = map.project([detection.lon, detection.lat]);
    if (insidePaddedViewport(point, container.clientWidth, container.clientHeight)) return;
    map.easeTo({
      center: [detection.lon, detection.lat],
      offset: focusSelection ? paddingOffset(reviewPadding(map)) : [0, 0],
      duration: prefersReducedMotion() ? 0 : EASE_MS,
    });
  }, [bundle.detections.frames, focusSelection, map, selectedDetectionId]);

  // Bottom-left, above the attribution row. On Review the line sits in the legend card instead
  // (HeatLayer), which covers this corner on a narrow map.
  return (
    <div {...{ [OVERLAY_ATTR]: "bottom" }} className="pointer-events-none absolute bottom-7 left-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-col items-start gap-2">
      {!bundle.survey.simulated_path && <Badge kind="info">Real EXIF positions</Badge>}
      {!focusSelection && <SimulatedLine {...simulatedLineFor(bundle)} />}
    </div>
  );
}

// Render the cache-backed base layers, with an optional caller-supplied layer overlay.
export function MapView({ layers, className, focusSelection, ...providerProps }: MapViewProps): ReactNode {
  const mapTilerKey = import.meta.env.VITE_MAPTILER_KEY?.trim() || undefined;
  const [online, setOnline] = useState(browserIsOnline);
  const [mode, setMode] = useState<BasemapMode>(() => chooseBasemapMode(mapTilerKey, online));
  const managedBasemap = providerProps.mapStyle === undefined;
  const resolvedStyle = useMemo(() => {
    if (providerProps.mapStyle !== undefined) return providerProps.mapStyle;
    return basemapStyle(mode, mapTilerKey, readBasemapColors());
  }, [mapTilerKey, mode, providerProps.mapStyle]);

  useEffect(() => {
    // Mirror network changes so a lost connection immediately selects the local archive.
    const updateConnectivity = () => setOnline(browserIsOnline());
    window.addEventListener("online", updateConnectivity);
    window.addEventListener("offline", updateConnectivity);
    return () => {
      window.removeEventListener("online", updateConnectivity);
      window.removeEventListener("offline", updateConnectivity);
    };
  }, []);

  useEffect(() => {
    if (!online || !mapTilerKey) setMode("offline");
  }, [mapTilerKey, online]);

  return (
    <div className="relative h-full min-h-0 w-full">
      <MapProvider
        {...providerProps}
        className={`h-full min-h-0 w-full ${className ?? ""}`.trim()}
        mapStyle={resolvedStyle}
      >
        <BaseMapLayers focusSelection={focusSelection} />
        {layers}
        <div {...{ [OVERLAY_ATTR]: "top" }} className="pointer-events-none absolute right-3 top-3 flex items-start gap-2">
          <FitSurveyButton panelsOverMap={!focusSelection} />
          {managedBasemap ? (
            <BasemapToggle
              mode={mode}
              satelliteAvailable={Boolean(mapTilerKey && online)}
              onChange={setMode}
            />
          ) : null}
        </div>
      </MapProvider>
    </div>
  );
}
