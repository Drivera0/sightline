import { createContext, useContext } from "react";
import { create } from "zustand";
import type { CacheBundle } from "../contract";

export const CACHE_FILES = ["manifest", "survey", "detections", "map", "metrics"] as const;
export const SUPPORTED_CONTRACT_VERSION = "1.2";
/** 1.1 only adds optional fields, so 1.0 caches still load (the new fields read as null); 1.2 only
 * adds live-mission files, so the cache files are the same. */
export const READABLE_CONTRACT_VERSIONS: readonly string[] = ["1.0", "1.1", "1.2"];

/** Folder under public/cache/ that the app reads: VITE_CACHE_DIR, or "sample". */
export const CACHE_DIR = import.meta.env.VITE_CACHE_DIR || "sample";

export class CacheLoadError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(message);
    this.name = "CacheLoadError";
  }
}

/** URL of a cache asset such as "frames/f0042.jpg" or "crops/f0042-d01.jpg". */
export function cacheUrl(dir: string, relativePath: string): string {
  return `/cache/${dir}/${relativePath}`;
}

async function loadFile(dir: string, name: string, fetchImpl: typeof fetch): Promise<unknown> {
  const file = `${name}.json`;
  const where = `/cache/${dir}/`;
  let response: Response;
  try {
    response = await fetchImpl(cacheUrl(dir, file));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CacheLoadError(file, `Could not load ${file}: ${reason}`);
  }
  if (!response.ok) {
    throw new CacheLoadError(file, `Could not load ${file} (HTTP ${response.status}) from ${where}`);
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new CacheLoadError(file, `${file} from ${where} is not valid JSON`);
  }
  const version = (data as { contract_version?: unknown } | null)?.contract_version;
  if (typeof version !== "string" || !READABLE_CONTRACT_VERSIONS.includes(version)) {
    throw new CacheLoadError(
      file,
      `${file} has contract_version ${JSON.stringify(version)}; this app reads ${READABLE_CONTRACT_VERSIONS.join(" or ")}`,
    );
  }
  return data;
}

/** Fetch the five contract files from /cache/<dir>/. Rejects with a CacheLoadError naming the first bad file. */
export async function loadCache(dir: string, fetchImpl: typeof fetch = fetch): Promise<CacheBundle> {
  const results = await Promise.allSettled(CACHE_FILES.map((name) => loadFile(dir, name, fetchImpl)));
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
  const [manifest, survey, detections, map, metrics] = results.map(
    (r) => (r as PromiseFulfilledResult<unknown>).value,
  );
  return { manifest, survey, detections, map, metrics } as CacheBundle;
}

type Status = "idle" | "loading" | "ready" | "error";

interface CacheState {
  status: Status;
  data: CacheBundle | null;
  error: string | null;
  /** Folder under public/cache/ that was last loaded, for building image URLs. */
  dir: string | null;
  load: (dir: string, fetchImpl?: typeof fetch) => Promise<void>;
  reset: () => void;
}

let latestLoad = 0;

export const useCache = create<CacheState>((set) => ({
  status: "idle",
  data: null,
  error: null,
  dir: null,
  load: async (dir, fetchImpl = fetch) => {
    const mine = ++latestLoad;
    set({ status: "loading", data: null, error: null, dir });
    try {
      const data = await loadCache(dir, fetchImpl);
      if (mine === latestLoad) set({ status: "ready", data, error: null });
    } catch (error) {
      if (mine === latestLoad) {
        set({ status: "error", data: null, error: error instanceof Error ? error.message : String(error) });
      }
    }
  },
  reset: () => {
    latestLoad++;
    set({ status: "idle", data: null, error: null, dir: null });
  },
}));

/** Lets a component tree (the Shell) hand its cache to every screen, so screens work with or without the store. */
export const CacheContext = createContext<CacheBundle | null>(null);

/** The loaded cache: from the nearest CacheContext provider, else from the store once it is ready. */
export function useBundle(): CacheBundle {
  const provided = useContext(CacheContext);
  const stored = useCache((s) => s.data);
  const data = provided ?? stored;
  if (!data) throw new Error("useBundle() called before the cache finished loading");
  return data;
}
