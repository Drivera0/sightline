// The site's addresses. A home page, then one place, the console: everything else is a view of it, a
// sheet over it, or a moment of the demo mission's timeline:
//
//   #                          the home page: what Sightline is, and "Choose a search" (front/Home.tsx)
//   #m/demo                    the console on the demo mission at t0, the pitch bar
//   #m/demo?s=<seed>&guide=1   a scenario with its guided search started (a home card's Start): each decision
//                              waits for the manager (command/guide.ts)
//   #m/demo/map[?s=<seed>]     free play: the console on its own (the home page's "Open the console", a card's
//                              "Open the console only"), always a fresh mission at the call, the same engine as
//                              the guided search but no coach bar; a slim clock control (Play/Pause, 1×/2×/4×)
//                              runs the time, proposals wait in Needs you, the run ends at the find
//                              (command/GuideRun.tsx, `free`)
//   #m/demo?t=0..6             the console at a checkpoint's clock of the recorded demo mission (no coach
//                              marks; it settles on #m/demo/map?t=N): 0 the call, 1 photos land, 2 confirm,
//                              3 where next, 4 the run, 5 the find, 6 the debrief (#m/demo/map?t=6: the end)
//   #m/<id>/<view>[?t=0..6]    a view of a mission: map (the console), photos, trace, debrief; on the
//                              demo, ?t= sets the mission clock, none is "now"
//   #m/<id>/map?needs          the console with Needs You in front (#m/<id>/review lands here)
//   #m/<id>/map?radio          the console with the timeline on Radio and the talk bar ready (#m/<id>/radio)
//   #m/<id>/map/conditions     the console with the Conditions panel open
//   #m/<id>/trace?log          the trace view on its event log
//   #m/<id>/debrief?judges     the debrief with "Where to look, in order" open (#judges: #m/demo?t=6&judges)
//   #m/<id>/photos?try         the photos view with Try a photo open
//   #m/<id>/card/<sector>      a sector's printable assignment card (live missions)
//   #new                       the empty console: start a search, or load the demo mission
//   #play                      open play: set up your own search (who, where, base camp, teams, drones),
//                              then Start opens free play on it (#m/demo/map?s=play; front/OpenPlay.tsx)
//   #about                     the home page, scrolled to its About section (who built it, the entries,
//                              the colours, the limits, the licences); it was a sheet over the console
//
// Every address the site had before (the guided demo's steps, the front door, For judges, Try a photo,
// the console's old tab names) redirects to its place here, so links in the docs, the Devposts and the
// video still land somewhere sensible (REDIRECTS and redirectFromHash).

import type { Checkpoint } from "../command/missionTime";

export type View = "map" | "photos" | "trace" | "debrief";

/** The view switch, in the order the work flows; each says in a few words what it shows (its tooltip). */
export const VIEWS: readonly { id: View; label: string; key: string; what: string }[] = [
  { id: "map", label: "Map", key: "1", what: "the console: resources, the map, what needs you and the timeline" },
  { id: "photos", label: "Photos", key: "2", what: "the drone photos as they land, and Try a photo" },
  { id: "trace", label: "Trace", key: "4", what: "every step the agent took, and the event log" },
  { id: "debrief", label: "Debrief", key: "5", what: "what the mission did, the measured results and the exports" },
];
const VIEW_IDS: readonly string[] = VIEWS.map((v) => v.id);

export type Route =
  | {
      kind: "mission";
      id: string;
      /** null: no view in the address (the demo's landing or a story checkpoint; a live mission's map). */
      view: View | null;
      /** The demo mission's clock, at a checkpoint. */
      t: Checkpoint | null;
      /** Something open on arrival: the Conditions panel, the event log, For judges, Try a photo, Needs You, the radio,
       *  or (`guide`, the demo only) the guided simulation started, or (`free`, the demo's plain console
       *  address) free play: a fresh run from the call on the console's own controls. */
      open: { conditions?: boolean; log?: boolean; judges?: boolean; try?: boolean; needs?: boolean; radio?: boolean; guide?: boolean; free?: boolean };
      /** The demo's scenario seed (`?s=`), when the address names one. */
      seed?: string | null;
    }
  | { kind: "card"; id: string; sector: string }
  /** `section`: a section of the home page to scroll to on arrival (#about). */
  | { kind: "home"; section?: HomeSection }
  | { kind: "new" }
  /** Open play's setup page (front/OpenPlay.tsx). */
  | { kind: "play" }
  /** Try your own photo: the detector on a page of its own (front/TryPage.tsx). */
  | { kind: "try" };

/** The home page's sections an address can land on. */
export type HomeSection = "about" | "scenarios";
/** The home page scrolled to its scenario cards (front/Home.tsx `home-sim`). */
export const SCENARIOS_HASH = "#scenarios";
export const SCENARIOS_ID = "home-sim";
/** The id of the home page's About section (front/About.tsx), where #about lands. */
export const ABOUT_ID = "home-about";

