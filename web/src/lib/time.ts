// One clock for the mission pages: 24-hour everywhere; UTC on the demo mission (its fixtures and scripted
// timeline are dated in UTC), the browser's local time on a live mission. The header clock, the feed, the
// console, the approvals and the radio log all format through `clock`, so no two times on a page disagree.
import { createContext, useContext } from "react";

/** "14:05" (or "14:05:09" with seconds), 24-hour, in UTC or the browser's zone. Unparseable input comes back as is. */
export function clock(at: string | Date, utc: boolean, seconds = false): string {
  const d = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) return typeof at === "string" ? at : "";
  return d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
    hourCycle: "h23",
    ...(utc ? { timeZone: "UTC" } : {}),
  });
}

/** Which zone this mission page tells time in (LiveMission provides it; elsewhere: local). */
export const ClockZone = createContext<{ utc: boolean }>({ utc: false });

/** The page's formatter: `time(iso)` -> "14:05", `time(iso, true)` -> "14:05:09". */
export function useClock(): { utc: boolean; time: (at: string | Date, seconds?: boolean) => string } {
  const { utc } = useContext(ClockZone);
  return { utc, time: (at, seconds = false) => clock(at, utc, seconds) };
}
