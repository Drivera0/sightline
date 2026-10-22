// A live mission (LANE_D §5.5–5.6: D-I1 progress, D-Q1 review in live mode, D-L1 first pass):
// photos in, candidates reviewed, everything that happens in the feed, all from useMission. Lane E's
// command view and lane C's live heat (above it, on the Command tab) mount here. Built by lane A for lane D (#51).

import { useEffect, useState } from "react";
import type { Api } from "../lib/api";
import { cardFileUrl, fileUrl, getCard, getHealth } from "../lib/api";
import type { AssignmentCard } from "../contract";
import { AssignmentCardView } from "../command/AssignmentCardView";
import { isTyping } from "../lib/keys";
import { photoProgress, useMission } from "../lib/mission";
import { ApprovalInbox } from "../command/ApprovalInbox";
import { CommandView } from "../command/CommandView";
import { EventFeed } from "../command/EventFeed";
import { DEMO_CACHE, DEMO_MISSION_ID, loadDemoMission } from "../command/demoMission";
import { LiveHeatMap } from "../map/heat/LiveHeatMap";
import { usePick } from "../map/pick";
import { Badge, Label, Panel, Stat } from "../shell/components";
import { Logo } from "../shell/Logo";
import { RadioDesk } from "../radio/RadioDesk";
import { LiveReview } from "../review/LiveReview";
import { uploadCommand } from "./upload";
import { UploadPanel } from "./UploadPanel";

type Tab = "command" | "photos" | "review" | "approvals" | "radio" | "feed";
const TABS: { id: Tab; label: string }[] = [
  { id: "command", label: "Command" },
  { id: "photos", label: "Photos" },
  { id: "review", label: "Review" },
  { id: "approvals", label: "Approvals" },
  { id: "radio", label: "Radio" },
  { id: "feed", label: "Feed" },
];
/** The demo mission has no API: no photos, review, radio, cards or debrief. */
const DEMO_TABS: readonly Tab[] = ["command", "approvals", "feed"];
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
      if ((e.key === "c" || e.key === "C") && !isTyping(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey) go("command");
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
  return (
    <Frame aria-label={embedded ? "Demo mission" : undefined} className={embedded ? "flex flex-col gap-4" : "mx-auto flex max-w-5xl flex-col gap-4 p-4 lg:p-8"}>
      {!embedded && <AppBar demo={demo} />}
      {!embedded && (
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <Label>{demo ? "Demo mission · simulated data, no server" : `Live mission · ${missionId}`}</Label>
          <h1 className="text-title text-text">{s.mission?.name ?? "…"}</h1>
          {s.mission?.subject && <span className="text-small text-text-2">Looking for: {s.mission.subject}</span>}
        </div>
        <span role="status" className="flex items-center gap-2">
          <Badge kind="info">{STATUS_WORDS[s.status]}</Badge>
        </span>
      </header>
      )}

      {!demo && (
      <section aria-label="Progress" className="grid grid-cols-3 gap-4">
        <Stat value={progress.processed} label="Photos processed" />
        <Stat
          value={progress.medianS === null ? "–" : progress.medianS < 1 ? `${Math.round(progress.medianS * 1000)} ms` : `${progress.medianS.toFixed(1)} s`}
          label="Median per photo"
        />
        <Stat value={progress.candidates + s.promoted.length} label="Candidates" />
      </section>
      )}

      <nav className="flex gap-2" aria-label="Mission views">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={tab === t.id}
            onClick={() => go(t.id)}
            className={`rounded-full border px-4 py-1.5 text-small ${tab === t.id ? "border-accent text-text" : "border-border text-text-2"}`}
          >
            {t.label}
            {t.id === "approvals" && waiting > 0 && <span className="ml-1 font-mono text-accent-soft">{waiting}</span>}
          </button>
        ))}
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

      {tab === "photos" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <UploadPanel api={api} missionId={missionId} />
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
        <LiveHeatMap mapBase={s.mapBase} updates={s.mapUpdates} sectors={s.sectors} clues={s.clues} teams={s.teams} fleet={s.fleet} proposals={s.proposals} now={demo && demoNow ? demoNow : undefined} />
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
function AppBar({ demo }: { demo: boolean }) {
  return (
    <nav aria-label="Sightline" className="flex items-center justify-between gap-4 border-b border-border pb-3">
      <a href="#" className="flex items-center gap-2 text-title font-medium text-text" title="Back to the start">
        <Logo />
        Sightline
      </a>
      <span className="flex items-center gap-4 text-small">
        {demo && (
          <a href="#survey" className="text-accent-soft underline">
            Guided demo
          </a>
        )}
        <a href="#new" className="text-text-2 underline">
          New search
        </a>
      </span>
    </nav>
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
