import { setWorkerUrl } from "maplibre-gl";
// `?worker&url` makes Vite bundle the worker together with the files it imports and gives its URL.
// Without it the production build ships no worker and the map cannot draw any layer.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

let configured = false;

/** Tell MapLibre where its worker script is. Call once, before any map is created. */
export function configureMapWorker(): void {
  if (configured) return;
  setWorkerUrl(workerUrl);
  configured = true;
}
