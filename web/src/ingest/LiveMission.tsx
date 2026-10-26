// The one console: a mission's map, rails and views under one app bar, for a live mission and for the
// demo mission alike. The map never unmounts; the views (Map · Photos · Review · Trace · Debrief) change
// the rail beside it or lay a sheet over the console. On the demo mission the same console is the story:
// the mission clock (missionTime.ts, story.ts) moves through six checkpoints, coach marks point at the real
// panels, and leaving the story leaves you in the console at that mission time. Built by lane A.

import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { Api } from "../lib/api";
import { cardFileUrl, fileUrl, getCard, getHealth, getTrace } from "../lib/api";
import type { AssignmentCard, CacheBundle, Conditions, FleetState, MissionEvent, Proposal, TraceEntry } from "../contract";
import { clueLine, clueShifts } from "../command/clueShift";
import { aiPick } from "../command/subjectMatch";
import { candidatePosition, demoCards, distractorCards, landedFrames, objectClue } from "../command/demoReview";
import { checkpoint, demoAt, LAST, type Checkpoint, type DemoFull } from "../command/missionTime";
import { PhotoStrip, PhotosRail } from "../command/PhotosRail";
import { PitchBar } from "../command/PitchBar";
import { Scrubber } from "../command/Scrubber";
import { landing, RUN_MS, storyClock, useGuide, useStory } from "../command/story";
import { guidedOptsFor, useGuideRun } from "../command/GuideRun";
import { costsOf, standingUser } from "../command/guide";
import { fixtureOf } from "../command/sim";
import { onMissionClock } from "../command/missionTime";
import { isTyping } from "../lib/keys";
import { cacheUrl, loadCache } from "../lib/cache";
import { photoProgress, useMission } from "../lib/mission";
import { clockWithZone, ClockZone, DEMO_TZ, utcLabel } from "../lib/time";
import { CommandView, storeActions } from "../command/CommandView";
import { useConsole } from "../command/consoleStore";
import { useNotify } from "../shell/notify";
import { Briefings, useRadioVoice } from "../command/RadioLink";
import { StatusLine } from "../command/StatusLine";
import { MissionReport } from "../command/MissionReport";
import { ScenarioBanner } from "../front/ScenarioBanner";
import { cardFor } from "../front/scenarios";
import { SubjectStrip } from "../command/SubjectStrip";
import { PhotoDrop, useDropped } from "../command/PhotoDrop";
import { DEFAULT_SEED, presetFor, scenarioMission } from "../command/scenarios";
import { activeSetup, PLAY_SEED, playName } from "../command/openPlay";
import { applySetup } from "../command/openPlayMission";
import { setClockedFlights, stopAllDemoFlights } from "../lib/demoFlight";
import { EventFeed } from "../command/EventFeed";
import { DEMO_MISSION_ID, demoConditionsData, demoImageUrl, loadDemoConditions, loadDemoMission, loadDemoTrace, EXAMPLE_TRACE_LABEL } from "../command/demoMission";
import { latestLookup } from "../command/conditions";
import { outsideGrid, withTaskStatus } from "../command/console";
import type { ConditionsData } from "../command/ConditionsPanel";
import type { TraceRun } from "../command/TraceView";
import type { TriedPhoto } from "../detect/TryPhoto";
import { prefersReducedMotion } from "../metrics/motion";
import { usePick } from "../map/pick";
import { MapStill, wantsStillMap } from "../map/MapStill";
import { useSelection } from "../lib/selection";
import { AppBar, rememberMission, type BarAction } from "../shell/AppBar";
import { Button, modeOf, Page, Panel, Stat } from "../shell/components";
import { DEMO_CONSOLE_HASH, guideHash, PLAY_HASH, scenarioHash, SCENARIOS_HASH, viewHash, type Route, type View } from "../shell/flow";
import { ShortcutOverlay } from "../shell/ShortcutOverlay";
import { SHORTCUT_GROUPS } from "../shell/shortcuts";
import { liveCards, liveReviewItems, ReviewRail, type LiveAnswer, type ObjectKind } from "../review/LiveReview";
import { serverAnswer, serverObject } from "../review/answers";
import { UploadPanel, WatchPanel } from "./UploadPanel";

// Split from the first bundle (the landing paints without them): the map with MapLibre, the views a
// visitor opens later, and Try a photo (whose detector, onnxruntime-web and the model, loads only when used).
const LiveHeatMap = lazy(() => import("../map/heat/LiveHeatMap").then((m) => ({ default: m.LiveHeatMap })));
const Debrief = lazy(() => import("../command/Debrief").then((m) => ({ default: m.Debrief })));
const TraceView = lazy(() => import("../command/TraceView").then((m) => ({ default: m.TraceView })));
const TryPhoto = lazy(() => import("../detect/TryPhoto").then((m) => ({ default: m.TryPhoto })));
const BoxLayer = lazy(() => import("../detect/TryPhoto").then((m) => ({ default: m.BoxLayer })));
const AssignmentCardView = lazy(() => import("../command/AssignmentCardView").then((m) => ({ default: m.AssignmentCardView })));

/** Where the map goes while MapLibre loads: the same frame, empty, so nothing moves when it arrives. */
const MAP_FRAME = <div aria-hidden="true" className="relative h-full min-h-[360px] rounded-lg border border-border" />;
/** The still map's fade into the live map (MapStill.tsx), within 100–400 ms; none under reduced motion. */
const STILL_FADE_MS = 300;
const loading = (what: string) => <p className="text-small text-text-3">Loading {what}…</p>;

export type MissionRoute = Extract<Route, { kind: "mission" }>;

/** The demo cache's folder (the Photos and Review rails, the measured results, Try a photo's samples). */
export const DEMO_DIR = "demo";

/** The demo mission, loaded once per page: the fixtures to "now" and the demo cache. */
let demoLoad: Promise<{ full: DemoFull; bundle: CacheBundle }> | null = null;
function loadDemo(): Promise<{ full: DemoFull; bundle: CacheBundle }> {
  if (!demoLoad) {
    // the cache and the mission's fixtures at once, not one after the other
    const cache = loadCache(DEMO_DIR);
    demoLoad = Promise.all([cache, loadDemoMission(fetch, undefined, cache.then((b) => b.map))]).then(([bundle, { data, now }]) => ({ full: { data, now }, bundle }));
  }
  demoLoad.catch(() => {
    demoLoad = null; // a reload of the page or the view tries again
  });
  return demoLoad;
}

/** The demo cache alone (a live mission's Debrief numbers and Try a photo's samples). */
let bundleLoad: Promise<CacheBundle> | null = null;
function loadBundle(): Promise<CacheBundle> {
  bundleLoad ??= loadCache(DEMO_DIR);
  bundleLoad.catch(() => {
    bundleLoad = null;
  });
  return bundleLoad;
}

