/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Initial folder under public/cache/: "sample" (default), "demo", or "real-gps". */
  readonly VITE_CACHE_DIR?: string;
  /** The mission API (contract §13), e.g. "https://api.example.org"; unset = demo only. */
  readonly VITE_API_URL?: string;
}
