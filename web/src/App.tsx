import { useEffect } from "react";
import { CACHE_DIR, useCache } from "./lib/cache";
import { EmptyState } from "./shell/components";
import { Shell } from "./shell/Shell";

export function App({ dir = CACHE_DIR }: { dir?: string }) {
  const { status, data, error, load } = useCache();

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
  return <Shell cache={data} />;
}
