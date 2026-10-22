// A live mission (LANE_D §5.5–5.6: D-I1 progress, D-Q1 review in live mode, D-L1 first pass):
// photos in, candidates reviewed, everything that happens in the feed, all from useMission. Lane E's
// command view and lane C's live heat (above it, on the Command tab) mount here. Built by lane A for lane D (#51).

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Api } from "../lib/api";
import { cardFileUrl, fileUrl, getCard, getHealth, getTrace } from "../lib/api";
import type { AssignmentCard, Conditions, FleetState, TraceEntry } from "../contract";
import { AssignmentCardView } from "../command/AssignmentCardView";
import { isTyping } from "../lib/keys";
import { photoProgress, useMission, type MissionData } from "../lib/mission";
import { ApprovalInbox } from "../command/ApprovalInbox";
import { CommandView } from "../command/CommandView";
import { EventFeed } from "../command/EventFeed";
import { DEMO_CACHE, DEMO_MISSION_ID, loadDemoConditions, loadDemoMission, loadDemoTrace } from "../command/demoMission";
import { latestLookup } from "../command/conditions";
import type { ConditionsData } from "../command/ConditionsPanel";
import { TraceView, type TraceRun } from "../command/TraceView";
import { LiveHeatMap } from "../map/heat/LiveHeatMap";
import { usePick } from "../map/pick";
import { KeyHint, Label, ModeChip, modeOf, Panel, Stat } from "../shell/components";
import { ShortcutOverlay } from "../shell/ShortcutOverlay";
import { SHORTCUT_GROUPS, type ShortcutGroup } from "../shell/shortcuts";
import { Logo } from "../shell/Logo";
import { RadioDesk } from "../radio/RadioDesk";
import { LiveReview } from "../review/LiveReview";
import { uploadCommand } from "./upload";
import { UploadPanel } from "./UploadPanel";

type Tab = "command" | "photos" | "review" | "approvals" | "radio" | "feed" | "trace";
const TABS: { id: Tab; label: string }[] = [
  { id: "command", label: "Command" },
  { id: "photos", label: "Photos" },
  { id: "review", label: "Review" },
  { id: "approvals", label: "Approvals" },
  { id: "radio", label: "Radio" },
  { id: "feed", label: "Feed" },
  { id: "trace", label: "Trace" },
];
/** The demo mission has no API: no photos, review, radio, cards or debrief. Its Trace tab shows recorded runs. */
const DEMO_TABS: readonly Tab[] = ["command", "approvals", "feed", "trace"];
const STATUS_WORDS = { idle: "", connecting: "Connecting…", live: "Live", reconnecting: "Reconnecting…", demo: "Demo", error: "Offline" };

export function tabFromHash(hash: string): Tab {
  const step = hash.split("/")[2];
  return TABS.some((t) => t.id === step) ? (step as Tab) : "photos";
}

/** `#m/<id>/card/<sector>`: that sector's assignment card (E-09), else null. */
export function cardFromHash(hash: string): string | null {
  const [, , step, sector] = hash.split("/");
  return step === "card" && sector ? decodeURIComponent(sector) : null;
}