/**
 * Run `cb` once the page has painted what is on screen now: after the browser reports the paint (a
 * largest-contentful-paint entry from now on, where it reports them; under a second either way), then after
 * two more frames, at the first idle moment (a second at most). Returns a cancel.
 */
function afterPaint(cb: () => void): () => void {
  const since = performance.now();
  let done = false;
  let raf = 0;
  let timer = 0;
  let idle = 0;
  let observer: PerformanceObserver | null = null;
  const fire = () => {
    if (!done) cb();
    done = true;
  };
  const next = () => {
    if (raf || done) return;
    observer?.disconnect();
    // two frames: the second begins only once the first has gone out
    raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        timer = window.setTimeout(() => {
          if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(fire, { timeout: 1000 });
          else fire();
        }, 0);
      });
    });
  };
  const canWatch = typeof PerformanceObserver !== "undefined" && (PerformanceObserver.supportedEntryTypes ?? []).includes("largest-contentful-paint");
  // nothing larger than what is already on screen: no entry comes, so do not wait long for one
  const fallback = window.setTimeout(next, canWatch ? 800 : 0);
  if (canWatch) {
    observer = new PerformanceObserver((list) => {
      if (list.getEntries().some((e) => e.startTime >= since)) next();
    });
    observer.observe({ type: "largest-contentful-paint", buffered: true });
  }
  return () => {
    done = true;
    observer?.disconnect();
    window.clearTimeout(fallback);
    if (raf) cancelAnimationFrame(raf);
    window.clearTimeout(timer);
    if (idle) window.cancelIdleCallback(idle);
  };
}

/**
 * The demo mission's clock as the address sets it: the guided search, the landing, or the console at a
 * checkpoint (`?t=N`, with or without a view: no coach marks, the walk-through is the guided search).
 */
function storyFromRoute(route: MissionRoute): void {
  const st = useStory.getState();
  // the guided search (`?guide=1`): its own clock from the call, no pitch bar. Arriving at the address is
  // always a new run (the home page's Start, Try another scenario): a run that ended, or one left at the
  // home page, never carries over, nor do its actions and answers
  // Free play (`#m/demo/map`, a card's "Open the console only") is a new run from the call every time too,
  // on the same engine with no coach bar: nothing of an earlier run, guided or free, carries over
  if (route.open.guide || route.open.free) {
    useStory.setState({ t: 0, progress: 1, playing: false, through: null, pitch: false, started: true, user: [], answers: {}, tried: null });
    useGuide.getState().start({ free: !!route.open.free });
    return;
  }
  // a checkpoint of the recorded mission after a run: the run's actions and answers go with it
  if (useGuide.getState().guide) {
    useGuide.getState().stop();
    useStory.setState({ user: [], answers: {}, tried: null });
  }
  if (route.t !== null) st.seek(route.t);
  else if (route.view === null) landing();
  else if (!st.started || st.pitch) st.skipToNow();
}

/** What a run leaves on the console (its flights, the panels' state, toasts, dropped photos): gone for a new run. */
function freshConsole(): void {
  stopAllDemoFlights();
  useConsole.getState().reset();
  useNotify.getState().reset();
  useDropped.setState({ cards: [], at: {}, status: null });
}

/** The demo mission's clock, the view and the scenario, as an address. */
function demoHash(view: View, t: Checkpoint, pitch: boolean, seed: string | null = null, guide = false, free = false): string {
  if (free) return seed ? scenarioHash(seed, false) : DEMO_CONSOLE_HASH;
  if (guide) return guideHash(seed);
  // the map at the end of the recorded timeline keeps its ?t=6: the plain #m/demo/map is free play
  const h = pitch ? "#m/demo" : viewHash(DEMO_MISSION_ID, view, t >= LAST && view !== "map" ? null : t);
  return seed ? `${h}${h.includes("?") ? "&" : "?"}s=${encodeURIComponent(seed)}` : h;
}

/** Each event the visitor's actions made on the demo console, under an id of its own (u0001…). */
let userSeq = 0;
const asUserEvent = (e: MissionEvent): MissionEvent => ({ ...e, id: `u${String(++userSeq).padStart(4, "0")}` });

