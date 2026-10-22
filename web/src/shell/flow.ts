/** The guided demo flow: one step at a time, in the order the pitch tells the story. */

export type StepId = "survey" | "rank" | "review" | "search" | "results";

export interface Step {
  id: StepId;
  label: string;
  /** One line under the step bar saying what this screen is for. */
  hint: string;
}

/** Search next ends with "Run the search", which opens the console (`#m/demo/command`); Results closes the story. */
export const STEPS: readonly Step[] = [
  { id: "survey", label: "Survey", hint: "The photos a drone brought back" },
  { id: "rank", label: "Rank", hint: "The detector scores every photo" },
  { id: "review", label: "Review", hint: "Answer each candidate; people you mark are pinned as sightings" },
  { id: "search", label: "Search next", hint: "Where the person could still be" },
  { id: "results", label: "Results", hint: "How well it works, with sources" },
];

const IDS = STEPS.map((s) => s.id);

export function nextStep(id: StepId): StepId {
  return IDS[Math.min(IDS.indexOf(id) + 1, IDS.length - 1)] as StepId;
}

export function previousStep(id: StepId): StepId {
  return IDS[Math.max(IDS.indexOf(id) - 1, 0)] as StepId;
}

/** Where the hash points: the overview, For judges, Try a photo, the guided demo, New search, or a mission. */
export type Route =
  | { kind: "front" }
  | { kind: "judges" }
  | { kind: "try" }
  | { kind: "demo" }
  | { kind: "new" }
  | { kind: "mission"; id: string };

/** The demo console: the console on the demo mission's fixtures (E-04), no server needed. */
export const DEMO_CONSOLE_HASH = "#m/demo/command";

/**
 * Old addresses and their one home: the guided demo's former Command step and the old console alias
 * open the console; "#searchnext" is the Search next step.
 */
const REDIRECTS: Readonly<Record<string, string>> = {
  "#operate": DEMO_CONSOLE_HASH,
  "#command": DEMO_CONSOLE_HASH,
  "#searchnext": "#search",
};

/** The address an old hash should be replaced with, or null when it is already the canonical one. */
export function redirectFromHash(hash: string): string | null {
  return REDIRECTS[hash] ?? null;
}

/**
 * "" -> the overview (the default route); "#new" -> New search; "#judges"; "#try" -> Try a photo;
 * "#m/<id>[/<view>]" -> that mission ("demo": the demo console); anything else (the steps, "#survey"…)
 * -> the guided demo.
 */
export function routeFromHash(hash: string): Route {
  const h = redirectFromHash(hash) ?? hash;
  if (h === "" || h === "#") return { kind: "front" };
  if (h === "#new") return { kind: "new" };
  if (h === "#judges") return { kind: "judges" };
  if (h === "#try") return { kind: "try" };
  const m = /^#m\/([0-9a-f]{8}|demo)(\/|$)/.exec(h);
  return m ? { kind: "mission", id: m[1] as string } : { kind: "demo" };
}

/** "#review" -> "review"; anything unknown -> "survey". */
export function stepFromHash(hash: string): StepId {
  const id = (redirectFromHash(hash) ?? hash).replace(/^#/, "");
  return (IDS as string[]).includes(id) ? (id as StepId) : "survey";
}

/** Number keys 1-5 jump to a step. */
export function stepFromKey(key: string): StepId | null {
  const n = Number.parseInt(key, 10);
  return String(n) === key && n >= 1 && n <= IDS.length ? (IDS[n - 1] as StepId) : null;
}
