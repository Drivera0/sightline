// The conditions the agent is using, fact by fact, with where each came from (Tavily, LANE_B B-W1/B-W2).
// The `Conditions` object the web receives carries the values, the list of pages read (`sources`) and each
// alert's URL, but not the quotes: those are in the mission's trace (actor "conditions": the Tavily calls,
// then the model call whose output has, per field, the value and the verbatim quote). This file joins the
// two. Built by lane A.
import type { Conditions, TraceEntry } from "../contract";
import type { Tz } from "../lib/time";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export interface Search {
  label: string;
  query: string;
  results: { url: string; title: string }[];
}

/** One conditions lookup as the trace recorded it. */
export interface Lookup {
  searches: Search[];
  /** Pages Tavily extracted in full. */
  extracted: string[];
  /** Pages the model read (search results and extracts). */
  documents: string[];
  /** field → { value, quote, url? } from the model call (url only if the server records it). */
  fields: Record<string, { value: number; quote: string | null; url: string | null }>;
  alertQuotes: { title: string; quote: string }[];
  model: string | null;
  ms: number | null;
  tokensIn: number | null;
  at: string | null;
}

/** The latest lookup in a trace: the last conditions model call and the Tavily calls just before it. */
export function latestLookup(trace: readonly TraceEntry[]): Lookup | null {
  const mine = trace.filter((e) => e.actor === "conditions");
  const last = mine.map((e) => e.kind).lastIndexOf("model_call");
  if (last < 0) return null;
  let first = last;
  while (first > 0 && mine[first - 1]!.kind === "tool_call") first -= 1;
  const calls = mine.slice(first, last);
  const model = mine[last]!;
  const out = isObj(model.output) ? model.output : {};
  const inp = isObj(model.input) ? model.input : {};
  const fields: Lookup["fields"] = {};
  if (isObj(out.fields)) {
    for (const [k, v] of Object.entries(out.fields)) {
      if (isObj(v) && typeof v.value === "number") {
        fields[k] = { value: v.value, quote: typeof v.quote === "string" ? v.quote : null, url: typeof v.url === "string" ? v.url : null };
      }
    }
  }
  const results = (e: TraceEntry) =>
    isObj(e.output) && Array.isArray(e.output.results)
      ? e.output.results.filter(isObj).map((r) => ({ url: String(r.url ?? ""), title: String(r.title ?? r.url ?? "") }))
      : [];
  return {
    searches: calls
      .filter((e) => e.summary.startsWith("Tavily search"))
      .map((e) => ({
        label: /\(([^)]+)\)/.exec(e.summary)?.[1] ?? "search",
        query: isObj(e.input) && typeof e.input.query === "string" ? e.input.query : e.summary,
        results: results(e),
      })),
    extracted: calls.filter((e) => e.summary.startsWith("Tavily extract")).flatMap((e) => results(e).map((r) => r.url)),
    documents: Array.isArray(inp.documents) ? [...new Set(inp.documents.map(String))] : [],
    fields,
    alertQuotes: Array.isArray(out.alerts) ? out.alerts.filter(isObj).map((a) => ({ title: String(a.title ?? ""), quote: String(a.quote ?? "") })) : [],
    model: model.model,
    ms: model.ms,
    tokensIn: model.tokens_in,
    at: model.at,
  };
}

/** A conditions record put in by hand for a demo (POST /conditions/override), never from a Tavily lookup. */
export const OVERRIDE_SOURCE = "override (demo)";
export const isOverride = (c: Conditions | null | undefined): boolean => !!c && Array.isArray(c.sources) && c.sources.includes(OVERRIDE_SOURCE);

export function domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const kmhToMs = (v: number) => v / 3.6;
const ms1 = (v: number) => `${kmhToMs(v).toFixed(1)} m/s`;

export type FactSource =
  | { kind: "quote"; quote: string; url: string | null }
  | { kind: "computed"; how: string }
  | { kind: "heuristic"; how: string }
  | { kind: "missing" };

export interface Fact {
  id: string;
  label: string;
  value: string;
  source: FactSource;
}

const hhmmUtc = (iso: string) => `${iso.slice(11, 16)} UTC`;

/** ", 23 Oct" when `iso` falls on another day than `now` in the zone `tz` (lib/time: true UTC, false the browser's, or an IANA zone); else "". */
export function dayNote(iso: string, now: Date, tz: Tz = true): string {
  const zone = tz === true ? "UTC" : typeof tz === "string" ? tz : undefined;
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", ...(zone ? { timeZone: zone } : {}) };
  const day = (d: Date) => d.toLocaleDateString("en-GB", { ...opts, year: "numeric" });
  const t = new Date(iso);
  return day(t) === day(now) ? "" : `, ${t.toLocaleDateString("en-GB", opts)}`;
}

/**
 * The exposure note in the mission's clock: the server wrote "4 h since last seen" when it looked the
 * weather up; the console says how long it is now ("3 h 05 min since last seen at 10:30"), and the
 * caveat in plain words.
 */
export function exposureWords(note: string, lastSeen: string | null | undefined, now: Date, time: (iso: string) => string): string {
  let s = note.replace(/\s*\(planning heuristic, not a medical assessment\)/, "").replace(/^(low|moderate|high|severe): /, "");
  if (lastSeen) {
    const min = Math.max(0, Math.round((now.getTime() - new Date(lastSeen).getTime()) / 60000));
    const h = Math.floor(min / 60);
    const since = `${h ? `${h} h ${String(min % 60).padStart(2, "0")} min` : `${min} min`} since last seen at ${time(lastSeen)}`;
    s = s.replace(/\d+ h since last seen/, since);
  }
  return `${s}. A rough planning guide, not a medical assessment.`;
}

