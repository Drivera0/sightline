import { useEffect, useMemo, useState } from "react";
import { FrontDoor } from "./front/FrontDoor";
import { JudgesPage } from "./front/JudgesPage";
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
import { TryPage } from "./detect/TryPhoto";
import { AppBar } from "./shell/AppBar";
import { Button, EmptyState, ModeChip, Page, PageHeader, Panel } from "./shell/components";
import { DEMO_CONSOLE_HASH, redirectFromHash, routeFromHash, type Route } from "./shell/flow";
import { Shell, SurveySelect, type SurveyOption } from "./shell/Shell";

/** The current hash, with old addresses (#operate, #command, #searchnext) replaced by their one home. */
function canonicalHash(): string {
  if (typeof window === "undefined") return "";
  const to = redirectFromHash(window.location.hash);
  if (to) window.history.replaceState(null, "", to);
  return window.location.hash;
}

function useRoute(): Route {
  const [hash, setHash] = useState(canonicalHash);
  useEffect(() => {
    const on = () => setHash(canonicalHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return routeFromHash(hash);
}

/** Live missions need the mission API (VITE_API_URL); the static demo needs nothing. */
export function LiveRoutes({ route, base = apiBase() }: { route: Extract<Route, { kind: "new" | "mission" }>; base?: string | null }) {
  const api = useMemo(() => (base === null ? null : { base }), [base]);
  // one object across renders: a new one on each hash change re-ran the mission's load and reset the demo
  const demoApi = useMemo(() => api ?? { base: "" }, [api]);
  if (route.kind === "mission" && route.id === DEMO_MISSION_ID) {
    // the command view's demo mission needs no API (E-04): it works on the demo-only site too
    return <LiveMission key="demo" api={demoApi} missionId={DEMO_MISSION_ID} initialTab={tabFromHash(window.location.hash)} />;
  }
  if (api === null) return <NoServer />;
  if (route.kind === "new") return <NewSearch api={api} onCreated={(id) => (window.location.hash = `#m/${id}/photos`)} />;
  return <LiveMission key={route.id} api={api} missionId={route.id} initialTab={tabFromHash(window.location.hash)} />;
}

/**
 * New search on the public site, which has no mission server by design (VITE_API_URL unset): say when
 * the server runs and hand over the console on the demo mission first, the guided demo second.
 */
export function NoServer() {
  return (
    <>
      <AppBar current="new" base={null} />
      <Page>
        <PageHeader eyebrow="New search" title="The live mission server runs during demos and judging" sub="This site is the demo: the same console runs on a pre-seeded mission, with no server." />
        <Panel aria-label="No mission server" role="region" className="flex max-w-2xl flex-col gap-4">
          <span className="flex items-center gap-2">
            <ModeChip mode="demo">Demo site</ModeChip>
          </span>
          <p className="text-body text-text-2">
            Here is the demo mission instead. In the console you approve the agent's proposals, assign teams, add clues, and read the agent's
            trace; nothing leaves your browser.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button href={DEMO_CONSOLE_HASH} variant="primary" size="lg">
              Open the console
            </Button>
            <Button href="#survey" size="lg">
              Guided demo
            </Button>
          </div>
        </Panel>
      </Page>
    </>
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
  if (route.kind === "front") return <FrontDoor />;
  if (route.kind === "judges") return <JudgesPage />;
  if (route.kind === "new" || route.kind === "mission") return <LiveRoutes route={route} />;
  // the guided demo and Try a photo both read the survey cache (Try a photo offers its photos as samples)
  return <DemoApp dir={dir} page={route.kind === "try" ? "try" : "steps"} />;
}

function DemoApp({ dir, page }: { dir: string; page: "steps" | "try" }) {
  const section = page === "try" ? "try" : "demo";
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
      <>
        <AppBar current={section} />
        <Page>
          <Panel role="alert" className="mx-auto flex w-full max-w-xl flex-col items-center gap-4 text-center">
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
          </Panel>
        </Page>
      </>
    );
  }
  if (status !== "ready" || !data) {
    return (
      <div className="flex h-full flex-col">
        <AppBar current={section} wide={page === "steps"} />
        <div role="status" className="flex-1">
          <EmptyState title="Loading survey…" />
        </div>
      </div>
    );
  }

  if (page === "try") return <TryPage cache={data} dir={loadedDir ?? dir} />;
  return (
    <Shell
      cache={data}
      cacheDir={loadedDir ?? dir}
      onCacheDirChange={changeSurvey}
      surveyOptions={availableSurveys ?? []}
    />
  );
}
