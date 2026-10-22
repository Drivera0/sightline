import { useCallback, useEffect, useMemo, useState } from "react";
import { DEMO_MISSION_ID } from "./command/demoMission";
import { AboutSheet } from "./front/About";
import { LiveCard, LiveMission, type MissionRoute } from "./ingest/LiveMission";
import { NewSearch } from "./ingest/NewSearch";
import { apiBase } from "./lib/api";
import { DEMO, redirectFromHash, routeFromHash, type Route } from "./shell/flow";

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

/** Where the About sheet goes back to: the console that was on screen, else the landing. */
type Behind = MissionRoute | { kind: "new" } | { kind: "card"; id: string; sector: string };
const LANDING: MissionRoute = { kind: "mission", id: DEMO_MISSION_ID, view: null, t: null, open: {} };

/**
 * The site is one console. A mission (the demo's by default, the landing at `#`), the empty console at
 * `#new`, a sector's card, and the About sheet over whichever of them was last on screen.
 */
export function App({ base = apiBase() }: { base?: string | null }) {
  const route = useRoute();
  const [behind, setBehind] = useState<Behind>(LANDING);
  const [behindHash, setBehindHash] = useState<string>(DEMO);
  useEffect(() => {
    if (route.kind !== "about") {
      setBehind(route);
      setBehindHash(window.location.hash || DEMO);
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
    window.location.hash = behindHash === "#about" ? DEMO : behindHash;
  }, [behindHash]);
  return (
    <>
      <Console route={shown} base={base} />
      {route.kind === "about" && <AboutSheet onClose={closeAbout} />}
    </>
  );
}

function Console({ route, base }: { route: Behind; base: string | null }) {
  const api = useMemo(() => (base === null ? null : { base }), [base]);
  // one object across renders: a new one on each hash change re-ran the mission's load
  const demoApi = useMemo(() => api ?? { base: "" }, [api]);
  if (route.kind === "new") return <NewSearch api={api} onCreated={(id) => (window.location.hash = `#m/${id}/photos`)} />;
  if (route.kind === "card") return api ? <LiveCard api={api} missionId={route.id} sector={route.sector} /> : <NewSearch api={null} onCreated={() => undefined} />;
  // the demo mission needs no API (E-04): it is the whole public site
  if (route.id === DEMO_MISSION_ID) return <LiveMission key="demo" api={demoApi} missionId={DEMO_MISSION_ID} route={route} />;
  if (api === null) return <NewSearch api={null} onCreated={() => undefined} />;
  return <LiveMission key={route.id} api={api} missionId={route.id} route={route} />;
}
