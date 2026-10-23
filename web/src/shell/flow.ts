// The site's addresses. There is one place, the console, and everything else is a view of it, a sheet
// over it, or a moment of the demo mission's timeline:
//
//   #                          → #m/demo (the landing: the console on the demo mission at t0, the pitch bar)
//   #m/demo?t=0..5             the story at a checkpoint (the coach mark on; t0 is the landing)
//   #m/<id>/<view>[?t=0..5]    a view of a mission: map (the console), photos, trace, debrief; on the
//                              demo, ?t= sets the mission clock, none is "now"
//   #m/<id>/map?needs          the console with Needs You in front (#m/<id>/review lands here)
//   #m/<id>/map?radio          the console with the timeline on Radio and the talk bar ready (#m/<id>/radio)
//   #m/<id>/map/conditions     the console with the Conditions panel open
//   #m/<id>/trace?log          the trace view on its event log
//   #m/<id>/debrief?judges     the debrief with "Where to look, in order" open (#judges: #m/demo?t=5&judges)
//   #m/<id>/photos?try         the photos view with Try a photo open
//   #m/<id>/card/<sector>      a sector's printable assignment card (live missions)
//   #new                       the empty console: start a search, or load the demo mission
//   #about                     the About sheet, over the console last on screen
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
      /** Something open on arrival: the Conditions panel, the event log, For judges, Try a photo, Needs You, the radio. */
      open: { conditions?: boolean; log?: boolean; judges?: boolean; try?: boolean; needs?: boolean; radio?: boolean };
      /** The demo's scenario seed (`?s=`), when the address names one. */
      seed?: string | null;
    }
  | { kind: "card"; id: string; sector: string }
  | { kind: "new" }
  | { kind: "about" };

export const DEMO = "#m/demo";
/** The demo mission's console at "now" (the end of its timeline), no story. */
export const DEMO_CONSOLE_HASH = "#m/demo/map";

/** Old addresses, each with its one home now. */
export const REDIRECTS: Readonly<Record<string, string>> = {
  "": DEMO,
  "#": DEMO,
  // the guided demo's steps: the same moments of the demo mission's timeline
  "#survey": `${DEMO}?t=1`,
  "#rank": `${DEMO}?t=1`,
  "#review": `${DEMO}?t=2`,
  "#search": `${DEMO}?t=3`,
  "#searchnext": `${DEMO}?t=3`,
  "#results": `${DEMO}?t=5`,
  // the old console aliases
  "#operate": DEMO_CONSOLE_HASH,
  "#command": DEMO_CONSOLE_HASH,
  // For judges is a fold of the debrief; Try a photo an action in the Photos rail
  "#judges": `${DEMO}?t=5&judges`,
  "#try": `${DEMO}/photos?try`,
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

/** Where a hash points (after its redirect). Anything unknown is the landing. */
export function routeFromHash(hash: string): Route {
  const h = redirectFromHash(hash) ?? hash;
  if (h === "#new") return { kind: "new" };
  if (h === "#about") return { kind: "about" };
  const m = MISSION.exec(h);
  if (!m) return { kind: "mission", id: "demo", view: null, t: null, open: {} };
  const [, id, rawView, rest, query] = m as unknown as [string, string, string | undefined, string | undefined, string | undefined];
  if (rawView === "card" && rest) return { kind: "card", id, sector: decodeURIComponent(rest) };
  const q = new URLSearchParams(query ?? "");
  const tv = q.get("t");
  const t = tv !== null && /^[0-5]$/.test(tv) ? (Number(tv) as Checkpoint) : null;
  const view = rawView && VIEW_IDS.includes(rawView) ? (rawView as View) : null;
  const open = {
    ...(rest === "conditions" ? { conditions: true } : {}),
    ...(q.has("log") ? { log: true } : {}),
    ...(q.has("judges") ? { judges: true } : {}),
    ...(q.has("try") ? { try: true } : {}),
    ...(q.has("needs") ? { needs: true } : {}),
    ...(q.has("radio") ? { radio: true } : {}),
  };
  const seed = id === "demo" ? q.get("s") : null;
  return { kind: "mission", id, view, t: id === "demo" ? t : null, open, ...(seed ? { seed } : {}) };
}

/** A mission view's address, with the demo's clock when it is not "now". */
export function viewHash(id: string, view: View, t: Checkpoint | null = null): string {
  return `#m/${id}/${view}${t !== null && id === "demo" ? `?t=${t}` : ""}`;
}