/** Each fact the agent uses, with its value and where it came from. Empty fields say so: nothing is guessed. */
/**
 * `now`: the mission clock; `time` formats a moment in the mission's zone ("18:36 PDT", with the date when it
 * is another day); `lastSeen`: when the subject was last seen (the exposure note counts from it).
 */
export function conditionsFacts(c: Conditions, lookup: Lookup | null, now: Date = new Date(), time: (iso: string) => string = (iso) => `${hhmmUtc(iso)}${dayNote(iso, now)}`, lastSeen: string | null = null): Fact[] {
  const override = isOverride(c);
  const quoted = (field: string, label: string, value: number | null, show: (v: number) => string): Fact => {
    const f = lookup?.fields[field];
    if (override) {
      // never shown with an earlier lookup's quotes: the override replaced it whole
      if (value === null) return { id: field, label, value: "not set", source: { kind: "computed", how: "left empty by the demo override" } };
      return { id: field, label, value: show(value), source: { kind: "computed", how: `${OVERRIDE_SOURCE}: set by hand, not from Tavily` } };
    }
    if (value === null) return { id: field, label, value: "not on the pages read", source: { kind: "missing" } };
    return { id: field, label, value: show(value), source: f?.quote ? { kind: "quote", quote: f.quote, url: f.url } : { kind: "missing" } };
  };
  const facts: Fact[] = [
    quoted("wind_kmh", "Wind", c.wind_kmh, (v) => `${v.toFixed(0)} km/h (${ms1(v)})`),
    quoted("gust_kmh", "Gusts", c.gust_kmh, (v) => `${v.toFixed(0)} km/h (${ms1(v)})`),
    quoted("precip_mm_h", "Precipitation", c.precip_mm_h, (v) => `${v} mm/h`),
  ];
  if (c.precip_prob !== null) facts.push(quoted("precip_prob", "Chance of rain", c.precip_prob, (v) => `${Math.round(v <= 1 ? v * 100 : v)}%`));
  if (c.temp_c !== null) facts.push(quoted("temp_c", "Temperature", c.temp_c, (v) => `${v} °C`));
  if (c.visibility_km !== null) facts.push(quoted("visibility_km", "Visibility", c.visibility_km, (v) => `${v} km`));
  facts.push({
    id: "twilight",
    label: "Light until (civil twilight)",
    value: c.civil_twilight_end ? `${time(c.civil_twilight_end)}${c.sunset ? ` (sunset ${time(c.sunset)})` : ""}` : "unknown",
    source: { kind: "computed", how: "computed for the area's date and position (astral), not read from a page" },
  });
  facts.push({
    id: "visibility_factor",
    label: "How well the photos see",
    value: c.visibility_factor >= 0.95 ? "normal" : `reduced: each photo counts for less (×${c.visibility_factor.toFixed(1)})`,
    source: { kind: "heuristic", how: "fog, haze or a weather warning lowers it; then a photo with nobody in it lowers the sector's probability less" },
  });
  facts.push({
    id: "exposure",
    label: "Exposure risk to the subject",
    value: c.exposure_band ?? "unknown",
    source: { kind: "heuristic", how: c.exposure_note ? exposureWords(c.exposure_note, lastSeen, now, time) : "A rough planning guide, not a medical assessment." },
  });
  return facts;
}

export interface Gate {
  tone: "ok" | "alert" | "muted";
  text: string;
}

/**
 * The flyability gate in words, with the wind limit it was checked against: the fleet's lowest drone limit,
 * or, with no fleet attached, the server's default (38 km/h, as `flyability` in sightline/geo/conditions.py).
 */
export function flyGate(c: Conditions, limitKmh: number | null, drone: string | null, until: (iso: string) => string): Gate {
  const fromReason = /limit of (\d+(?:\.\d+)?) km\/h/.exec(c.flyability_reason)?.[1];
  const limit = limitKmh ?? (fromReason ? Number(fromReason) : 38);
  // whose limit: the fleet's lowest, or (no fleet yet) the usual one for these drones
  const whose = limitKmh !== null ? (drone ? `${drone}'s` : "the drones'") : "the usual";
  const gust = c.gust_kmh ?? c.wind_kmh;
  const lim = `${whose} gust limit of ${limit.toFixed(0)} km/h (${ms1(limit)})`;
  if (c.flyable === true) return { tone: "ok", text: `Drones can fly until ~${c.flyable_until ? until(c.flyable_until) : "dusk"} (wind under ${lim}; light until civil twilight)` };
  if (c.flyable === false) {
    const over = gust !== null && gust >= limit ? `${c.gust_kmh !== null ? "gusts" : "wind"} ${gust.toFixed(0)} km/h (${ms1(gust)}), at or over ${lim}` : null;
    // the server's reason first (it checks light before wind); the wind check when it fails too
    if (over && /gust|wind/.test(c.flyability_reason)) return { tone: "alert", text: `Drones grounded: ${over}` };
    return { tone: "alert", text: `Drones grounded: ${c.flyability_reason}${over ? `; also ${over}` : ""}` };
  }
  return { tone: "muted", text: `Drone flying not known: ${c.flyability_reason || "no wind data"}` };
}
