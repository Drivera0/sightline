// New search (LANE_D §5.6, D-I1) as the console's empty state, at #new: the same bar, an empty map (click
// it for the last known position) and one sheet over it with the two ways in: start a search (the mission's
// details; photos then go in from the Photos view, dropped in or watched from a folder) or load the demo
// mission. Without a mission server (the public site) the form says when the server runs. Built by lane A.

import { lazy, Suspense, useCallback, useState, type FormEvent } from "react";
import * as defaultApi from "../lib/api";
import type { Api } from "../lib/api";
import { AppBar, lastMission } from "../shell/AppBar";
import { Button, Label } from "../shell/components";
import { DEMO_CONSOLE_HASH } from "../shell/flow";

export interface NewSearchProps {
  /** null: no mission server (the demo-only site). */
  api: Api | null;
  /** Called with the new mission's id (App routes to #m/<id>/photos). */
  onCreated: (missionId: string) => void;
  createMission?: typeof defaultApi.createMission;
}

// The map loads on its own (MapLibre is large; the form works without it).
const LkpPicker = lazy(() => import("./LkpPicker").then((m) => ({ default: m.LkpPicker })));

const field = "rounded-sm border border-border bg-surface-strong px-3 py-2 text-body text-text disabled:opacity-50";

export function NewSearch({ api, onCreated, createMission = defaultApi.createMission }: NewSearchProps) {
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [lastSeen, setLastSeen] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [area, setArea] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const picked = useCallback((p: { lat: number; lon: number }) => {
    setLat(p.lat.toFixed(6));
    setLon(p.lon.toFixed(6));
  }, []);
  const off = api === null;
  const back = off ? null : lastMission();

  const latN = Number(lat);
  const lonN = Number(lon);
  const lkpOk = lat !== "" && lon !== "" && Math.abs(latN) <= 90 && Math.abs(lonN) <= 180;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!api) return;
    if (!name.trim() || !lkpOk) {
      setError(!name.trim() ? "Give the search a name." : "The last known position needs a latitude (−90 to 90) and longitude (−180 to 180): type it, or click the map.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const m = await createMission(api, {
        name: name.trim(),
        area_name: area.trim() || name.trim(),
        lkp: { lat: latN, lon: lonN },
        subject: subject.trim() || null,
        last_seen_at: lastSeen ? new Date(lastSeen).toISOString() : null,
        mode: "live",
      });
      onCreated(m.mission_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh">
      <AppBar action={back ? { label: "Back to your mission", href: `#m/${back}/map` } : null} />
      <main className="relative flex min-h-0 flex-1 flex-col gap-3 p-3 lg:block lg:px-4">
        <Suspense fallback={<div className="h-[40vh] rounded-lg border border-line bg-surface-solid lg:absolute lg:inset-3" />}>
          <div className="order-2 h-[40vh] lg:absolute lg:inset-3 lg:h-auto">
            <LkpPicker point={lkpOk ? { lat: latN, lon: lonN } : null} onPick={picked} zoom={14} className="h-full rounded-lg border border-border" />
          </div>
        </Suspense>
        <section
          aria-label="Start a search"
          className="sl-sheet relative z-10 order-1 flex max-h-full w-full flex-col gap-4 overflow-y-auto rounded-lg border border-line bg-surface-solid p-4 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.85)] lg:absolute lg:left-7 lg:top-7 lg:max-h-[calc(100%-3.5rem)] lg:w-[26rem] lg:p-5"
        >
          <div className="flex flex-col gap-1">
            <Label>New search</Label>
            <h1 className="text-title font-medium text-text">Drop photos or watch a folder</h1>
            <p className="text-small text-text-2">
              Say who you're looking for and where they were last seen (click the map). Then photos from the drone go in as they come back: drop them in
              after a flight, or let the laptop watch the SD card. Sightline ranks them, pins candidates on the map and updates where to look next.
            </p>
          </div>
          {off && (
            <p role="status" className="rounded-sm border border-line bg-surface-strong px-3 py-2 text-small text-text-2">
              The live mission server runs during demos and judging; this site is the demo. The same console runs on a pre-seeded mission, with no server.
            </p>
          )}
          <form onSubmit={submit} className="flex flex-col gap-3" aria-label="Mission details">
            <fieldset disabled={off} className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-small text-text-2">
                Search name
                <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Seymour — missing hiker" />
              </label>
              <label className="flex flex-col gap-1 text-small text-text-2">
                Who we're looking for
                <input className={field} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="adult, red jacket, day hiker" />
              </label>
              <label className="flex flex-col gap-1 text-small text-text-2">
                Last seen
                <input className={field} type="datetime-local" value={lastSeen} onChange={(e) => setLastSeen(e.target.value)} />
              </label>
              <div className="flex flex-col gap-1 text-small text-text-2">
                <span>Last known position (or click the map)</span>
                <div className="flex gap-2">
                  <input aria-label="Latitude" className={`${field} w-0 flex-1`} inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="49.3745" />
                  <input aria-label="Longitude" className={`${field} w-0 flex-1`} inputMode="decimal" value={lon} onChange={(e) => setLon(e.target.value)} placeholder="-122.9358" />
                </div>
                <input aria-label="Area name" className={field} value={area} onChange={(e) => setArea(e.target.value)} placeholder="Area: Mount Seymour" />
              </div>
            </fieldset>
            {error && (
              <p role="alert" className="text-small text-warn">
                {error}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {off ? (
                <Button href={DEMO_CONSOLE_HASH} variant="primary" size="lg">
                  Load the demo mission
                </Button>
              ) : (
                <>
                  <Button type="submit" variant="primary" size="lg" disabled={busy}>
                    {busy ? "Creating…" : "Start the search"}
                  </Button>
                  <Button href={DEMO_CONSOLE_HASH} variant="ghost">
                    Load the demo mission
                  </Button>
                </>
              )}
            </div>
          </form>
        </section>
      </main>
    </div>
  );
}
