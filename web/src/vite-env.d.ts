/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Initial folder under public/cache/: "sample" (default), "demo", or "real-gps". */
  readonly VITE_CACHE_DIR?: string;
  /** The mission API (contract §13), e.g. "https://api.example.org"; unset = demo only. */
  readonly VITE_API_URL?: string;
  /** Another copy of the sample photo pack (a .zip, or a JSON list of photo addresses); unset = the site's own /sample/sightline-sample-photos.zip. */
  readonly VITE_SAMPLE_PHOTOS_URL?: string;
}