/** `embedded`: inside the guided demo's frame (its Command step), which owns the header and the address. */
export function LiveMission({ api, missionId, initialTab = "photos", embedded = false }: { api: Api; missionId: string; initialTab?: Tab; embedded?: boolean }) {
  const s = useMission();
  const demo = missionId === DEMO_MISSION_ID;
  const [tab, setTab] = useState<Tab>(demo && !DEMO_TABS.includes(initialTab) ? "command" : initialTab);
  const [demoNow, setDemoNow] = useState<Date | null>(null);
  const [demoSeed, setDemoSeed] = useState<string | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const [card, setCard] = useState<string | null>(() => cardFromHash(window.location.hash));
  useEffect(() => {
    if (embedded) return undefined;
    const onHash = () => {
      setCard(cardFromHash(window.location.hash));
      if (!cardFromHash(window.location.hash)) setTab(tabFromHash(window.location.hash));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [embedded]);

  useEffect(() => {
    if (demo) {
      loadDemoMission().then(
        ({ data, now }) => {
          useMission.getState().useDemo(data);
          setDemoNow(new Date(now));
          setDemoSeed(demoSeedWords(data));
        },
        (e: unknown) => useMission.setState({ status: "error", error: e instanceof Error ? e.message : String(e) }),
      );
      return undefined;
    }
    void useMission.getState().connect(missionId, api);
    return () => useMission.getState().disconnect();
  }, [api, missionId, demo]);
  useEffect(() => {
    // C: the Command tab (D-R1's shortcut), unless typing; in the guided demo its own C key opens this step
    if (embedded) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "?") setKeysOpen((o) => !o); // the shortcut list, as in the guided demo
      else if (e.key === "Escape") setKeysOpen(false);
      else if ((e.key === "c" || e.key === "C") && !keysOpen) go("command");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // whether this server runs the radio desk (serve --radio): the desk shows only when it does
  const [radioOn, setRadioOn] = useState(false);
  useEffect(() => {
    if (demo) return;
    getHealth(api).then((h) => setRadioOn(!!h.radio), () => setRadioOn(false));
  }, [api, demo]);
  const radioDesk = <RadioDesk api={{ base: api.base, missionId }} teams={s.teams.map((t) => ({ id: t.id, callsign: t.callsign }))} />;
  const imageUrl = (rel: string) => (demo ? `${DEMO_CACHE}/${rel}` : fileUrl(api, missionId, rel));
  const tabs = demo ? TABS.filter((t) => DEMO_TABS.includes(t.id)) : TABS;

  const go = (t: Tab) => {
    setTab(t);
    setCard(null);
    if (!embedded) window.history.replaceState(null, "", `#m/${missionId}/${t}`);
  };
  const conditionsData = useConditionsData(api, missionId, demo, s.conditions, s.fleet);
  const progress = photoProgress(s);
  const waiting = s.proposals.filter((p) => p.status === "pending").length;

  if (s.status === "error") {
    return (
      <main className="mx-auto max-w-3xl p-6" role="alert">
        <p className="text-title text-text">Could not open mission {missionId}</p>
        <p className="text-body text-text-2">{s.error}</p>
        <a className="text-accent-soft underline" href="#new">
          Start a new search
        </a>
      </main>
    );
  }

  if (card && !demo) {
    return (
      <main className="mx-auto max-w-5xl p-4 lg:p-8 print:p-0">
        <LiveCard api={api} missionId={missionId} sector={card} />
      </main>
    );
  }

  const Frame = embedded ? "section" : "main";
  // The Command tab is the console (LANE_E §7.1): full screen on its own, and inside the guided demo's frame
  // (three columns from 1280 px, stacked below). The other tabs keep the reading column.
  const isConsole = tab === "command" && !embedded;
  const consoleLayout = tab === "command";
  const frameClass = embedded
    ? consoleLayout
      ? "flex flex-col gap-3 xl:min-h-0 xl:flex-1"
      : "flex flex-col gap-4"
    : isConsole
      ? "flex flex-col gap-3 p-3 lg:h-dvh lg:px-4"
      : `mx-auto flex ${tab === "trace" ? "max-w-7xl" : "max-w-5xl"} flex-col gap-4 p-4 lg:p-8`;
  const heatMap = (
    <LiveHeatMap mapBase={s.mapBase} updates={s.mapUpdates} sectors={s.sectors} clues={s.clues} teams={s.teams} fleet={s.fleet} proposals={s.proposals} now={demo && demoNow ? demoNow : undefined} fill={consoleLayout} />
  );
  const tabNav = (
    <nav className="flex flex-wrap gap-0.5 rounded-full border border-line bg-surface-solid p-0.5" aria-label="Mission views">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          aria-pressed={tab === t.id}
          onClick={() => go(t.id)}
          className={`sl-tap rounded-full px-3.5 py-1 text-small transition-colors ${tab === t.id ? "bg-surface-strong text-text shadow-[inset_0_0_0_1px_var(--border)]" : "text-text-2 hover:text-text"}`}
        >
          {t.label}
          {t.id === "approvals" && waiting > 0 && <span className="ml-1.5 font-mono text-accent">{waiting}</span>}
        </button>
      ))}
    </nav>
  );
  return (
    <Frame aria-label={embedded ? "Demo mission" : undefined} className={frameClass}>
      {!embedded && (
        <AppBar demo={demo} onShortcuts={() => setKeysOpen(true)}>
          {isConsole && tabNav}
        </AppBar>
      )}
      {keysOpen && <ShortcutOverlay groups={MISSION_SHORTCUTS} onClose={() => setKeysOpen(false)} />}
      {!embedded && !isConsole && (
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <Label>{demo ? "Demo mission · simulated data, no server" : `Live mission · ${missionId}`}</Label>
          <h1 className="text-title text-text">{s.mission?.name ?? "…"}</h1>
          {s.mission?.subject && <span className="text-small text-text-2">Looking for: {s.mission.subject}</span>}
        </div>
        <span role="status" className="flex items-center gap-2">
          <ModeChip mode={modeOf(s.status)}>{STATUS_WORDS[s.status] || undefined}</ModeChip>
        </span>
      </header>
      )}

      {!demo && !isConsole && (
      <section aria-label="Progress" className="grid grid-cols-3 gap-4">
        <Stat value={progress.processed} label="Photos processed" />
        <Stat
          value={progress.medianS === null ? "–" : progress.medianS < 1 ? `${Math.round(progress.medianS * 1000)} ms` : `${progress.medianS.toFixed(1)} s`}
          label="Median per photo"
        />
        <Stat value={progress.candidates + s.promoted.length} label="Candidates" />
      </section>
      )}

      {!consoleLayout && (
      <nav className="flex gap-2" aria-label="Mission actions">
        {tabNav}
        {!demo && (
        <button
          type="button"
          disabled={progress.candidates + s.promoted.length === 0}
          onClick={() => go("review")}
          className="ml-auto rounded-full border border-accent bg-accent/15 px-4 py-1.5 text-small text-text disabled:opacity-40"
        >
          Go to review
        </button>
        )}
        {!demo && (
        <a
          href={`${api.base}/missions/${encodeURIComponent(missionId)}/debrief.md`}
          target="_blank"
          rel="noreferrer"
          className="rounded-full border border-border px-4 py-1.5 text-small text-text-2"
        >
          Debrief
        </a>
        )}
      </nav>
      )}

      {tab === "photos" && (
        <MissionSteps
          steps={[
            { label: "Upload photos", detail: progress.processed ? `${progress.processed} in` : "drag them in below", done: progress.processed > 0 },
            { label: "Detector ranks", detail: progress.processed ? `${progress.processed} ranked` : "about a quarter second each", done: progress.processed > 0 },
            { label: "Review candidates", detail: `${progress.candidates + s.promoted.length} to look at`, done: s.verdicts.length > 0 },
            { label: "Command", detail: waiting ? `${waiting} approvals waiting` : "the map and the proposals", done: false },
          ]}
          onStep={(i) => i === 2 ? go("review") : i === 3 ? go("command") : undefined}
        />
      )}
      {tab === "photos" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <UploadPanel api={api} missionId={missionId} processed={progress.processed} />
          <Panel className="flex flex-col gap-2" aria-label="During the flight">
            <Label>During the flight</Label>
            <p className="text-body text-text-2">
              On the laptop the drone's photos land on, watch the folder: each photo is sent once its copy has finished, batches of up
              to 10, and kept in a queue while there is no connection (replace PHOTO_FOLDER with the SD card or sync folder):
            </p>
            <code className="block overflow-x-auto rounded-sm bg-surface-strong p-2 font-mono text-small text-text">{uploadCommand(api.base, missionId)}</code>
            <button
              type="button"
              className="self-start rounded-full border border-border px-3 py-1 text-small text-text-2"
              onClick={() => void navigator.clipboard?.writeText(uploadCommand(api.base, missionId))}
            >
              Copy
            </button>
            <p className="text-small text-text-3">
              In production the drone's own cloud upload (DJI FlightHub 2) would post here directly (roadmap).
            </p>
          </Panel>
        </div>
      )}

      {tab === "review" && (
        <LiveReview
          detections={s.detections}
          survey={s.survey}
          verdicts={s.verdicts}
          promoted={s.promoted}
          imageUrl={(rel) => fileUrl(api, missionId, rel)}
          onAnswer={(id, answer) => void useMission.getState().review(id, answer)}
        />
      )}

      {s.error && (
        <p role="alert" className="text-small text-warn">
          {s.error}
        </p>
      )}

      {tab === "command" && (
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
          onSetTask={(sector, body) => useMission.getState().setTask(sector, body)}
          onUpdateTeam={(id, patch) => useMission.getState().updateTeam(id, patch)}
          onAddClue={(draft) => useMission.getState().addClue(draft)}
          cardHref={demo ? undefined : (sector) => `#m/${missionId}/card/${encodeURIComponent(sector)}`}
          now={demo && demoNow ? () => demoNow : undefined}
          sideRail={radioOn && !demo ? radioDesk : undefined}
          map={heatMap}
          wideAt={embedded ? "xl" : "lg"}
          headerStart={embedded ? tabNav : undefined}
          aboveMap={demo && demoSeed ? <DemoSeedNote words={demoSeed} /> : undefined}
          conditionsData={conditionsData}
          conditionsOpen={window.location.hash.split("/")[3] === "conditions"}
          onPickOnMap={() => {
            document.querySelector("figure[aria-label='Live map']")?.scrollIntoView({ behavior: "smooth", block: "center" });
            return usePick.getState().request();
          }}
          onDecide={(pid, decision, by, reason, edits) => useMission.getState().decide(pid, decision, by, reason, edits)}
        />
      )}

      {tab === "approvals" && (
        <ApprovalInbox
          proposals={s.proposals}
          teams={s.teams}
          imageUrl={imageUrl}
          onDecide={(pid, decision, by, reason, edits) => useMission.getState().decide(pid, decision, by, reason, edits)}
        />
      )}

      {tab === "radio" &&
        (radioOn ? (
          // The radio desk on this mission's teams (D-R3), also beside the approvals on the Command tab.
          radioDesk
        ) : (
          <p role="status" className="text-body text-text-2">
            The radio desk isn't running on this server. Start the API with <code>serve --radio text</code> (or <code>real</code> for voices).
          </p>
        ))}

      {tab === "trace" && <TraceTab api={api} missionId={missionId} demo={demo} />}

      {tab === "feed" && (
        <EventFeed
          events={s.events}
          extra={
            !demo && (
              <a className="text-small text-accent-soft underline" href={`${api.base}/missions/${encodeURIComponent(missionId)}/debrief.md`} target="_blank" rel="noreferrer">
                Debrief (markdown)
              </a>
            )
          }
        />
      )}
    </Frame>
  );
}

