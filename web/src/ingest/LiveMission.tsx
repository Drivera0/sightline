// A live mission (LANE_D §5.5–5.6: D-I1 progress, D-Q1 review in live mode, D-L1 first pass):
// photos in, candidates reviewed, everything that happens in the feed, all from useMission. Lane E's
// command view and lane C's live heat mount here when they land. Built by lane A for lane D (#51).

import { useEffect, useState } from "react";
import type { Api } from "../lib/api";
import { fileUrl } from "../lib/api";
import { photoProgress, useMission } from "../lib/mission";
import { Badge, Label, Panel, Stat } from "../shell/components";
import { LiveReview } from "../review/LiveReview";
import { uploadCommand } from "./upload";
import { UploadPanel } from "./UploadPanel";

type Tab = "photos" | "review" | "feed";
const TABS: { id: Tab; label: string }[] = [
  { id: "photos", label: "Photos" },
  { id: "review", label: "Review" },
  { id: "feed", label: "Feed" },
];
const STATUS_WORDS = { idle: "", connecting: "Connecting…", live: "Live", reconnecting: "Reconnecting…", demo: "Demo", error: "Offline" };

export function tabFromHash(hash: string): Tab {
  const step = hash.split("/")[2];
  return step === "review" || step === "feed" ? step : "photos";
}

export function LiveMission({ api, missionId, initialTab = "photos" }: { api: Api; missionId: string; initialTab?: Tab }) {
  const s = useMission();
  const [tab, setTab] = useState<Tab>(initialTab);

  useEffect(() => {
    void useMission.getState().connect(missionId, api);
    return () => useMission.getState().disconnect();
  }, [api, missionId]);

  const go = (t: Tab) => {
    setTab(t);
    window.history.replaceState(null, "", `#m/${missionId}/${t}`);
  };
  const progress = photoProgress(s);

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

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 p-4 lg:p-8">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <Label>Live mission · {missionId}</Label>
          <h1 className="text-title text-text">{s.mission?.name ?? "…"}</h1>
          {s.mission?.subject && <span className="text-small text-text-2">Looking for: {s.mission.subject}</span>}
        </div>
        <span role="status" className="flex items-center gap-2">
          <Badge kind="info">{STATUS_WORDS[s.status]}</Badge>
        </span>
      </header>

      <section aria-label="Progress" className="grid grid-cols-3 gap-4">
        <Stat value={progress.processed} label="Photos processed" />
        <Stat
          value={progress.medianS === null ? "–" : progress.medianS < 1 ? `${Math.round(progress.medianS * 1000)} ms` : `${progress.medianS.toFixed(1)} s`}
          label="Median per photo"
        />
        <Stat value={progress.candidates + s.promoted.length} label="Candidates" />
      </section>

      <nav className="flex gap-2" aria-label="Mission views">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={tab === t.id}
            onClick={() => go(t.id)}
            className={`rounded-full border px-4 py-1.5 text-small ${tab === t.id ? "border-accent text-text" : "border-border text-text-2"}`}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          disabled={progress.candidates + s.promoted.length === 0}
          onClick={() => go("review")}
          className="ml-auto rounded-full border border-accent bg-accent/15 px-4 py-1.5 text-small text-text disabled:opacity-40"
        >
          Go to review
        </button>
      </nav>

      {tab === "photos" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <UploadPanel api={api} missionId={missionId} />
          <Panel className="flex flex-col gap-2" aria-label="During the flight">
            <Label>During the flight</Label>
            <p className="text-body text-text-2">
              From the laptop the drone's photos land on, send each one as it arrives (lane B's <code>watch</code> command will do
              this for a folder):
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

      {tab === "feed" && (
        <Panel aria-label="Mission feed" className="flex flex-col gap-1">
          {s.events.length === 0 && <p className="text-small text-text-3">Nothing yet.</p>}
          {[...s.events].reverse().map((e) => (
            <div key={e.id} className="flex gap-3 text-small">
              <span className="font-mono text-text-3">{e.at.slice(11, 19)}</span>
              <span className="font-mono text-text-2">{e.type}</span>
              <span className="text-text">{e.summary}</span>
            </div>
          ))}
        </Panel>
      )}
    </main>
  );
}
