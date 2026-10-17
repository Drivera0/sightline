/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Folder under public/cache/ to load: "sample" (default) or "demo". */
  readonly VITE_CACHE_DIR?: string;
}
