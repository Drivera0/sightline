import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { DEMO_MISSION_ID } from "./command/demoMission";
import { LiveCard, LiveMission } from "./ingest/LiveMission";
import { NewSearch } from "./ingest/NewSearch";
import { Home } from "./front/Home";
import { apiBase } from "./lib/api";
import { redirectFromHash, routeFromHash, type Route } from "./shell/flow";

// Open play's setup page (#play) loads on its own: most visits never open it
const OpenPlay = lazy(() => import("./front/OpenPlay").then((m) => ({ default: m.OpenPlay })));

/** The current hash, with old addresses (#survey, #judges, #m/<id>/command…) replaced by their one home. */
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
  return useMemo(() => routeFromHash(hash), [hash]);
}

/**
 * The home page at `#` (and `#about`, the same page scrolled to its About section), open play's setup at
 * `#play`, then one console: a mission (the demo's at `#m/demo`), the empty console at `#new` and a sector's card.
 */
export function App({ base = apiBase() }: { base?: string | null }) {
  const route = useRoute();
  return <Console route={route} base={base} />;
}

function Console({ route, base }: { route: Route; base: string | null }) {
  const api = useMemo(() => (base === null ? null : { base }), [base]);
  // one object across renders: a new one on each hash change re-ran the mission's load
  const demoApi = useMemo(() => api ?? { base: "" }, [api]);
  if (route.kind === "home") return <Home section={route.section ?? null} />;
  if (route.kind === "play")
    return (
      <Suspense fallback={<div className="min-h-dvh bg-bg" />}>
        <OpenPlay />
      </Suspense>
    );
  if (route.kind === "new") return <NewSearch api={api} onCreated={(id) => (window.location.hash = `#m/${id}/photos`)} />;
  if (route.kind === "card") return api ? <LiveCard api={api} missionId={route.id} sector={route.sector} /> : <NewSearch api={null} onCreated={() => undefined} />;
  // the demo mission needs no API (E-04): it is the whole public site
  if (route.id === DEMO_MISSION_ID) return <LiveMission key="demo" api={demoApi} missionId={DEMO_MISSION_ID} route={route} />;
  if (api === null) return <NewSearch api={null} onCreated={() => undefined} />;
  return <LiveMission key={route.id} api={api} missionId={route.id} route={route} />;
}
