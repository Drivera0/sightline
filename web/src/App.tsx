import { useEffect } from "react";
import { CACHE_DIR, useCache } from "./lib/cache";
import { useSelection } from "./lib/selection";
import { EmptyState } from "./shell/components";
import { Shell } from "./shell/Shell";

export function App({ dir = CACHE_DIR }: { dir?: string }) {
  const { status, data, error, dir: loadedDir, load } = useCache();

  useEffect(() => {
    void load(dir);
  }, [dir, load]);

  if (status === "error") {
    return (
      <div role="alert" className="h-full">
        <EmptyState title="Could not load the survey">
          {error} Create the cache with `python -m sightline.pipeline sample` (or `run`), then reload.
        </EmptyState>
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

  // Clear cross-screen selection before replacing every cache-backed frame and detection.
  const changeSurvey = (nextDir: string) => {
    if (nextDir === loadedDir) return;
    useSelection.getState().clear();
    void load(nextDir);
  };

  return (
    <Shell
      cache={data}
      cacheDir={loadedDir ?? dir}
      onCacheDirChange={changeSurvey}
    />
  );
}