/** The app's top line on mission pages: the logo back to the start, and the way back to the guided demo. */
function AppBar({ demo, children, onShortcuts }: { demo: boolean; children?: ReactNode; onShortcuts: () => void }) {
  const link = "sl-tap inline-flex items-center text-text-2 underline-offset-4 hover:text-text hover:underline";
  return (
    <nav aria-label="Sightline" className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-2">
      <a href="#" className="sl-tap flex items-center gap-2 text-body font-medium text-text" title="Back to the start">
        <Logo />
        Sightline
      </a>
      {children}
      <span className="flex items-center gap-4 text-small">
        <button type="button" onClick={onShortcuts} className={`${link} flex items-center gap-1.5`} title="Keyboard shortcuts">
          Shortcuts <KeyHint>?</KeyHint>
        </button>
        {demo && (
          <a href="#survey" className={link}>
            Guided demo
          </a>
        )}
        <a href="#judges" className={link}>
          For judges
        </a>
        <a href="#new" className={link}>
          New search
        </a>
      </span>
    </nav>
  );
}

/** Where this mission is, from photos to command: done steps in green, the next one marked "now". */
function MissionSteps({ steps, onStep }: { steps: { label: string; detail: string; done: boolean }[]; onStep: (i: number) => void }) {
  const current = steps.findIndex((x) => !x.done);
  return (
    <ol aria-label="Mission progress" className="grid gap-2 sm:grid-cols-4">
      {steps.map((x, i) => (
        <li key={x.label}>
          <button
            type="button"
            onClick={() => onStep(i)}
            aria-current={i === current ? "step" : undefined}
            className={`flex w-full flex-col gap-0.5 rounded-sm border px-3 py-2 text-left ${i === current ? "border-border bg-surface-strong" : "border-line bg-surface-solid"}`}
          >
            <span className="flex items-center gap-2 text-small text-text">
              <span data-tone={x.done ? "ok" : i === current ? "neutral" : "muted"} className="sl-pill" aria-hidden>
                {x.done ? "✓" : i + 1}
              </span>
              {x.label}
              {i === current && <span className="ml-auto text-caption text-text-3">now</span>}
            </span>
            <span className="text-caption text-text-2">{x.detail}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

/** The mission page's shortcut list: the console's keys and the review's, without the guided demo's steps. */
const MISSION_SHORTCUTS: readonly ShortcutGroup[] = [
  ...SHORTCUT_GROUPS.filter((g) => g.title === "Command console" || g.title === "Review"),
  {
    title: "Everywhere",
    shortcuts: [
      { keys: ["?"], description: "Show or hide this list" },
      { keys: ["Esc"], description: "Close" },
    ],
  },
];

/** The demo mission's pre-seeded state in one sentence: what is there before anyone acts, and its date. */
export function demoSeedWords(data: Partial<MissionData>): string {
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
  return `Pre-seeded demo, scripted timeline: ${n(data.clues?.length ?? 0, "clue")}, ${n(data.proposals?.length ?? 0, "proposal")}, ${n(data.teams?.length ?? 0, "team")}. What you change stays in this tab.`;
}

function DemoSeedNote({ words }: { words: string }) {
  return (
    <p aria-label="Demo data" className="flex min-w-0 items-center gap-2 text-caption text-text-2">
      <ModeChip mode="demo" />
      <span className="truncate" title={words}>{words}</span>
    </p>
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
  if (demo) return recorded;
  if (!conditions) return null;
  const drones = fleet?.drones ?? [];
  const weakest = drones.length ? drones.reduce((a, b) => (b.max_wind_kmh < a.max_wind_kmh ? b : a)) : null;
  return { conditions, lookup, recorded: null, limitKmh: weakest?.max_wind_kmh ?? null, drone: weakest?.name ?? null };
}

const TRACE_POLL_MS = 4000;

/** The Trace tab: the live mission's trace (polled with `after`), or the demo's recorded runs. */
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
        {demo && " The demo mission's proposals are fixtures with no trace, so this shows two recorded runs from the repository instead."}
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

function LiveCard({ api, missionId, sector }: { api: Api; missionId: string; sector: string }) {
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
  if (error) {
    return (
      <p role="alert" className="text-body text-warn">
        No card for sector {sector}: {error}. <a className="underline" href={`#m/${missionId}/command`}>Back to the command view</a>
      </p>
    );
  }
  if (!card) return <p className="text-small text-text-3">Loading the card for sector {sector}…</p>;
  return (
    <AssignmentCardView
      card={card}
      gpxUrl={cardFileUrl(api, missionId, sector, "gpx")}
      kmlUrl={cardFileUrl(api, missionId, sector, "kml")}
      imageUrl={(rel) => fileUrl(api, missionId, rel)}
      backHref={`#m/${missionId}/command`}
    />
  );
}
