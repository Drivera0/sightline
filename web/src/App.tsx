import { useEffect, useState } from "react";
import {
  CACHE_DIR,
  READABLE_CONTRACT_VERSIONS,
  cacheUrl,
  useCache,
} from "./lib/cache";
import { useSelection } from "./lib/selection";
import { EmptyState } from "./shell/components";
import { Shell, SurveySelect, type SurveyOption } from "./shell/Shell";

const PUBLIC_SURVEYS: readonly SurveyOption[] = [
  { dir: "demo", label: "Mount Seymour simulation" },
  { dir: "real-gps", label: "Real EXIF positions" },
];

/** Return public surveys plus the generated sample cache in local development only. */
export function surveyCandidates(dev = import.meta.env.DEV): SurveyOption[] {
  return dev
    ? [{ dir: "sample", label: "Sample survey" }, ...PUBLIC_SURVEYS]
    : [...PUBLIC_SURVEYS];
}

/** Keep only surveys whose manifest exists and uses a contract version this app can read. */
export async function discoverAvailableSurveys(
  options: readonly SurveyOption[],
  fetchImpl: typeof fetch = fetch,
): Promise<SurveyOption[]> {
  const checked = await Promise.all(
    options.map(async (option) => {
      try {
        const response = await fetchImpl(cacheUrl(option.dir, "manifest.json"));
        if (!response.ok) return null;
        const manifest = (await response.json()) as { contract_version?: unknown };
        return typeof manifest.contract_version === "string" &&
          READABLE_CONTRACT_VERSIONS.includes(manifest.contract_version)
          ? option
          : null;
      } catch {
        return null;
      }
    }),
  );
  return checked.filter((option): option is SurveyOption => option !== null);
}

export function App({ dir = CACHE_DIR }: { dir?: string }) {
  const { status, data, error, dir: loadedDir, load } = useCache();
  const [availableSurveys, setAvailableSurveys] = useState<SurveyOption[] | null>(null);

  useEffect(() => {
    void load(dir);
  }, [dir, load]);

  useEffect(() => {
    let active = true;
    void discoverAvailableSurveys(surveyCandidates()).then((options) => {
      if (active) setAvailableSurveys(options);
    });
    return () => {
      active = false;
    };
  }, []);

  // Clear cross-screen selection before replacing every cache-backed frame and detection.
  const changeSurvey = (nextDir: string) => {
    if (!nextDir || nextDir === loadedDir) return;
    useSelection.getState().clear();
    void load(nextDir);
  };

  if (status === "error") {
    return (
      <div role="alert" className="flex h-full items-center justify-center p-6">
        <div className="flex max-w-xl flex-col items-center gap-4 rounded-lg border border-border bg-surface p-8 text-center">
          <h1 className="text-title font-medium text-text">Could not load the survey</h1>
          <p className="text-body text-text-2">
            {error} Create the cache with `python -m sightline.pipeline sample` (or `run`), then
            reload.
          </p>
          {availableSurveys === null ? (
            <p className="text-small text-text-3">Checking for another available survey…</p>
          ) : availableSurveys.length > 0 ? (
            <SurveySelect
              options={availableSurveys}
              value={loadedDir ?? dir}
              onChange={changeSurvey}
            />
          ) : (
            <p className="text-small text-text-3">No survey caches are currently available.</p>
          )}
        </div>
      </div>
    );
  }
  if (status !== "ready" || !data) {
    return (
      <div role="status" className="h-full">
        <EmptyState title="Loading survey…" />
      </div>
    );
  }

  return (
    <Shell
      cache={data}
      cacheDir={loadedDir ?? dir}
      onCacheDirChange={changeSurvey}
      surveyOptions={availableSurveys ?? []}
    />
  );
}