/** The home page. */
export const HOME = "#";
/** Open play's setup page: the visitor's own search, then the console on it (command/openPlay.ts). */
export const PLAY_HASH = "#play";
/** Try your own photo: drop in a photo and the detector runs on it in this browser. */
export const TRY_HASH = "#try";
export const DEMO = "#m/demo";
/** The console on its own: free play, a fresh mission at the call (no coach bar). */
export const DEMO_CONSOLE_HASH = "#m/demo/map";
/** The recorded demo mission at the end of its timeline (the find, 15:00), on the console. */
export const DEMO_END_HASH = "#m/demo/map?t=6";

/** Old addresses, each with its one home now. */
export const REDIRECTS: Readonly<Record<string, string>> = {
  // the guided demo's steps: the same moments of the demo mission's timeline
  "#survey": `${DEMO}?t=1`,
  "#rank": `${DEMO}?t=1`,
  "#review": `${DEMO}?t=2`,
  "#search": `${DEMO}?t=3`,
  "#searchnext": `${DEMO}?t=3`,
  "#results": `${DEMO}?t=6`,
  // the old console aliases
  "#operate": DEMO_CONSOLE_HASH,
  "#command": DEMO_CONSOLE_HASH,
  // For judges is a fold of the debrief
  "#judges": `${DEMO}?t=6&judges`,
  // the debrief was t5 before the find had a checkpoint of its own
  "#m/demo?t=5&judges": `${DEMO}?t=6&judges`,
};

/** The console's old tab names, inside a mission's address. */
const OLD_VIEWS: Readonly<Record<string, string>> = {
  command: "map",
  approvals: "map",
  feed: "trace?log",
  // the review folds into Needs You, the radio desk into the timeline's talk bar
  review: "map?needs",
  radio: "map?radio",
};

/** The address an old hash should be replaced with, or null when it is already the canonical one. */
export function redirectFromHash(hash: string): string | null {
  if (hash in REDIRECTS) return REDIRECTS[hash] as string;
  const m = /^#m\/([^/?]+)\/([a-z]+)(\/[^?]*)?(\?.*)?$/.exec(hash);
  if (m && m[2]! in OLD_VIEWS) {
    const to = OLD_VIEWS[m[2]!] as string;
    const [view, query] = to.split("?");
    const params = [query, m[4]?.slice(1)].filter(Boolean).join("&");
    return `#m/${m[1]}/${view}${m[3] ?? ""}${params ? `?${params}` : ""}`;
  }
  return null;
}

const MISSION = /^#m\/([0-9a-f]{8}|demo)(?:\/([a-z]+))?(?:\/([^?]*))?(?:\?(.*))?$/;

/** Where a hash points (after its redirect). The root, and anything unknown, is the home page. */
export function routeFromHash(hash: string): Route {
  const h = redirectFromHash(hash) ?? hash;
  if (h === "#new") return { kind: "new" };
  if (h === PLAY_HASH) return { kind: "play" };
  if (h === TRY_HASH) return { kind: "try" };
  // About was a sheet over the console; it is now a section of the home page, and old links land there
  if (h === "#about") return { kind: "home", section: "about" };
  // the scenario cards (leaving the guided simulation lands here)
  if (h === SCENARIOS_HASH) return { kind: "home", section: "scenarios" };
  const m = MISSION.exec(h);
  if (!m) return { kind: "home" };
  const [, id, rawView, rest, query] = m as unknown as [string, string, string | undefined, string | undefined, string | undefined];
  if (rawView === "card" && rest) return { kind: "card", id, sector: decodeURIComponent(rest) };
  const q = new URLSearchParams(query ?? "");
  const tv = q.get("t");
  const t = tv !== null && /^[0-6]$/.test(tv) ? (Number(tv) as Checkpoint) : null;
  const view = rawView && VIEW_IDS.includes(rawView) ? (rawView as View) : null;
  const open: Extract<Route, { kind: "mission" }>["open"] = {
    ...(rest === "conditions" ? { conditions: true } : {}),
    ...(q.has("log") ? { log: true } : {}),
    ...(q.has("judges") ? { judges: true } : {}),
    ...(q.has("try") ? { try: true } : {}),
    ...(q.has("needs") ? { needs: true } : {}),
    ...(q.has("radio") ? { radio: true } : {}),
    ...(id === "demo" && q.get("guide") === "1" ? { guide: true } : {}),
  };
  // free play: the plain console address (a scenario's seed at most), no checkpoint, nothing else open
  if (id === "demo" && view === "map" && t === null && !rest && [...q.keys()].every((k) => k === "s")) open.free = true;
  const seed = id === "demo" ? q.get("s") : null;
  return { kind: "mission", id, view, t: id === "demo" ? t : null, open, ...(seed ? { seed } : {}) };
}

/** The guided search's address, on a scenario or the default one. */
export function guideHash(seed: string | null = null): string {
  return seed ? scenarioHash(seed) : `${DEMO}?guide=1`;
}

/** A scenario's address: the console on it with the guided simulation on, or (`guide` false) just the console. */
export function scenarioHash(seed: string, guide = true): string {
  const s = encodeURIComponent(seed);
  return guide ? `${DEMO}?s=${s}&guide=1` : `${DEMO}/map?s=${s}`;
}

/** A mission view's address, with the demo's clock when it is not "now". */
export function viewHash(id: string, view: View, t: Checkpoint | null = null): string {
  return `#m/${id}/${view}${t !== null && id === "demo" ? `?t=${t}` : ""}`;
}
