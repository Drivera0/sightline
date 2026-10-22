// The one console: a mission's map, rails and views under one app bar, for a live mission and for the
// demo mission alike. The map never unmounts; the views (Map · Photos · Review · Trace · Debrief) change
// the rail beside it or lay a sheet over the console. On the demo mission the same console is the story:
// the mission clock (missionTime.ts, story.ts) moves through six checkpoints, coach marks point at the real
// panels, and leaving the story leaves you in the console at that mission time. Built by lane A.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Api } from "../lib/api";
import { cardFileUrl, fileUrl, getCard, getHealth, getTrace } from "../lib/api";
import type { AssignmentCard, CacheBundle, Conditions, FleetState, MissionEvent, Proposal, TraceEntry } from "../contract";
import { clueLine, clueShifts } from "../command/clueShift";
import { AssignmentCardView } from "../command/AssignmentCardView";
import { CoachMark } from "../command/CoachMark";
import { Debrief } from "../command/Debrief";
import { candidatePosition, demoCards, landedFrames, RECORDED_ID } from "../command/demoReview";
import { CHECKPOINTS, checkpoint, demoAt, MARK_COUNT, STORY_PROPOSAL, type Checkpoint, type DemoFull } from "../command/missionTime";
import { PhotoStrip, PhotosRail } from "../command/PhotosRail";
import { PitchBar } from "../command/PitchBar";
import { Scrubber } from "../command/Scrubber";
import { landing, RUN_MS, storyClock, useStory } from "../command/story";
import { isTyping } from "../lib/keys";
import { cacheUrl, loadCache } from "../lib/cache";
import { photoProgress, useMission } from "../lib/mission";
import { clockWithZone, ClockZone, DEMO_TZ, utcLabel } from "../lib/time";
import { CommandView } from "../command/CommandView";
import { EventFeed } from "../command/EventFeed";
import { DEMO_MISSION_ID, demoConditionsData, demoImageUrl, loadDemoConditions, loadDemoMission, loadDemoTrace } from "../command/demoMission";
import { latestLookup } from "../command/conditions";
import type { ConditionsData } from "../command/ConditionsPanel";
import { TraceView, type TraceRun } from "../command/TraceView";
import { BoxLayer, TryPhoto, type TriedPhoto } from "../detect/TryPhoto";
import { RadioClip } from "../front/RadioClip";
import { LiveHeatMap } from "../map/heat/LiveHeatMap";
import { prefersReducedMotion } from "../metrics/motion";
import { usePick } from "../map/pick";
import { AppBar, rememberMission, type BarAction } from "../shell/AppBar";
import { Button, KeyHint, modeOf, Page, Panel, Stat } from "../shell/components";
import { DEMO_CONSOLE_HASH, VIEWS, viewHash, type Route, type View } from "../shell/flow";
import { ShortcutOverlay } from "../shell/ShortcutOverlay";
import { SHORTCUT_GROUPS } from "../shell/shortcuts";
import { RadioDesk } from "../radio/RadioDesk";
import { LiveReview, ReviewRail, type LiveAnswer } from "../review/LiveReview";
import { UploadPanel, WatchPanel } from "./UploadPanel";

export type MissionRoute = Extract<Route, { kind: "mission" }>;

/** The demo cache's folder (the Photos and Review rails, the measured results, Try a photo's samples). */
export const DEMO_DIR = "demo";

