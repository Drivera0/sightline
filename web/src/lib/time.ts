// One clock for the mission pages: 24-hour everywhere, in the incident's local time. The demo mission is
// dated on a scripted afternoon at Mount Seymour, so it reads Vancouver time ("13:35 PDT"), with UTC on
// hover; a live mission reads the browser's local time. The header clock, the feed, the console, the
// approvals and the radio log all format through `clock`, so no two times on a page disagree.
import { createContext, useContext } from "react";

/** Which clock a page reads: `true` UTC, `false` the browser's zone, or an IANA zone (the incident's). */
export type Tz = boolean | string;

/** The demo mission's zone: Mount Seymour, North Vancouver. */
export const DEMO_TZ = "America/Vancouver";

const timeZone = (tz: Tz): string | undefined => (tz === true ? "UTC" : typeof tz === "string" ? tz : undefined);

/** "14:05" (or "14:05:09" with seconds), 24-hour, in `tz`. Unparseable input comes back as is. */
export function clock(at: string | Date, tz: Tz, seconds = false): string {
  const d = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) return typeof at === "string" ? at : "";
  const zone = timeZone(tz);
  // one formatter per zone (toLocaleTimeString builds one on every call: the console formats hundreds a second)
  const key = `${zone ?? ""}|${seconds ? 1 : 0}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      ...(seconds ? { second: "2-digit" } : {}),
      hourCycle: "h23",
      ...(zone ? { timeZone: zone } : {}),
    });
    formatters.set(key, f);
  }
  return f.format(d);
}
const formatters = new Map<string, Intl.DateTimeFormat>();

/** The zone a clock reading is in, for a label beside it: "UTC", or the zone's short name at that moment
 * ("PDT", or "GMT+2" where the zone has no abbreviation). */
export function zone(at: Date, tz: Tz): string {
  if (tz === true) return "UTC";
  const z = timeZone(tz);
  const part = new Intl.DateTimeFormat("en-US", { timeZoneName: "short", ...(z ? { timeZone: z } : {}) }).formatToParts(at).find((x) => x.type === "timeZoneName");
  return part?.value ?? "local";
}

/** "13:35 PDT": the clock with its zone. */
export function clockWithZone(at: string | Date, tz: Tz): string {
  const d = typeof at === "string" ? new Date(at) : at;
  return `${clock(d, tz)} ${zone(d, tz)}`;
}

/** "20:35 UTC": the same moment in UTC, for a tooltip beside a local reading. */
export function utcLabel(at: string | Date): string {
  return `${clock(at, true)} UTC`;
}

/** Which zone this mission page tells time in (LiveMission provides it; elsewhere: local). */
export const ClockZone = createContext<{ tz: Tz }>({ tz: false });

/** The page's formatter: `time(iso)` -> "14:05", `time(iso, true)` -> "14:05:09". */
export function useClock(): { tz: Tz; time: (at: string | Date, seconds?: boolean) => string } {
  const { tz } = useContext(ClockZone);
  return { tz, time: (at, seconds = false) => clock(at, tz, seconds) };
}