/** `covered`: a sheet is over the console; its map waits until the sheet goes. */
export function LiveMission({ api, missionId, route, covered = false }: { api: Api; missionId: string; route: MissionRoute; covered?: boolean }) {
  const s = useMission();
  const demo = missionId === DEMO_MISSION_ID;
  // the story's clock as the address has it, before the first render (the landing's pitch bar is there from
  // the first frame, so the console under it never moves)
  useState(() => demo && storyFromRoute(route));
  const story = useStory();
  const [view, setView] = useState<View>(() => route.view ?? (demo && route.t !== null ? checkpoint(route.t).view : "map"));
  const [keysOpen, setKeysOpen] = useState(false);
  const [tryOpen, setTryOpen] = useState(!!route.open.try);
  const [logOpen, setLogOpen] = useState(!!route.open.log);
  const [condOpen, setCondOpen] = useState(!!route.open.conditions);
  const condId = useId();
  const [demoData, setDemoData] = useState<{ full: DemoFull; bundle: CacheBundle } | null>(null);
  const [bundle, setBundle] = useState<CacheBundle | null>(null);
  const tab = useConsole((x) => x.tab);
  const dropped = useDropped();
  // the demo's scenario (#m/demo?s=<seed>; none: the overdue hiker) and the mission as that scenario
  const [seed, setSeed] = useState<string | null>(route.seed ?? null);
  const [scenario, setScenario] = useState<DemoFull | null>(null);
  const [liveAnswers, setLiveAnswers] = useState<Record<string, LiveAnswer>>({});

  /** Bring a region of the console on screen (phones stack them) and put focus in it. */
  const show = useCallback((id: "console-needs" | "console-timeline" | "console-map" | "console-resources", focus?: string) => {
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (!el) return;
      if (window.innerWidth < 1024) el.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      const target = (focus ? el.querySelector<HTMLElement>(focus) : null) ?? el.querySelector<HTMLElement>("section");
      if (target) {
        if (!target.hasAttribute("tabindex") && !/^(BUTTON|INPUT|SELECT|A)$/.test(target.tagName)) target.setAttribute("tabindex", "-1");
        target.focus({ preventScroll: window.innerWidth < 1024 });
      }
    });
  }, []);
  /** Needs you (the old Review view, key 3, #m/<id>/review). */
  const toNeeds = useCallback(() => {
    useConsole.getState().setTab("needs");
    show("console-needs", "[aria-label='Needs you']");
  }, [show]);
  /** The radio (key 6, #m/<id>/radio): the timeline on Radio, the talk bar ready. */
  const toRadio = useCallback(() => {
    const c = useConsole.getState();
    c.setTab("timeline");
    c.setFilter("Radio");
    show("console-timeline", "input[aria-label='Message']");
  }, [show]);

  // The address decides where the console opens: the landing, a checkpoint of the story, or a view.
  const routeKey = `${missionId}|${route.view}|${route.t}|${JSON.stringify(route.open)}|${route.seed ?? ""}`;
  useEffect(() => {
    if (demo && (route.seed ?? null) !== useSeedRef.current) pickScenario(route.seed ?? null, false);
    if (route.open.try) setTryOpen(true);
    if (route.open.log) setLogOpen(true);
    if (route.open.conditions) setCondOpen(true);
    if (route.open.needs) toNeeds();
    if (route.open.radio) toRadio();
    if (!demo) {
      setView(route.view ?? "map");
      return;
    }
    const wasRun = !!useGuide.getState().guide;
    storyFromRoute(route);
    // a new run (guided or free), or the recorded mission after one: the console starts clean
    if (route.open.guide || route.open.free || wasRun) freshConsole();
    if (route.open.guide || route.open.free || (route.view === null && route.t === null)) setView("map");
    else if (route.view === null && route.t !== null) setView(checkpoint(route.t).view);
    else if (route.view !== null) setView(route.view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey]);

  useEffect(() => {
    if (!demo) rememberMission(missionId);
  }, [demo, missionId]);

  // Load the mission: the demo's fixtures and cache, or a live mission over the API.
  useEffect(() => {
    let live = true;
    if (demo) {
      loadDemo().then(
        (d) => live && setDemoData(d),
        (e: unknown) => live && useMission.setState({ status: "error", error: e instanceof Error ? e.message : String(e) }),
      );
      return () => {
        live = false;
        stopAllDemoFlights();
      };
    }
    void useMission.getState().connect(missionId, api);
    loadBundle().then(
      (b) => live && setBundle(b),
      () => undefined,
    );
    return () => {
      live = false;
      useMission.getState().disconnect();
    };
  }, [api, missionId, demo]);
  const cache = demo ? (demoData?.bundle ?? null) : bundle;

  // Open play (`?s=play`, the #play page's Start): the visitor's own setup on its profile's scenario
  const playSetup = useMemo(() => (seed === PLAY_SEED ? activeSetup() : null), [seed]);
  const scenarioName = playSetup ? playName(playSetup) : presetFor(seed).name;
  // The scenario: the generator's fixture for its seed, or derived from the demo mission (scenarios.ts).
  useEffect(() => {
    if (!demo || !demoData) return undefined;
    let live = true;
    const load = (fixture: unknown) => loadDemoMission(fetch, async () => fixture as never, Promise.resolve(demoData.bundle.map)).then(({ data, now }) => ({ data, now }));
    void scenarioMission(demoData.full, playSetup ? playSetup.profile : seed, load).then((f) => live && setScenario(playSetup ? applySetup(f, playSetup) : f));
    return () => {
      live = false;
    };
  }, [demo, demoData, seed, playSetup]);

  // The demo mission at the story's clock, the visitor's own actions on top. The guided search runs its own
  // clock: the fixtures' clock stands still while a decision's minutes are spent (sim.ts), and the console
  // prints the mission clock.
  const guide = useGuide((x) => x.guide);
  const guided = demo && !!guide;
  // free play: the guided search's engine and clock, the console's own controls, no coach bar
  const freePlay = guided && !!guide!.free;
  const effSeed = seed ?? DEFAULT_SEED;
  const costs = useMemo(() => costsOf(guide?.choices ?? []), [guide?.choices]);
  const clockIso = guided ? new Date(fixtureOf(guide!.clock, costs)).toISOString().replace(/\.\d+Z$/, "Z") : storyClock(story);
  const gOpts = useMemo(() => (guided ? guidedOptsFor(scenario, effSeed, guide!.choices, story.user, freePlay) : null), [guided, scenario, effSeed, guide?.choices, story.user, freePlay]);
  // the guided search's standing approval plays the agent's next picks as assignments of the visitor's
  const simUser = useMemo(() => (guided ? standingUser(scenario, effSeed, story.user, guide!.choices) : story.user), [guided, scenario, effSeed, story.user, guide?.choices]);
  // the visitor decides (judges 2026-10-23): once they play the clock outside the story, the scenario's own
  // approvals wait for them (missionTime.demoAt's hold) until another scenario is loaded, and what they
  // assign plays through the guided search's engine (sim.ts)
  const [decides, setDecides] = useState(false);
  useEffect(() => {
    if (demo && !guided && story.playing) setDecides(true);
  }, [demo, guided, story.playing]);
  const hold = demo && !guided && decides;
  // with the clock running (the guided search, a played clock) the drones fly by it (command/fleetSim.ts)
  useEffect(() => setClockedFlights(demo && (guided || hold)), [demo, guided, hold]);
  const derivedIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!demo || !scenario) return;
    const at = demoAt(scenario, clockIso, simUser, gOpts, { hold, seed: effSeed });
    const state = gOpts ? onMissionClock(at, costs) : at;
    derivedIds.current = new Set((state.events ?? []).map((e) => e.id));
    useMission.getState().useDemo(state, clockIso);
  }, [demo, scenario, clockIso, simUser, gOpts, costs, hold, effSeed]);
  // what the visitor does on the demo console is kept as events of their own, replayed when the clock moves
  useEffect(() => {
    if (!demo) return undefined;
    return useMission.subscribe((m) => {
      if (m.status !== "demo") return;
      const fresh = m.events.filter((e) => !derivedIds.current.has(e.id));
      if (fresh.length === 0) return;
      for (const e of fresh) derivedIds.current.add(e.id);
      useStory.getState().record(fresh.map(asUserEvent));
    });
  }, [demo]);

  // The clock's run into a checkpoint (reduced motion: a jump), updating the console ten times a second.
  useEffect(() => {
    if (!demo || !story.playing) return undefined;
    if (prefersReducedMotion()) {
      useStory.getState().setProgress(1);
      return undefined;
    }
    const duration = RUN_MS[story.t] || 1;
    let raf = 0;
    let last = performance.now();
    let written = last;
    let p = useStory.getState().progress;
    const frame = (now: number) => {
      p = Math.min(1, p + (now - last) / duration);
      last = now;
      if (p >= 1 || now - written >= 100) {
        written = now;
        useStory.getState().setProgress(p);
      }
      if (p < 1) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [demo, story.playing, story.t]);

  // The address keeps on the moment the console shows.
  useEffect(() => {
    // only while the address is this mission's (not once the visitor has gone home or to #about)
    if (!demo || !story.started || !/^#m\/demo(\/|\?|$)/.test(window.location.hash)) return;
    const want = demoHash(view, story.t, story.pitch, seed, guided, freePlay);
    if (window.location.hash !== want) window.history.replaceState(null, "", want);
  }, [demo, view, story.t, story.pitch, story.started, seed, guided, freePlay]);

  /** Load another scenario: the visitor's actions and answers go with the old one. */
  const useSeedRef = useRef<string | null>(seed);
  const pickScenario = useCallback((next: string | null, write = true) => {
    const s = next === DEFAULT_SEED ? null : next;
    useSeedRef.current = s;
    stopAllDemoFlights();
    useConsole.getState().reset();
    useNotify.getState().reset();
    setDecides(false);
    useStory.setState({ user: [], answers: {}, tried: null });
    useDropped.setState({ cards: [], at: {}, status: null });
    // a new scenario in the guided search starts it again from the call
    const g = useGuide.getState().guide;
    if (g) useGuide.getState().start({ free: !!g.free });
    setScenario(null);
    setSeed(s);
    if (write) {
      const st = useStory.getState();
      const g = useGuide.getState().guide;
      window.history.replaceState(null, "", demoHash(view, st.t, st.pitch, s, !!g, !!g?.free));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const go = useCallback(
    (v: View) => {
      setView(v);
      if (demo) {
        const st = useStory.getState();
        if (st.pitch) st.exit();
      }
      if (!demo) window.history.replaceState(null, "", viewHash(missionId, v));
    },
    [demo, missionId],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "?") setKeysOpen((o) => !o);
      else if (e.key === "Escape") {
        setKeysOpen(false);
        setCondOpen(false);
      } else if (keysOpen) return;
      else if (e.key === "c" || e.key === "C") go("map");
      else if ((e.key === "w" || e.key === "W") && view === "map") setCondOpen((o) => !o);
      else if (/^[1-6]$/.test(e.key) && (!useGuide.getState().guide || useGuide.getState().guide!.free)) {
        // 1 Map, 2 Photos, 3 Needs you (the old Review), 4 Trace, 5 Debrief, 6 the radio (the old Radio view)
        const n = Number(e.key);
        if (n === 3) {
          go("map");
          toNeeds();
        } else if (n === 6) {
          go("map");
          toRadio();
        } else go((["map", "photos", "", "trace", "debrief"] as const)[n - 1] as View);
      } else if (e.key === " " && demo && useGuide.getState().guide?.free && !useGuide.getState().guide!.ended && !useConsole.getState().confirming) {
        // free play: Space plays or pauses the mission clock (never the click of a focused decision button)
        e.preventDefault();
        if (!e.repeat) useGuide.getState().pause();
      } else if (e.key === " " && demo && !useGuide.getState().guide && !(e.target instanceof HTMLButtonElement)) {
        // outside the story Space plays the clock on to the end, or pauses it
        e.preventDefault();
        useStory.getState().play();
      }
    };
    // free play: a button clicks on Space's keyup, so that one is swallowed too
    const onUp = (e: KeyboardEvent) => {
      if (e.key !== " " || isTyping(e.target) || !useGuide.getState().guide?.free || useConsole.getState().confirming) return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onUp);
    };
  }, [go, keysOpen, demo, view, toNeeds, toRadio]);

  // whether this server runs the radio desk (serve --radio): hold-to-talk and briefings only when it does
  const [radioOn, setRadioOn] = useState(false);
  useEffect(() => {
    if (demo) return;
    getHealth(api).then((h) => setRadioOn(!!h.radio), () => setRadioOn(false));
  }, [api, demo]);
  const radioApi = useMemo(() => (radioOn && !demo ? { base: api.base, missionId } : null), [radioOn, demo, api.base, missionId]);
  const voice = useRadioVoice(radioApi);

  const [conditionsData, conditionsWaiting] = useConditionsData(api, missionId, demo, s.conditions, s.fleet);
  // the demo console appears whole: its fixtures and its recorded conditions lookup in the same frame
  const ready = !demo || (s.status === "demo" && !conditionsWaiting && scenario !== null);

  // The map comes in once the console has painted with the mission's data: MapLibre's download, start-up
  // and first frame are the heaviest work on the page, and the panels (and their text) should not wait for them.
  const [mapOn, setMapOn] = useState(false);
  const loaded = s.status === "demo" || s.status === "live" || s.status === "reconnecting";
  // Phones and slower devices (MapStill.tsx) see a still image of the map until the map is wanted: a tap
  // on it (at once), or the story at a moment that moves it (t1 photos landing, t4 the teams out), a pick
  // on the map, a team picked on the roster (after the next paint). Once wanted it stays.
  const [still] = useState(wantsStillMap);
  const [wanted, setWanted] = useState<"auto" | "tap" | null>(null);
  const storyMoves = demo && (guided || (story.playing && story.t >= 1 && story.t !== 2 && story.t !== LAST));
  const picking = usePick((p) => p.pending !== null);
  const teamPicked = useSelection((x) => x.selectedTeamId !== null || x.selectedClueId !== null);
  const sectorOpen = useConsole((x) => x.sector !== null || x.picking !== null);
  useEffect(() => {
    if (still && !wanted && (storyMoves || picking || teamPicked || sectorOpen)) setWanted("auto");
  }, [still, wanted, storyMoves, picking, teamPicked, sectorOpen]);
  useEffect(() => {
    if (mapOn || !loaded || !ready || covered || (still && !wanted)) return undefined;
    if (wanted === "tap") {
      setMapOn(true);
      return undefined;
    }
    return afterPaint(() => setMapOn(true));
  }, [mapOn, loaded, ready, covered, still, wanted]);
  // the still image fades out once the map has drawn (at once under reduced motion), then goes
  const [stillPhase, setStillPhase] = useState<"on" | "fading" | "gone">("on");
  const onMapReady = useCallback(() => setStillPhase((p) => (p === "on" ? "fading" : p)), []);
  useEffect(() => {
    // a mission without its search area has no map to wait for (LiveHeatMap says so in words)
    if (mapOn && !s.mapBase) setStillPhase("gone");
  }, [mapOn, s.mapBase]);
  useEffect(() => {
    if (stillPhase !== "fading") return undefined;
    const timer = window.setTimeout(() => setStillPhase("gone"), prefersReducedMotion() ? 0 : STILL_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [stillPhase]);

  const imageUrl = (rel: string) => (demo ? demoImageUrl(rel) : fileUrl(api, missionId, rel));
  // the guided search's decisions, mark and end screen (GuideRun.tsx); the review's answers reach it by a ref
  const answerRef = useRef<(id: string, a: LiveAnswer) => void>(() => undefined);
  // the end screen's Try again and the Restart controls (the coach bar, free play's clock bar): the same
  // scenario from the call, nothing of this run kept
  const restartGuide = useCallback((watch: boolean, free = false) => {
    freshConsole();
    useStory.setState({ user: [], answers: {}, tried: null });
    useGuide.getState().start({ watch, free });
    setView("map");
  }, []);
  const run = useGuideRun({
    demo,
    scenario,
    seed: effSeed,
    scenarioName,
    cache,
    answer: (id, a) => answerRef.current(id, a),
    onPickOnMap: () => {
      useConsole.getState().setTab("map");
      document.getElementById("console-map")?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
    },
    onReport: () => setView("debrief"),
    onTrace: () => setView("trace"),
    // Leave (confirmed on the coach bar): back to the home page's scenario cards, never a different mission on the console
    onLeave: () => {
      useGuide.getState().stop();
      stopAllDemoFlights();
      useStory.setState({ user: [], answers: {}, tried: null });
      useConsole.getState().reset();
      window.location.hash = SCENARIOS_HASH;
    },
    onRestart: restartGuide,
    guideHref: guideHash(seed),
    scenariosHref: SCENARIOS_HASH,
    setupHref: playSetup ? PLAY_HASH : null,
  });
  // each team's status as its tasks say it (a team assigned a sector is not on standby)
  const teams = useMemo(() => withTaskStatus(s.teams, s.tasks), [s.teams, s.tasks]);
  // where a candidate is, for the map's focus: a dropped photo's place, the demo cache's, or the live mission's
  const candidateAt = (id: string) => {
    const mine = dropped.at[id];
    if (mine) return { lat: mine.lat, lon: mine.lon, footprint: null };
    const frames = demo ? cache?.survey.frames : s.survey?.frames;
    const footprint = frames?.find((f) => f.id === id.slice(0, 5))?.footprint ?? null;
    if (demo) {
      const at = candidatePosition(cache, id);
      return at ? { lat: at.lat, lon: at.lon, footprint } : null;
    }
    const det = s.detections?.frames[id.slice(0, 5)]?.find((d) => d.id === id);
    return det && det.lat !== null && det.lon !== null ? { lat: det.lat, lon: det.lon, footprint } : null;
  };
  // which clues moved each sector, from the map log: a line on an assignment's card (clueShift.ts)
  const shifts = useMemo(() => (s.mapBase && s.sectors.length ? clueShifts(s.mapBase, s.mapUpdates, s.sectors, s.clues) : null), [s.mapBase, s.mapUpdates, s.sectors, s.clues]);
  const clueNote = (p: Proposal) => clueLine(shifts?.get(String(p.target.sector ?? "")));
  const clockZone = useMemo(() => ({ tz: demo ? DEMO_TZ : false }), [demo]);
  const shownIso = guided ? new Date(guide!.clock).toISOString().replace(/\.\d+Z$/, "Z") : clockIso;
  const demoNow = useMemo(() => (demo ? new Date(shownIso) : undefined), [demo, shownIso]);
  const liveDebrief = demo ? undefined : `${api.base}/missions/${encodeURIComponent(missionId)}/debrief.md`;
  const actions = useMemo(() => storeActions(), []);

  if (s.status === "error") {
    return (
      <div className="flex min-h-dvh flex-col">
        <AppBar mission={{ name: missionId === "demo" ? "Mount Seymour (demo)" : `Mission ${missionId}`, mode: "offline", clock: null }} />
        <Page>
          <Panel role="alert" className="flex max-w-2xl flex-col gap-3">
            <h1 className="text-title font-medium text-text">Could not open mission {missionId}</h1>
            <p className="text-body text-text-2">{s.error}</p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="primary" href={DEMO_CONSOLE_HASH}>
                Open the demo mission
              </Button>
              <Button href="#new">New search</Button>
            </div>
          </Panel>
        </Page>
      </div>
    );
  }

  // ---- the rails ----
  const frameCount = s.mapUpdates.filter((u) => u.source === "frame").length;
  const landed = demo ? landedFrames(cache, frameCount) : null;
  // the demo's queue: photos dropped in this browser first, then the survey's candidates at this clock
  // the scenario's distractor frames (licensed ground-level photos of objects placed in the flight) join the
  // queue once their second look is on the timeline, and stay until the visitor answers them
  const distractors = demo ? distractorCards(s.distractors, s.timeline, s.events) : [];
  // (no survey photo has landed while the drones wait on the ground: no AI re-check catch either)
  // each known survey photo carries the AI's pick against this scenario's subject (command/subjectMatch.ts)
  const cards = demo
    ? [...dropped.cards, ...distractors, ...demoCards(cache, landed ?? [], imageUrl, frameCount > 0 && new Date(clockIso).getTime() >= new Date(checkpoint(2).at).getTime() + (gOpts?.dronesLate ?? 0))].map((c) => {
        const pick = aiPick(c.id, s.mission?.subject);
        return pick ? { ...c, pick: pick.line, pickAnswer: pick.answer } : c;
      })
    : [];
  const answerDemo = (id: string, a: LiveAnswer, object?: ObjectKind) => {
    answerRef.current = answerDemo;
    useStory.getState().answer(id, a);
    if (a === "object") {
      // an object: the clue candidate the server would make (contract 15.7), low reliability until a team confirms it
      const mine = dropped.at[id];
      const d = s.distractors?.find((x) => x.detection_id === id);
      const at = d ? { lat: d.lat, lon: d.lon } : mine ? { lat: mine.lat, lon: mine.lon } : candidatePosition(cache, id);
      if (at && !s.clues.some((c) => c.detection_id === id)) {
        const clue = objectClue(id, object ?? "other", at, d?.clue ?? `o-${id}`, clockIso);
        useMission.getState().emit("clue.added", `object: ${clue.text}`, clue.id, clue);
      }
      return;
    }
    if (a !== "person" && a !== "group") return;
    const mine = dropped.at[id];
    const at = mine ? { lat: mine.lat, lon: mine.lon, frame: mine.photo, conf: mine.conf } : candidatePosition(cache, id);
    if (at && !s.clues.some((c) => c.text.includes(id))) {
      const draft = {
        kind: "sighting" as const,
        text: `${a === "group" ? "a group of people (2+)" : "person"} confirmed in Review photos, survey photo ${at.frame.replace(/^f0*/, "")} (score ${at.conf.toFixed(2)})`,
        lat: at.lat,
        lon: at.lon,
        at_team_position: false,
        radius_m: 10,
        reliability: "high" as const,
        reported_by: "command",
        source: "form" as const,
        confirmed_by_turn: null,
      };
      // the guided search's clock moves on past the fixtures' clues: an id of its own, never c00n again
      if (guided) useMission.getState().emit("clue.added", `sighting: ${draft.text}`, `s-${id}`, { ...draft, id: `s-${id}`, at: clockIso, confirmed: true });
      else void useMission.getState().addClue(draft);
    }
  };
  answerRef.current = answerDemo;
  const tried = story.tried ? <TriedCard tried={story.tried} onClose={() => useStory.getState().setTried(null)} /> : undefined;
  const tryPanel = cache ? (
    <Suspense fallback={loading("the detector")}>
      <TryPhoto
        cache={cache}
        dir={DEMO_DIR}
        onResult={(r) => {
          useStory.getState().setTried(r);
          go("map");
          toNeeds();
        }}
      />
    </Suspense>
  ) : (
    <p className="text-small text-text-3">Loading the detector's settings…</p>
  );
  const progress = photoProgress(s);
  // phones: the photos land in a strip right above the map, so the map stays in view while they do
  const photoStrip =
    view === "photos" && landed ? (
      <PhotoStrip
        landed={landed}
        total={cache?.survey.frames.length ?? 0}
        candidates={landed.reduce((n, f) => n + f.n_candidates, 0)}
        playing={story.playing}
        imageUrl={imageUrl}
      />
    ) : undefined;
  const photosRail = (
    <PhotosRail
      landed={landed}
      total={cache?.survey.frames.length ?? 0}
      candidates={landed ? landed.reduce((n, f) => n + f.n_candidates, 0) : progress.candidates}
      playing={demo && story.playing}
      imageUrl={(rel) => cacheUrl(DEMO_DIR, rel)}
      tryPanel={tryPanel}
      tryOpen={tryOpen}
      onTry={() => setTryOpen(!tryOpen)}
      drop={<PhotoDrop demo={demo} cache={cache} dir={DEMO_DIR} api={api} missionId={missionId} />}
      live={
        demo ? undefined : (
          <>
            <section aria-label="Progress" className="grid grid-cols-3 gap-3 rounded-lg border border-line bg-surface-solid p-3">
              <Stat value={progress.processed} label="Processed" />
              <Stat value={progress.medianS === null ? "–" : progress.medianS < 1 ? `${Math.round(progress.medianS * 1000)} ms` : `${progress.medianS.toFixed(1)} s`} label="Per photo" />
              <Stat value={progress.candidates + s.promoted.length} label="Photos to review" />
            </section>
            <UploadPanel api={api} missionId={missionId} processed={progress.processed} />
            <WatchPanel base={api.base} missionId={missionId} />
          </>
        )
      }
    />
  );
  // the review cards live in Needs you: the demo's queue, or a live mission's candidates
  const reviewCount = demo ? (run.on ? run.cards(cards) : cards).filter((c) => !story.answers[c.id]).length + (story.tried ? 1 : 0) : liveReviewItems(s.detections, s.promoted).length;
  // a live mission's queue (one list for the rail and the review frame, one set of answers)
  const live = demo ? [] : liveCards(s.detections, s.survey, s.verdicts, s.promoted, (rel) => fileUrl(api, missionId, rel));
  const answerLive = (id: string, a: LiveAnswer, object?: ObjectKind) => {
    setLiveAnswers((x) => ({ ...x, [id]: a }));
    void useMission.getState().review(id, serverAnswer(a), serverObject(object));
  };
  const review =
    reviewCount > 0 || tried ? (
      demo ? (
        <ReviewRail cards={run.on ? run.cards(cards) : cards.filter((c) => !story.answers[c.id])} answers={story.answers} onAnswer={answerDemo} top={tried} empty="Photos to review appear here as the survey's photos land." />
      ) : (
        <ReviewRail cards={live} answers={liveAnswers} onAnswer={answerLive} top={tried} />
      )
    ) : null;
  const reviewFrame = demo ? { cards: run.on ? run.cards(cards) : cards, answers: story.answers, onAnswer: answerDemo, step: run.photoStep } : { cards: live, answers: liveAnswers, onAnswer: answerLive };
  const debrief = (
    <Suspense fallback={loading("the debrief")}>
      <Debrief
        missionName={s.mission?.name ?? "…"}
        so={s}
        metrics={cache?.metrics ?? null}
        cellM={cache?.map.grid.cell_m}
        surveyId={cache?.survey.survey_id}
        judgesOpen={!!route.open.judges}
        traceHref={viewHash(missionId, "trace")}
        liveDebriefUrl={liveDebrief}
        exports={{ missionUrl: demo ? null : `${api.base}/missions/${encodeURIComponent(missionId)}`, teams: s.teams }}
        report={s.mission?.status === "found" ? <MissionReport data={s} now={demoNow ?? new Date()} missionUrl={demo ? null : `${api.base}/missions/${encodeURIComponent(missionId)}`} /> : undefined}
      />
    </Suspense>
  );
  const rightRail: ReactNode = view === "photos" ? photosRail : view === "debrief" ? debrief : undefined;
  const cover =
    view === "trace" ? (
      <div className="flex flex-col gap-3 p-1">
        <div className="flex items-center gap-0.5 self-start rounded-full border border-line bg-surface-solid p-0.5" role="group" aria-label="Trace or event log">
          {[
            { on: !logOpen, label: "The agent's trace", set: false },
            { on: logOpen, label: "Event log", set: true },
          ].map((x) => (
            <button key={x.label} type="button" aria-pressed={x.on} onClick={() => setLogOpen(x.set)} className={`sl-tap rounded-full px-3.5 py-1 text-small ${x.on ? "bg-surface-strong text-text" : "text-text-2 hover:text-text"}`}>
              {x.label}
            </button>
          ))}
        </div>
        {logOpen ? <EventFeed events={s.events} /> : <TraceTab api={api} missionId={missionId} demo={demo} example={demo && effSeed !== DEFAULT_SEED} />}
      </div>
    ) : undefined;
  const callsign = (id: string | null) => s.teams.find((t) => t.id === id)?.callsign ?? id ?? "";
  const briefings = radioApi ? <Briefings api={radioApi} callsign={callsign} /> : undefined;

  // ---- the bar ----
  /** "Follow the search" (the bar, the pitch bar): the guided search on this scenario. */
  const followSearch = () => {
    window.location.hash = guideHash(seed);
  };
  const t = story.t;
  const action: BarAction | null = demo
    ? story.pitch || guided
      ? null // (free play's way to the guided search is on its clock bar)
      : {
          // the walk-through is the guided search: each decision waits for you ("Watch instead" inside it plays the agent's)
          label: "Follow the search",
          onClick: followSearch,
        }
    : { label: "New search", href: "#new" };
  const barAt = demo ? new Date(run.missionClock ?? clockIso) : new Date();
  const barClock = demo || s.mission ? clockWithZone(barAt, clockZone.tz) : null;
  const barTitle = `Mission clock · ${utcLabel(barAt)}`;
  // once the subject is found, pending proposals and candidates are closed (Needs you folds them away)
  const needsCount = s.mission?.status === "found" ? 0 : (run.on ? run.proposals(s.proposals) : s.proposals).filter((p) => p.status === "pending").length + reviewCount;
  const inStory = demo && !guided && story.playing;

  return (
    <ClockZone.Provider value={clockZone}>
      <div className="flex min-h-dvh flex-col lg:h-dvh">
        <AppBar
          mission={{ name: (s.mission?.name ?? (demo ? "Mount Seymour" : "…")).replace(/\s*\(demo\)$/i, ""), mode: demo ? "demo" : modeOf(s.status), clock: barClock, clockTitle: barTitle, disclose: demo }}
          views={{ current: view, onSelect: go, counts: { photos: inStory ? frameCount || undefined : undefined } }}
          tabs={{
            current: tab,
            needs: needsCount || undefined,
            onSelect: (x) => {
              useConsole.getState().setTab(x);
              if (x === "needs") toNeeds();
              else if (x === "timeline") show("console-timeline");
              else show("console-map");
            },
          }}
          action={action}
          status={
            ready && view !== "trace" ? (
              <StatusLine
                mission={s.mission}
                conditions={s.conditions}
                teams={teams}
                clues={s.clues}
                now={demoNow ?? new Date()}
                tz={clockZone.tz}
                conditionsOpen={condOpen}
                conditionsId={condId}
                disclose={demo}
                outside={outsideGrid(s.sectors)}
                onConditions={conditionsData ? () => setCondOpen((o) => !o) : undefined}
                onSubject={() => useConsole.getState().setProfile(true)}
                menu={
                  <>
                    <span className="text-caption text-text-3" title={barTitle}>
                      {barClock}
                    </span>
                  </>
                }
              />
            ) : null
          }
          extra={
            <button type="button" onClick={() => setKeysOpen(true)} className="sl-tap hidden h-8 w-8 items-center justify-center rounded-full border border-line text-small text-text-2 hover:text-text md:inline-flex" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
              ?
            </button>
          }
        />
        {/* which search is on screen, and the home page's cards to change it (front/ScenarioBanner.tsx) */}
        {/* the subject brief, always on the console (command/SubjectStrip.tsx): who, last seen when and where, LKP */}
        {demo ? (
          <ScenarioBanner seed={seed} name={scenarioName} setupHref={playSetup ? PLAY_HASH : null} area={s.mission?.area?.name ?? "Mount Seymour"} clock={barClock} brief={ready ? <SubjectStrip mission={s.mission} now={demoNow ?? new Date()} tz={clockZone.tz} place={cardFor(seed).lastSeen} /> : null} />
        ) : (
          ready &&
          s.mission && (
            <div className="flex min-h-9 shrink-0 items-center border-b border-line bg-surface px-3 py-1.5 lg:px-4">
              <SubjectStrip mission={s.mission} now={new Date()} tz={clockZone.tz} />
            </div>
          )
        )}
        {keysOpen && <ShortcutOverlay groups={SHORTCUT_GROUPS} onClose={() => setKeysOpen(false)} />}
        {demo && story.pitch && (
          <PitchBar
            onFollow={followSearch}
            onSkip={() => {
              useStory.getState().skipToNow();
              setView("map");
            }}
          />
        )}
        {/* a phone's coach mark sits along the bottom: room under the last panel so any target can scroll to the top */}
        <main className={`flex min-h-0 flex-1 flex-col gap-3 p-2 pb-20 lg:p-3 lg:pb-3 ${guided && !freePlay ? "max-sm:pb-[55vh]" : ""}`}>
          {s.error && (
            <p role="alert" className="text-small text-warn">
              {s.error}
            </p>
          )}
          {/* the demo console appears whole once its fixtures are in (nothing on screen moves as they arrive) */}
          {!ready ? (
            <p role="status" className="text-small text-text-3">
              Loading the demo mission…
            </p>
          ) : (
            <CommandView
              mission={s.mission}
              status={s.status}
              conditions={s.conditions}
              tasks={s.tasks}
              sectors={s.sectors}
              teams={teams}
              clues={s.clues}
              proposals={run.on ? run.proposals(s.proposals) : s.proposals}
              events={s.events}
              timeline={s.timeline}
              fleet={s.fleet}
              links={s.links}
              imageUrl={imageUrl}
              clueNote={clueNote}
              onAddClue={(draft) => useMission.getState().addClue(draft)}
              actions={actions}
              cardHref={demo ? undefined : (sector) => `#m/${missionId}/card/${encodeURIComponent(sector)}`}
              now={demoNow ? () => demoNow : undefined}
              feedHref={`${viewHash(missionId, "trace")}?log`}
              rightRail={rightRail}
              rightWide={view === "debrief"}
              aboveMap={photoStrip}
              cover={cover}
              review={review}
              reviewCount={reviewCount}
              reviewFrame={reviewFrame}
              autoReview={!demo}
              briefings={briefings}
              storyProposal={run.on ? run.proposal : null}
              needsHighlight={run.needsHighlight}
              dock={run.dock}
              lead={run.lead}
              standing={run.standing}
              voice={voice}
              conditionsData={conditionsData}
              conditionsOpen={condOpen && view === "map"}
              conditionsId={condId}
              map={
                still ? (
                  // the map loads under the still image, which fades out once the map has drawn
                  <div className="relative h-full min-h-[360px]">
                    {mapOn && (
                      <div className="absolute inset-0">
                        <Suspense fallback={null}>
                          <LiveHeatMap mapBase={s.mapBase} updates={s.mapUpdates} sectors={s.sectors} clues={s.clues} teams={teams} fleet={s.fleet} proposals={s.proposals} mission={s.mission} tasks={s.tasks} actions={actions} now={demoNow} candidateAt={candidateAt} fill onReady={onMapReady} />
                        </Suspense>
                      </div>
                    )}
                    {stillPhase !== "gone" && (
                      <div className={`absolute inset-0 z-[1] transition-opacity duration-300 ease-out motion-reduce:transition-none ${stillPhase === "fading" ? "pointer-events-none opacity-0" : ""}`}>
                        <MapStill demo={demo} loading={wanted !== null} onLoad={() => setWanted("tap")} />
                      </div>
                    )}
                  </div>
                ) : mapOn ? (
                  <Suspense fallback={MAP_FRAME}>
                    <LiveHeatMap mapBase={s.mapBase} updates={s.mapUpdates} sectors={s.sectors} clues={s.clues} teams={teams} fleet={s.fleet} proposals={s.proposals} mission={s.mission} tasks={s.tasks} actions={actions} now={demoNow} candidateAt={candidateAt} fill />
                  </Suspense>
                ) : (
                  MAP_FRAME
                )
              }
              overMap={
                inStory ? (
                  <Scrubber
                    t={t}
                    progress={story.progress}
                    playing={story.playing}
                    at={clockIso}
                    canPlay
                    through={story.through}
                    onToggle={() => {
                      const st = useStory.getState();
                      if (st.progress >= 1 && view === "debrief") setView("map");
                      st.play();
                    }}
                    onSeek={(to) => {
                      const st = useStory.getState();
                      st.seek(to, { animate: to === st.t + 1 });
                      setView(to === LAST ? "debrief" : view === "debrief" ? "map" : view);
                    }}
                    onSkip={() => {
                      useStory.getState().skipToNow();
                      setView("map");
                    }}
                  />
                ) : (run.clockBar ?? undefined)
              }
              onPickOnMap={() => {
                document.querySelector("figure[aria-label='Live map'], [data-testid='map-still']")?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
                return usePick.getState().request();
              }}
              onDecide={(pid, decision, by, reason, edits) => {
                if (run.on) return run.decide(pid, decision, by, reason, edits);
                const p = s.proposals.find((x) => x.id === pid);
                const done = useMission.getState().decide(pid, decision, by, reason, edits);
                // while the visitor decides, an approved assignment sends the team (sim.ts plays the pass)
                const team = edits?.team ?? p?.target.team;
                if (hold && decision === "approve" && p?.kind === "assign_sector" && p.target.sector && team) return done.then(() => useMission.getState().assign(team, p.target.sector!));
                return done;
              }}
            />
          )}
        </main>
        {ready && run.overlay}
      </div>
    </ClockZone.Provider>
  );
}

/** Your own photo from Try a photo, at the top of the Review rail: what the detector flagged, on your device. */
function TriedCard({ tried, onClose }: { tried: TriedPhoto; onClose: () => void }) {
  const n = tried.boxes.length;
  return (
    <div role="group" aria-label="Your photo" className="flex flex-col gap-2 rounded-lg border border-accent/40 bg-surface-solid p-2.5">
      <div className="relative overflow-hidden rounded-sm bg-surface-strong">
        <img src={tried.url} alt={tried.name} className="block max-h-56 w-full object-contain" />
        <Suspense fallback={null}>
          <BoxLayer shown={{ url: tried.url, name: tried.name, width: tried.width, height: tried.height }} boxes={tried.boxes} />
        </Suspense>
      </div>
      <p className="text-small text-text-2">
        <span className="text-text">Your photo:</span> {n} {n === 1 ? "person" : "people"} flagged in {(tried.ms / 1000).toFixed(1)} s on this device. It has
        no position on this mission, so nothing is pinned.
      </p>
      <button type="button" onClick={onClose} className="sl-tap self-start text-caption text-text-3 underline hover:text-text">
        Remove
      </button>
    </div>
  );
}

/**
 * The console's Conditions panel data. Live: the mission's conditions with the quotes from its trace (the
 * Conditions object carries the values, the pages read and the alerts' URLs; the quotes and the searches
 * are only in the trace), re-read whenever new conditions arrive. Demo: a recorded lookup.
 */
function useConditionsData(
  api: Api,
  missionId: string,
  demo: boolean,
  conditions: Conditions | null,
  fleet: FleetState | null,
): [ConditionsData | null, boolean] {
  const [recorded, setRecorded] = useState<ConditionsData | null>(null);
  const [recordedTried, setRecordedTried] = useState(false);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  useEffect(() => {
    let live = true;
    if (demo)
      void loadDemoConditions()
        .then((d) => live && setRecorded(d), () => undefined)
        .finally(() => live && setRecordedTried(true));
    else if (conditions) getTrace(api, missionId).then((t) => live && setTrace(t), () => undefined);
    return () => {
      live = false;
    };
  }, [api, missionId, demo, conditions?.fetched_at]); // re-read the trace when new conditions arrive
  const lookup = useMemo(() => latestLookup(trace), [trace]);
  const waiting = demo && !recordedTried;
  if (!conditions) return [null, waiting];
  const drones = fleet?.drones ?? [];
  const weakest = drones.length ? drones.reduce((a, b) => (b.max_wind_kmh < a.max_wind_kmh ? b : a)) : null;
  const limit = { kmh: weakest?.max_wind_kmh ?? null, drone: weakest?.name ?? null };
  // the demo: its own conditions on top (the same verdict as the row), the recorded lookup folded under them
  if (demo) return [recorded ? demoConditionsData(conditions, recorded, limit) : null, waiting];
  return [{ conditions, lookup, recorded: null, limitKmh: limit.kmh, drone: limit.drone }, false];
}

const TRACE_POLL_MS = 4000;

/** The Trace view: the live mission's trace (polled with `after`), or the demo's recorded runs. */
function TraceTab({ api, missionId, demo, example = false }: { api: Api; missionId: string; demo: boolean; example?: boolean }) {
  const [runs, setRuns] = useState<TraceRun[] | null>(null);
  const [imageUrl, setImageUrl] = useState<(rel: string) => string | null>(() => (rel: string) => fileUrl(api, missionId, rel));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (demo) {
      loadDemoTrace().then(
        (t) => {
          if (!live) return;
          // another scenario on screen: the demo's own trace is the overdue hiker's, so it says so (never "this mission")
          setRuns(example ? t.runs.map((r) => (r.mode === "demo" ? { ...r, label: EXAMPLE_TRACE_LABEL, mode: "replay" as const } : r)) : t.runs);
          setImageUrl(() => t.imageUrl);
        },
        (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
      );
      return () => {
        live = false;
      };
    }
    let entries: TraceEntry[] = [];
    const poll = () =>
      getTrace(api, missionId, entries.at(-1)?.id).then(
        (more) => {
          if (!live) return;
          setError(null);
          if (more.length || entries.length === 0) {
            entries = [...entries, ...more];
            setRuns([{ label: null, source: null, entries }]);
          }
        },
        (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
      );
    void poll();
    const id = setInterval(() => void poll(), TRACE_POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [api, missionId, demo, example]);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-small text-text-2">
        Every step the agent took, grouped from what it saw to what a person decided: perception → decision → action → approval. Open a step for its full input and output.
        {demo && (example ? " Here: an example trace from the Overdue hiker mission (generated offline with fake models and scripted people, as labelled; this scenario has none of its own), then two runs recorded live, copied from the repository." : " On the demo: this mission's own trace (generated offline with fake models and scripted people, as labelled), then two runs recorded live, copied from the repository.")}
      </p>
      {error && (
        <p role="alert" className="text-small text-caution">
          Could not read the trace: {error}
        </p>
      )}
      {runs === null ? <p className="text-small text-text-3">Loading the trace…</p> : <Suspense fallback={loading("the trace")}><TraceView runs={runs} imageUrl={imageUrl} /></Suspense>}
    </div>
  );
}

/** A sector's printable assignment card (`#m/<id>/card/<sector>`, live missions). */
export function LiveCard({ api, missionId, sector }: { api: Api; missionId: string; sector: string }) {
  const [card, setCard] = useState<AssignmentCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getCard(api, missionId, sector).then(
      (c) => live && setCard(c),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [api, missionId, sector]);
  return (
    <main className="mx-auto max-w-5xl p-4 lg:p-8 print:p-0">
      {error ? (
        <p role="alert" className="text-body text-warn">
          No card for sector {sector}: {error}.{" "}
          <a className="underline" href={viewHash(missionId, "map")}>
            Back to the console
          </a>
        </p>
      ) : !card ? (
        <p className="text-small text-text-3">Loading the card for sector {sector}…</p>
      ) : (
        <Suspense fallback={loading("the card")}>
          <AssignmentCardView
            card={card}
            gpxUrl={cardFileUrl(api, missionId, sector, "gpx")}
            kmlUrl={cardFileUrl(api, missionId, sector, "kml")}
            imageUrl={(rel) => fileUrl(api, missionId, rel)}
            backHref={viewHash(missionId, "map")}
          />
        </Suspense>
      )}
    </main>
  );
}

