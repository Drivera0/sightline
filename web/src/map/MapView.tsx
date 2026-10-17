import { EmptyState, Panel } from "../shell/components";

/** Mount point for lane B: the MapLibre instance, MapProvider and useMap(). Replace this file. */
export function MapView() {
  return (
    <Panel className="h-full">
      <EmptyState title="Map">Lane B mounts the basemap, footprints, path and pins here.</EmptyState>
    </Panel>
  );
}
