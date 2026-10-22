/** The guided demo flow: one step at a time, in the order the pitch tells the story. */

export type StepId = "survey" | "rank" | "review" | "search" | "results";

export interface Step {
  id: StepId;
  label: string;
  /** One line under the step bar saying what this screen is for. */
  hint: string;
}

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

/** Where the hash points: the demo flow, the New search screen, or a live mission (LANE_D §5.5). */
export type Route = { kind: "demo" } | { kind: "new" } | { kind: "mission"; id: string };

/** "#new" -> New search; "#m/<id>[/<view>]" -> that live mission; anything else -> the demo flow. */
export function routeFromHash(hash: string): Route {
  if (hash === "#new") return { kind: "new" };
  const m = /^#m\/([0-9a-f]{8})(\/|$)/.exec(hash);
  return m ? { kind: "mission", id: m[1] as string } : { kind: "demo" };
}

/** "#review" -> "review"; anything unknown -> "survey". */
export function stepFromHash(hash: string): StepId {
  const id = hash.replace(/^#/, "");
  return (IDS as string[]).includes(id) ? (id as StepId) : "survey";
}

/** Number keys 1-5 jump to a step. */
export function stepFromKey(key: string): StepId | null {
  const n = Number.parseInt(key, 10);
  return String(n) === key && n >= 1 && n <= IDS.length ? (IDS[n - 1] as StepId) : null;
}
