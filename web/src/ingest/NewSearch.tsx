// New search (LANE_D §5.6, D-I1): the mission's details, then how photos arrive (after each flight:
// drag them in; during the flight: a command on the laptop), then live progress. This is the BCS fix
// on screen: the product takes photos in. Built by lane A for lane D (issue #51).

import { lazy, Suspense, useCallback, useState, type FormEvent } from "react";
import * as defaultApi from "../lib/api";
import type { Api } from "../lib/api";
import { Label, Panel } from "../shell/components";

export interface NewSearchProps {
  api: Api;
  /** Called with the new mission's id (App routes to #m/<id>). */
  onCreated: (missionId: string) => void;
  createMission?: typeof defaultApi.createMission;
}

// The map only loads when asked for (MapLibre is large; the form works without it).
const LkpPicker = lazy(() => import("./LkpPicker").then((m) => ({ default: m.LkpPicker })));

const field = "rounded-sm border border-border bg-surface-strong px-3 py-2 text-body text-text";

export function NewSearch({ api, onCreated, createMission = defaultApi.createMission }: NewSearchProps) {
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [lastSeen, setLastSeen] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [area, setArea] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const picked = useCallback((p: { lat: number; lon: number }) => {
    setLat(p.lat.toFixed(6));
    setLon(p.lon.toFixed(6));
  }, []);

  const latN = Number(lat);
  const lonN = Number(lon);
  const lkpOk = lat !== "" && lon !== "" && Math.abs(latN) <= 90 && Math.abs(lonN) <= 180;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !lkpOk) {
      setError(!name.trim() ? "Give the search a name." : "The last known position needs a latitude (−90 to 90) and longitude (−180 to 180).");
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
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 lg:p-8">
      <header className="flex flex-col gap-1">
        <Label>New search</Label>
        <h1 className="text-title text-text">Start a live search</h1>
        <p className="text-body text-text-2">
          Photos from the drone go in as they come back; Sightline ranks them, pins candidates on the map and updates where to look
          next.
        </p>
      </header>
      <Panel>
        <form onSubmit={submit} className="flex flex-col gap-3" aria-label="Mission details">
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
          <fieldset className="flex flex-col gap-2">
            <legend className="text-small text-text-2">Last known position: type it, or pick it on the map</legend>
            <div className="flex flex-wrap gap-2">
              <input aria-label="Latitude" className={`${field} w-40`} inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="49.3745" />
              <input aria-label="Longitude" className={`${field} w-40`} inputMode="decimal" value={lon} onChange={(e) => setLon(e.target.value)} placeholder="-122.9358" />
              <input aria-label="Area name" className={`${field} min-w-0 flex-1`} value={area} onChange={(e) => setArea(e.target.value)} placeholder="Mount Seymour" />
              <button type="button" className="rounded-full border border-border px-3 py-1 text-small text-text-2" onClick={() => setShowMap(!showMap)} aria-expanded={showMap}>
                {showMap ? "Hide the map" : "Pick on the map"}
              </button>
            </div>
            {showMap && (
              <Suspense fallback={<p className="text-small text-text-3">Loading the map…</p>}>
                <p className="text-small text-text-3">Click where the person was last seen; click again to move it.</p>
                <LkpPicker point={lkpOk ? { lat: latN, lon: lonN } : null} onPick={picked} />
              </Suspense>
            )}
          </fieldset>
          {error && (
            <p role="alert" className="text-small text-warn">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy} className="self-start rounded-full border border-accent bg-accent/15 px-5 py-2 text-body text-text disabled:opacity-50">
            {busy ? "Creating…" : "Start the search"}
          </button>
        </form>
      </Panel>
    </main>
  );
}
