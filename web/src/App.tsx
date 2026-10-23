import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { DEMO_MISSION_ID } from "./command/demoMission";
import { LiveCard, LiveMission, type MissionRoute } from "./ingest/LiveMission";
import { NewSearch } from "./ingest/NewSearch";
import { Home } from "./front/Home";
import { apiBase } from "./lib/api";
import { HOME, redirectFromHash, routeFromHash, type Route } from "./shell/flow";

// About is a sheet a visitor opens later: its own chunk, out of the landing's first bundle.
const AboutSheet = lazy(() => import("./front/About").then((m) => ({ default: m.AboutSheet })));

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

/** Where the About sheet goes back to: the home page or the console that was on screen. */
type Behind = MissionRoute | { kind: "home" } | { kind: "new" } | { kind: "card"; id: string; sector: string };
const LANDING: Behind = { kind: "home" };

/**
 * The home page at `#`, then one console: a mission (the demo's at `#m/demo`), the empty console at
 * `#new`, a sector's card, and the About sheet over whichever of them was last on screen.
 */
export function App({ base = apiBase() }: { base?: string | null }) {
  const route = useRoute();
  const [behind, setBehind] = useState<Behind>(LANDING);
  const [behindHash, setBehindHash] = useState<string>(HOME);
  useEffect(() => {
    if (route.kind !== "about") {
      setBehind(route);
      setBehindHash(window.location.hash || HOME);
    }
  }, [route]);
  // the console keeps its address up to date without a hashchange (the story's clock): take the address
  // it had when About opened, so closing About returns to that exact moment
  useEffect(() => {
    const on = (e: HashChangeEvent) => {
      if (window.location.hash !== "#about" || !e.oldURL) return;
      const was = new URL(e.oldURL).hash;
      if (was && was !== "#about") setBehindHash(was);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const shown: Behind = route.kind === "about" ? behind : route;
  const closeAbout = useCallback(() => {
    window.location.hash = behindHash === "#about" ? HOME : behindHash;
  }, [behindHash]);
  return (
    <>
      <Console route={shown} base={base} covered={route.kind === "about"} />
      {route.kind === "about" && (
        <Suspense fallback={null}>
          <AboutSheet onClose={closeAbout} />
        </Suspense>
      )}
    </>
  );
}

function Console({ route, base, covered }: { route: Behind; base: string | null; covered: boolean }) {
  const api = useMemo(() => (base === null ? null : { base }), [base]);
  // one object across renders: a new one on each hash change re-ran the mission's load
  const demoApi = useMemo(() => api ?? { base: "" }, [api]);
  if (route.kind === "home") return <Home />;
  if (route.kind === "new") return <NewSearch api={api} onCreated={(id) => (window.location.hash = `#m/${id}/photos`)} />;
  if (route.kind === "card") return api ? <LiveCard api={api} missionId={route.id} sector={route.sector} /> : <NewSearch api={null} onCreated={() => undefined} />;
  // the demo mission needs no API (E-04): it is the whole public site
  if (route.id === DEMO_MISSION_ID) return <LiveMission key="demo" api={demoApi} missionId={DEMO_MISSION_ID} route={route} covered={covered} />;
  if (api === null) return <NewSearch api={null} onCreated={() => undefined} />;
  return <LiveMission key={route.id} api={api} missionId={route.id} route={route} covered={covered} />;
}
