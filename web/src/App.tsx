import { useEffect, useMemo, useState } from "react";
import { FrontDoor } from "./front/FrontDoor";
import { DEMO_MISSION_ID } from "./command/demoMission";
import { LiveMission, tabFromHash } from "./ingest/LiveMission";
import { NewSearch } from "./ingest/NewSearch";
import { apiBase } from "./lib/api";
import {
  CACHE_DIR,
  READABLE_CONTRACT_VERSIONS,
  cacheUrl,
  useCache,
} from "./lib/cache";
import { useSelection } from "./lib/selection";
import { EmptyState, ModeChip } from "./shell/components";
import { Logo } from "./shell/Logo";
import { routeFromHash, type Route } from "./shell/flow";
import { Shell, SurveySelect, type SurveyOption } from "./shell/Shell";

function useRoute(): Route {
  const [hash, setHash] = useState(() => (typeof window === "undefined" ? "" : window.location.hash));
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return routeFromHash(hash);
}

/** Live missions need the mission API (VITE_API_URL); the static demo needs nothing. */
export function LiveRoutes({ route, base = apiBase() }: { route: Exclude<Route, { kind: "demo" | "front" }>; base?: string | null }) {
  const api = useMemo(() => (base === null ? null : { base }), [base]);
  if (route.kind === "mission" && route.id === DEMO_MISSION_ID) {
    // the command view's demo mission needs no API (E-04): it works on the demo-only site too
    return <LiveMission key="demo" api={api ?? { base: "" }} missionId={DEMO_MISSION_ID} initialTab={tabFromHash(window.location.hash)} />;
  }
  if (api === null) return <NoServer />;
  if (route.kind === "new") return <NewSearch api={api} onCreated={(id) => (window.location.hash = `#m/${id}/photos`)} />;
  return <LiveMission key={route.id} api={api} missionId={route.id} initialTab={tabFromHash(window.location.hash)} />;
}

/**
 * "Start a new search" on the public site, which has no mission server by design (VITE_API_URL unset):
 * say when the server runs and hand over the demo mission first, the guided demo second.
 */
export function NoServer() {
  return (
    <main className="flex min-h-full items-center justify-center p-4 lg:p-8">
      <section aria-label="No mission server" className="flex w-full max-w-xl flex-col gap-5 rounded-lg border border-line bg-surface-solid p-6 lg:p-8">
        <a href="#" className="flex items-center gap-2 text-body font-medium text-text" title="Back to the start">
          <Logo />
          Sightline
        </a>
        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-2">
            <ModeChip mode="demo">Demo site</ModeChip>
          </span>
          <h1 className="text-title text-text">The live mission server runs during demos and judging; here is the demo mission.</h1>
          <p className="text-small text-text-2">
            The demo mission is the same command console with pre-seeded data and no server: approve the agent's proposals, assign teams,
            add clues, and read the agent's trace.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <a href="#m/demo/command" className="rounded-full border border-accent bg-accent/15 px-5 py-2.5 text-center text-body text-text hover:bg-accent/25">
            Open the demo mission
          </a>
          <a href="#survey" className="rounded-full border border-border px-5 py-2.5 text-center text-body text-text hover:bg-surface-strong">
            Watch the guided demo
          </a>
        </div>
      </section>
    </main>
  );
}

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
  const route = useRoute();
  if (route.kind === "front") {
    return <FrontDoor onStartNew={() => (window.location.hash = "#new")} onWatchDemo={() => (window.location.hash = "#survey")} />;
  }
  if (route.kind !== "demo") return <LiveRoutes route={route} />;
  return <DemoApp dir={dir} />;
}

function DemoApp({ dir }: { dir: string }) {
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
