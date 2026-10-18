/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Initial folder under public/cache/: "sample" (default), "demo", or "real-gps". */
  readonly VITE_CACHE_DIR?: string;
}