/** The demo mission, loaded once per page: the fixtures to "now" and the demo cache. */
let demoLoad: Promise<{ full: DemoFull; bundle: CacheBundle }> | null = null;
function loadDemo(): Promise<{ full: DemoFull; bundle: CacheBundle }> {
  demoLoad ??= loadCache(DEMO_DIR).then(async (bundle) => {
    const { data, now } = await loadDemoMission(fetch, undefined, Promise.resolve(bundle.map));
    return { full: { data, now }, bundle };
  });
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

/** The demo mission's clock, the story's checkpoint and the view, as an address. */
function demoHash(view: View, t: Checkpoint, tour: boolean, pitch: boolean): string {
  if (pitch) return "#m/demo";
  if (tour) return `#m/demo?t=${t}`;
  return viewHash(DEMO_MISSION_ID, view, t >= 4 ? null : t);
}

/** Each event the visitor's actions made on the demo console, under an id of its own (u0001…). */
let userSeq = 0;
const asUserEvent = (e: MissionEvent): MissionEvent => ({ ...e, id: `u${String(++userSeq).padStart(4, "0")}` });

export function LiveMission({ api, missionId, route }: { api: Api; missionId: string; route: MissionRoute }) {
  const s = useMission();
  const demo = missionId === DEMO_MISSION_ID;
  const story = useStory();
  const [view, setView] = useState<View>(() => route.view ?? (demo && route.t !== null ? checkpoint(route.t).view : "map"));
  const [keysOpen, setKeysOpen] = useState(false);
  const [tryOpen, setTryOpen] = useState(!!route.open.try);
  const [logOpen, setLogOpen] = useState(!!route.open.log);
  const [preSeen, setPreSeen] = useState<number[]>([]);
  const [demoData, setDemoData] = useState<{ full: DemoFull; bundle: CacheBundle } | null>(null);
  const [bundle, setBundle] = useState<CacheBundle | null>(null);

  // The address decides where the console opens: the landing, a checkpoint of the story, or a view.
  const routeKey = `${missionId}|${route.view}|${route.t}|${JSON.stringify(route.open)}`;
  useEffect(() => {
    if (route.open.try) setTryOpen(true);
    if (route.open.log) setLogOpen(true);
    if (!demo) {
      setView(route.view ?? "map");
      return;
    }
    const st = useStory.getState();
    if (route.view === null && route.t === null) {
      landing();
      setView("map");
    } else if (route.view === null && route.t !== null) {
      if (route.t === 0) landing();
      else st.seek(route.t, { tour: true });
      setView(checkpoint(route.t).view);
    } else if (route.view !== null) {
      if (route.t !== null) st.seek(route.t, { tour: false });
      else if (!st.started || st.tour || st.pitch) st.skipToNow();
      setView(route.view);
    }
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

  // The demo mission at the story's clock, the visitor's own actions on top.
  const clockIso = storyClock(story);
  const derivedIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!demo || !demoData) return;
    const state = demoAt(demoData.full, clockIso, story.user);
    derivedIds.current = new Set((state.events ?? []).map((e) => e.id));
    useMission.getState().useDemo(state, clockIso);
  }, [demo, demoData, clockIso, story.user]);
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

  // The story moves the view with it, and keeps the address on the moment it shows.
  useEffect(() => {
    // read now, not from this render: the address may have just ended the story (a view link)
    const st = useStory.getState();
    if (!demo || !st.tour) return;
    setView(checkpoint(st.t).view);
  }, [demo, story.tour, story.t]);
  useEffect(() => {
    // only while the address is this mission's (the About sheet keeps #about over it)
    if (!demo || !story.started || !/^#m\/demo(\/|\?|$)/.test(window.location.hash)) return;
    const want = demoHash(view, story.t, story.tour, story.pitch);
    if (window.location.hash !== want) window.history.replaceState(null, "", want);
  }, [demo, view, story.t, story.tour, story.pitch, story.started]);

  // t3's gate: the visitor's approval of the story's proposal runs the clock to t4.
  useEffect(() => {
    if (!demo || !story.tour || story.t !== 3 || story.progress < 1) return;
    const decided = story.user.some((e) => e.type === "proposal.decided" && e.ref === STORY_PROPOSAL);
    if (decided) useStory.getState().seek(4, { animate: true });
  }, [demo, story.tour, story.t, story.progress, story.user]);

  const go = useCallback(
    (v: View) => {
      setView(v);
      if (demo) {
        const st = useStory.getState();
        if (st.tour || st.pitch) st.exit();
      }
      if (!demo) window.history.replaceState(null, "", viewHash(missionId, v));
    },
    [demo, missionId],
  );
  // phones: the bottom bar's Clues brings the clue log (under the map) on screen, the Trace sheet out of the way
  const jumpToClues = () => {
    if (view === "trace") go("map");
    requestAnimationFrame(() => {
      const log = document.querySelector<HTMLElement>('[aria-label="Clue log"]');
      if (!log) return;
      log.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      if (!log.hasAttribute("tabindex")) log.setAttribute("tabindex", "-1");
      log.focus({ preventScroll: true });
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "?") setKeysOpen((o) => !o);
      else if (e.key === "Escape") setKeysOpen(false);
      else if (keysOpen) return;
      else if (e.key === "c" || e.key === "C") go("map");
      else if (/^[1-6]$/.test(e.key) && !useStory.getState().tour) go(VIEWS[Number(e.key) - 1]!.id);
      else if (e.key === " " && demo && !useStory.getState().tour && !(e.target instanceof HTMLButtonElement)) {
        // outside the story Space plays the clock on to the end, or pauses it
        e.preventDefault();
        useStory.getState().play();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, keysOpen, demo]);

  // whether this server runs the radio desk (serve --radio): the desk shows only when it does
  const [radioOn, setRadioOn] = useState(false);
  useEffect(() => {
    if (demo) return;
    getHealth(api).then((h) => setRadioOn(!!h.radio), () => setRadioOn(false));
  }, [api, demo]);

  const imageUrl = (rel: string) => (demo ? demoImageUrl(rel) : fileUrl(api, missionId, rel));
  const conditionsData = useConditionsData(api, missionId, demo, s.conditions, s.fleet);
  // which clues moved each sector, from the map log: a line on an assignment's card (clueShift.ts)
  const shifts = useMemo(() => (s.mapBase && s.sectors.length ? clueShifts(s.mapBase, s.mapUpdates, s.sectors, s.clues) : null), [s.mapBase, s.mapUpdates, s.sectors, s.clues]);
  const clueNote = (p: Proposal) => clueLine(shifts?.get(String(p.target.sector ?? "")));
  const clockZone = useMemo(() => ({ tz: demo ? DEMO_TZ : false }), [demo]);
  const demoNow = useMemo(() => (demo ? new Date(clockIso) : undefined), [demo, clockIso]);
  const waiting = s.proposals.filter((p) => p.status === "pending").length;
  const liveDebrief = demo ? undefined : `${api.base}/missions/${encodeURIComponent(missionId)}/debrief.md`;

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
  const cards = demo ? demoCards(cache, landed ?? [], imageUrl, new Date(clockIso).getTime() >= new Date(checkpoint(2).at).getTime()) : [];
  const answerDemo = (id: string, a: LiveAnswer) => {
    useStory.getState().answer(id, a);
    if (a !== "person" || id === RECORDED_ID) return;
    const at = candidatePosition(cache, id);
    if (at && !s.clues.some((c) => c.text.includes(id))) {
      void useMission.getState().addClue({
        kind: "sighting",
        text: `person confirmed by the image reviewer in ${at.frame} (${id}, detector ${at.conf.toFixed(2)})`,
        lat: at.lat,
        lon: at.lon,
        at_team_position: false,
        radius_m: 10,
        reliability: "high",
        reported_by: "command",
        source: "form",
        confirmed_by_turn: null,
      });
    }
  };
  const tried = story.tried ? <TriedCard tried={story.tried} onClose={() => useStory.getState().setTried(null)} /> : undefined;
  const tryPanel = cache ? (
    <TryPhoto
      cache={cache}
      dir={DEMO_DIR}
      onResult={(r) => {
        useStory.getState().setTried(r);
        go("review");
      }}
    />
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
      live={
        demo ? undefined : (
          <>
            <section aria-label="Progress" className="grid grid-cols-3 gap-3 rounded-lg border border-line bg-surface-solid p-3">
              <Stat value={progress.processed} label="Processed" />
              <Stat value={progress.medianS === null ? "–" : progress.medianS < 1 ? `${Math.round(progress.medianS * 1000)} ms` : `${progress.medianS.toFixed(1)} s`} label="Per photo" />
              <Stat value={progress.candidates + s.promoted.length} label="Candidates" />
            </section>
            <UploadPanel api={api} missionId={missionId} processed={progress.processed} />
            <WatchPanel base={api.base} missionId={missionId} />
          </>
        )
      }
    />
  );
  const reviewRail = demo ? (
    <ReviewRail cards={cards} answers={story.answers} onAnswer={answerDemo} top={tried} empty="Candidates appear here as the survey's photos land." />
  ) : (
    <LiveReview
      detections={s.detections}
      survey={s.survey}
      verdicts={s.verdicts}
      promoted={s.promoted}
      imageUrl={(rel) => fileUrl(api, missionId, rel)}
      onAnswer={(id, answer) => void useMission.getState().review(id, answer)}
      top={tried}
    />
  );
  const radioDesk = demo ? (
    <div className="flex flex-col gap-2 text-small text-text-2">
      <p>The radio desk runs with the mission server: teams talk to Sightline, it answers with Nemotron and NVIDIA Magpie TTS. Here is one briefing it read out.</p>
      <RadioClip />
    </div>
  ) : radioOn ? (
    <RadioDesk api={{ base: api.base, missionId }} teams={s.teams.map((t) => ({ id: t.id, callsign: t.callsign }))} />
  ) : (
    <p role="status" className="text-small text-text-2">
      The radio desk isn't running on this server. Start the API with <code>serve --radio text</code> (or <code>real</code> for voices).
    </p>
  );
  // the radio is a view of its own (the switch's Radio, key 6); under the approvals, a labelled way there
  const radioToggle = (
    <section aria-label="Radio" className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-solid px-3 py-2">
      <span className="text-small text-text-2">
        <span className="font-medium text-text">Radio</span> · teams report here
      </span>
      <button type="button" onClick={() => go("radio")} className="sl-tap rounded-full border border-border px-3 py-0.5 text-small text-text hover:border-text-3">
        Open Radio
      </button>
    </section>
  );
  const radioRail = (
    <section aria-label="Radio desk" className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5 px-1">
        <span className="text-caption font-medium text-text-2">Radio</span>
        <span className="text-caption text-text-3">Teams report by radio; Sightline answers, and a briefing goes out only when you press Transmit.</span>
      </div>
      <Panel className="p-3">{radioDesk}</Panel>
    </section>
  );
  const debrief = (
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
    />
  );
  const rightRail: ReactNode =
    view === "photos" ? photosRail : view === "review" ? reviewRail : view === "debrief" ? debrief : view === "radio" ? radioRail : undefined;
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
        {logOpen ? <EventFeed events={s.events} /> : <TraceTab api={api} missionId={missionId} demo={demo} />}
      </div>
    ) : undefined;

  // ---- the bar ----
  const t = story.t;
  const action: BarAction | null = demo
    ? story.pitch || story.tour
      ? null
      : {
          label: "Follow the search",
          onClick: () => {
            landing();
            useStory.getState().begin();
          },
        }
    : { label: "New search", href: "#new" };
  // the incident's local time ("13:35 PDT" on the demo, Mount Seymour), the same moment in UTC on hover
  const barAt = demo ? new Date(clockIso) : new Date();
  const barClock = demo || s.mission ? clockWithZone(barAt, clockZone.tz) : null;
  const barTitle = `Mission clock · ${utcLabel(barAt)}`;
  // a checkpoint's pre-mark (t3: the clue log) comes once, before its own mark
  const pre = demo && story.tour && !preSeen.includes(t) ? (CHECKPOINTS[t]?.pre ?? null) : null;
  const mark = demo && story.tour ? (pre ?? CHECKPOINTS[t]?.mark) : null;
  const markIndex = CHECKPOINTS.filter((c) => c.mark && c.t <= t).length;

  return (
    <ClockZone.Provider value={clockZone}>
      <div className="flex min-h-dvh flex-col lg:h-dvh">
        <AppBar
          mission={{ name: s.mission?.name ?? (demo ? "Mount Seymour (demo)" : "…"), mode: modeOf(s.status), clock: barClock, clockTitle: barTitle }}
          views={{
            current: view,
            onSelect: go,
            counts: { map: waiting || undefined },
            jump: { label: "Clues", title: "The clue log: what teams and the public reported", count: s.clues.length || undefined, onClick: jumpToClues },
          }}
          action={action}
          extra={
            <button type="button" onClick={() => setKeysOpen(true)} className="sl-tap hidden items-center gap-1.5 text-small text-text-2 hover:text-text md:inline-flex" title="Keyboard shortcuts">
              Shortcuts <KeyHint>?</KeyHint>
            </button>
          }
        />
        {keysOpen && <ShortcutOverlay groups={SHORTCUT_GROUPS} onClose={() => setKeysOpen(false)} />}
        {demo && story.pitch && (
          <PitchBar
            onFollow={() => useStory.getState().begin()}
            onSkip={() => {
              useStory.getState().skipToNow();
              setView("map");
            }}
          />
        )}
        {/* a phone's coach mark sits along the bottom: room under the last panel so any target can scroll to the top */}
        <main className={`flex min-h-0 flex-1 flex-col gap-3 p-3 pb-20 lg:px-4 lg:pb-3 ${mark ? "max-sm:pb-[55vh]" : ""}`}>
          {s.error && (
            <p role="alert" className="text-small text-warn">
              {s.error}
            </p>
          )}
          <CommandView
            mission={s.mission}
            status={s.status}
            conditions={s.conditions}
            tasks={s.tasks}
            sectors={s.sectors}
            teams={s.teams}
            clues={s.clues}
            proposals={s.proposals}
            imageUrl={imageUrl}
            clueNote={clueNote}
            onSetTask={(sector, body) => useMission.getState().setTask(sector, body)}
            onUpdateTeam={(id, patch) => useMission.getState().updateTeam(id, patch)}
            onAddClue={(draft) => useMission.getState().addClue(draft)}
            cardHref={demo ? undefined : (sector) => `#m/${missionId}/card/${encodeURIComponent(sector)}`}
            now={demoNow ? () => demoNow : undefined}
            feedHref={`${viewHash(missionId, "trace")}?log`}
            sideRail={radioToggle}
            rightRail={rightRail}
            rightWide={view === "debrief"}
            aboveMap={photoStrip}
            cover={cover}
            map={
              <LiveHeatMap mapBase={s.mapBase} updates={s.mapUpdates} sectors={s.sectors} clues={s.clues} teams={s.teams} fleet={s.fleet} proposals={s.proposals} now={demoNow} fill />
            }
            overMap={
              demo ? (
                <Scrubber
                  t={view === "debrief" && t === 4 && story.progress >= 1 ? 5 : t}
                  progress={story.progress}
                  playing={story.playing}
                  at={clockIso}
                  canPlay={!story.tour}
                  through={story.through}
                  hint={
                    story.tour ? null : (
                      <>
                        Press Follow the search for the 3-minute story, or play the clock and use the views <span className="lg:hidden">below</span>
                        <span className="max-lg:hidden">above</span>.
                      </>
                    )
                  }
                  onToggle={() => {
                    const st = useStory.getState();
                    if (st.tour) st.toggle();
                    else {
                      if (st.progress >= 1 && view === "debrief") setView("map");
                      st.play();
                    }
                  }}
                  onSeek={(to) => {
                    const st = useStory.getState();
                    st.seek(to, { animate: to === st.t + 1 });
                    if (!st.tour) setView(to === 5 ? "debrief" : view === "debrief" ? "map" : view);
                  }}
                />
              ) : undefined
            }
            conditionsData={conditionsData}
            conditionsOpen={!!route.open.conditions}
            onPickOnMap={() => {
              document.querySelector("figure[aria-label='Live map']")?.scrollIntoView({ behavior: "smooth", block: "center" });
              return usePick.getState().request();
            }}
            onDecide={(pid, decision, by, reason, edits) => useMission.getState().decide(pid, decision, by, reason, edits)}
          />
        </main>
        {mark && (
          <CoachMark
            text={mark.text}
            target={mark.target}
            index={markIndex}
            count={MARK_COUNT}
            last={t === 5}
            gate={!pre && checkpoint(t).gate === "approve" ? "Approve it on the card to send the team." : undefined}
            aside={mark.aside}
            onAside={mark.aside ? () => setView("radio") : undefined}
            onNext={() => (pre ? setPreSeen((s) => [...s, t]) : t === 5 ? useStory.getState().exit() : useStory.getState().next())}
            onBack={t > 1 ? () => useStory.getState().previous() : undefined}
            onExit={() => useStory.getState().exit()}
            onToggleClock={() => useStory.getState().toggle()}
          />
        )}
      </div>
    </ClockZone.Provider>
  );
}

/** Your own photo from Try a photo, at the top of the Review rail: what the detector flagged, on your device. */
function TriedCard({ tried, onClose }: { tried: TriedPhoto; onClose: () => void }) {
  const n = tried.boxes.length;
  return (
    <div aria-label="Your photo" className="flex flex-col gap-2 rounded-lg border border-accent/40 bg-surface-solid p-2.5">
      <div className="relative overflow-hidden rounded-sm bg-surface-strong">
        <img src={tried.url} alt={tried.name} className="block max-h-56 w-full object-contain" />
        <BoxLayer shown={{ url: tried.url, name: tried.name, width: tried.width, height: tried.height }} boxes={tried.boxes} />
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
function useConditionsData(api: Api, missionId: string, demo: boolean, conditions: Conditions | null, fleet: FleetState | null): ConditionsData | null {
  const [recorded, setRecorded] = useState<ConditionsData | null>(null);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  useEffect(() => {
    let live = true;
    if (demo) void loadDemoConditions().then((d) => live && setRecorded(d), () => undefined);
    else if (conditions) getTrace(api, missionId).then((t) => live && setTrace(t), () => undefined);
    return () => {
      live = false;
    };
  }, [api, missionId, demo, conditions?.fetched_at]); // re-read the trace when new conditions arrive
  const lookup = useMemo(() => latestLookup(trace), [trace]);
  if (!conditions) return null;
  const drones = fleet?.drones ?? [];
  const weakest = drones.length ? drones.reduce((a, b) => (b.max_wind_kmh < a.max_wind_kmh ? b : a)) : null;
  const limit = { kmh: weakest?.max_wind_kmh ?? null, drone: weakest?.name ?? null };
  // the demo: its own conditions on top (the same verdict as the row), the recorded lookup folded under them
  if (demo) return recorded ? demoConditionsData(conditions, recorded, limit) : null;
  return { conditions, lookup, recorded: null, limitKmh: limit.kmh, drone: limit.drone };
}

const TRACE_POLL_MS = 4000;

/** The Trace view: the live mission's trace (polled with `after`), or the demo's recorded runs. */
function TraceTab({ api, missionId, demo }: { api: Api; missionId: string; demo: boolean }) {
  const [runs, setRuns] = useState<TraceRun[] | null>(null);
  const [imageUrl, setImageUrl] = useState<(rel: string) => string | null>(() => (rel: string) => fileUrl(api, missionId, rel));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (demo) {
      loadDemoTrace().then(
        (t) => {
          if (!live) return;
          setRuns(t.runs);
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
  }, [api, missionId, demo]);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-small text-text-2">
        Every step the agent took, grouped from what it saw to what a person decided: perception → decision → action → approval. Open a step for its full input and output.
        {demo && " On the demo: this mission's own trace (generated offline with fake models and scripted people, as labelled), then two runs recorded live, copied from the repository."}
      </p>
      {error && (
        <p role="alert" className="text-small text-caution">
          Could not read the trace: {error}
        </p>
      )}
      {runs === null ? <p className="text-small text-text-3">Loading the trace…</p> : <TraceView runs={runs} imageUrl={imageUrl} />}
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
        <AssignmentCardView
          card={card}
          gpxUrl={cardFileUrl(api, missionId, sector, "gpx")}
          kmlUrl={cardFileUrl(api, missionId, sector, "kml")}
          imageUrl={(rel) => fileUrl(api, missionId, rel)}
          backHref={viewHash(missionId, "map")}
        />
      )}
    </main>
  );
}

