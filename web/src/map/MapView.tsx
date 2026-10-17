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
import maplibregl, { type Map, type StyleSpecification } from "maplibre-gl";

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

    const instance = new maplibregl.Map({
      container: containerRef.current,
      center: initialCenter,
      zoom: initialZoom,
      style: mapStyle,
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
}

// Render the shared map provider with the supplied layer components.
export function MapView({ layers, ...providerProps }: MapViewProps): ReactNode {
  return <MapProvider {...providerProps}>{layers}</MapProvider>;
}
