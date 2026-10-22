// Fleet controls (demo and rehearsal only): make the two field problems happen on demand on a live mission with
// the simulated fleet. "Degrade link" asks the fleet sim to drop a drone's link (POST /fleet/link); "Set gusts"
// puts in a conditions record labelled "override (demo)" (POST /conditions/override), so the agent proposes
// recalling the drones in the air, quoting it. Shown only with a mission API and a simulated fleet (the server
// refuses an override for a real one). Built by lane A.
import { useState } from "react";
import type { Conditions, FleetState } from "../contract";
import { overrideConditions, postFleetLink, refreshConditions, type Api } from "../lib/api";
import type { FleetLinks } from "../lib/mission";
import { Badge, Label, StatusPill } from "../shell/components";
import { isOverride } from "./conditions";

export const DEMO_GUST_KMH = 50;
const BY = "command (demo controls)";

export function FleetControls({
  api,
  missionId,
  fleet,
  links,
  conditions,
}: {
  api: Api;
  missionId: string;
  fleet: FleetState | null;
  links: FleetLinks;
  conditions: Conditions | null;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (fleet && !fleet.simulated) return null; // a real fleet: no demo controls
  const drone = fleet?.drones.find((d) => d.id === "D2") ?? fleet?.drones[1] ?? fleet?.drones[0] ?? null;
  const link = drone ? (links.drones[drone.id]?.link ?? "connected") : null;
  const run = (what: string, f: () => Promise<unknown>) => async () => {
    setBusy(true);
    setNote(null);
    try {
      await f();
      setNote(what);
    } catch (e) {
      setNote(`${what} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const btn = "sl-tap rounded-full border border-border px-3 py-1 text-small text-text-2 hover:text-text disabled:opacity-40";
  return (
    <section aria-label="Fleet controls" className="flex flex-col gap-2 rounded-lg border border-dashed border-line bg-surface-solid p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Label>Fleet controls</Label>
        <Badge kind="simulated">Demo only</Badge>
      </div>
      {drone && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-small text-text-2">{drone.name} link</span>
          <StatusPill tone={link === "connected" ? "ok" : link === "degraded" ? "caution" : "alert"}>{link}</StatusPill>
          {link === "connected" ? (
            <button type="button" disabled={busy} className={btn} onClick={run(`asked the sim to degrade ${drone.id}'s link`, () => postFleetLink(api, missionId, drone.id, "degraded", BY))}>
              Degrade link {drone.id}
            </button>
          ) : (
            <button type="button" disabled={busy} className={btn} onClick={run(`asked the sim to restore ${drone.id}'s link`, () => postFleetLink(api, missionId, drone.id, "connected", BY))}>
              Restore {drone.id}
            </button>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          className={btn}
          onClick={run(`gusts ${DEMO_GUST_KMH} km/h set (demo override)`, () => overrideConditions(api, missionId, DEMO_GUST_KMH, BY))}
        >
          Set gusts {DEMO_GUST_KMH} km/h (demo override)
        </button>
        {isOverride(conditions) && (
          <button type="button" disabled={busy} className={btn} onClick={run("real conditions looked up again", () => refreshConditions(api, missionId))}>
            Back to the real conditions
          </button>
        )}
      </div>
      {note && (
        <p role="status" className="text-caption text-text-3">
          {note}
        </p>
      )}
    </section>
  );
}
