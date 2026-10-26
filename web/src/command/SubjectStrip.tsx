// The subject brief (the cold test's first question: who is missing, where and when last seen): a fixed
// strip under the status line, always on the console, guided or not. The profile, last seen time and
// place and how long ago in the mission's local time, and LKP, which centres the map on the last known
// point. "Profile" (and "Subject not found" on the status line) opens the full profile. The words come
// from the mission (Mission.subject, last_seen_at, area.lkp, base_camp) and, on the demo, the scenario
// card's place (front/scenarios.ts). Built by lane A.
import { useEffect, useRef } from "react";
import type { Mission } from "../contract";
import { clock, type Tz } from "../lib/time";
import { Icon } from "../shell/icons";
import { duration } from "./console";
import { useConsole } from "./consoleStore";

/** "adult, red jacket, day hiker" → "Adult, red jacket, day hiker". */
export const profileWords = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What the strip says, pure: the profile, "10:30", "3 h 05 min ago", and the place. */
export function subjectBrief(mission: Mission | null, now: Date, tz: Tz, place: string | null = null): { profile: string; seen: string | null; ago: string | null; place: string } | null {
  if (!mission) return null;
  const profile = mission.subject ? profileWords(mission.subject) : "Subject not described yet";
  const seenAt = mission.last_seen_at;
  const min = seenAt ? (now.getTime() - new Date(seenAt).getTime()) / 60_000 : null;
  return {
    profile,
    seen: seenAt ? clock(seenAt, tz) : null,
    ago: min !== null && min >= 0 ? `${duration(min)} ago` : null,
    place: place ?? "at the last known point",
  };
}

export function SubjectStrip({ mission, now, tz, place = null }: { mission: Mission | null; now: Date; tz: Tz; place?: string | null }) {
  const b = subjectBrief(mission, now, tz, place);
  const open = useConsole((s) => s.profile);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && useConsole.getState().setProfile(false);
    const onDown = (e: PointerEvent) => !box.current?.contains(e.target as Node) && useConsole.getState().setProfile(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);
  if (!b || !mission) return null;
  const lkp = mission.area?.lkp;
  return (
    <div ref={box} role="region" aria-label="Subject" className="relative flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-small">
      <Icon name="found" size={14} className="shrink-0 text-accent" />
      <span className="font-medium text-text">{b.profile}</span>
      {b.seen && (
        <>
          <span className="text-text-3">·</span>
          <span className="text-text">
            last seen {b.seen} {b.place}
            {b.ago && <span className="text-text-2"> · {b.ago}</span>}
          </span>
        </>
      )}
      {lkp && (
        <button
          type="button"
          onClick={() => useConsole.getState().centreOn(lkp.lat, lkp.lon)}
          title="Centre the map on the last known point"
          className="sl-tap inline-flex h-7 items-center gap-1 rounded-full border border-border px-2.5 text-caption text-text hover:bg-surface-strong"
        >
          <span aria-hidden>◎</span> LKP
        </button>
      )}
      <button
        type="button"
        aria-expanded={open}
        aria-controls="subject-profile"
        onClick={() => useConsole.getState().setProfile(!open)}
        className="sl-tap inline-flex h-7 items-center rounded-full px-2 text-caption text-text-2 underline underline-offset-2 hover:text-text"
      >
        Profile
      </button>
      {open && (
        <div id="subject-profile" role="dialog" aria-label="Subject profile" className="absolute top-full left-0 z-[45] mt-2 w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface-solid p-4 shadow-[var(--shadow-pop)]">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-small">
            <dt className="text-text-3">Who</dt>
            <dd className="text-text">{b.profile}</dd>
            <dt className="text-text-3">Last seen</dt>
            <dd className="text-text">{b.seen ? `${b.seen} ${b.place}${b.ago ? `, ${b.ago}` : ""}` : "not reported yet"}</dd>
            {lkp && (
              <>
                <dt className="text-text-3">Last known point</dt>
                <dd className="font-mono text-text">
                  {lkp.lat.toFixed(5)}, {lkp.lon.toFixed(5)}
                </dd>
              </>
            )}
            {mission.base_camp && (
              <>
                <dt className="text-text-3">Base camp</dt>
                <dd className="text-text">{mission.base_camp.name}</dd>
              </>
            )}
            <dt className="text-text-3">Status</dt>
            <dd className="text-text">{mission.status === "found" ? "Found" : "Not found"}</dd>
          </dl>
          <button type="button" onClick={() => useConsole.getState().setProfile(false)} className="sl-tap mt-3 rounded-full border border-border px-3 py-0.5 text-caption text-text-2 hover:text-text">
            Close
          </button>
        </div>
      )}
    </div>
  );
}
