// The scenario's roles the guided search anchors to (guide.ts): the first assignment, the clue it names,
// the console's regions, the grey bag in the survey's photos, and the words that never appear inside the
// walk-through (the header's disclosure chip says what kind of search this is). Nothing here names a fixed
// proposal, clue or sector: it reads them off whichever scenario is loaded. The step-through story's
// first-person coach marks that lived here are gone: the guided search replaced them. Pure; built by lane A.

import type { Clue, Proposal } from "../contract";
import { BOARD_AT, type DemoFull } from "./missionTime";

/** Words that never appear inside the story: the disclosure chip in the header covers what they would say. */
export const STORY_BANNED = /\b(demo|demos|recorded|scripted|simulated|simulation)\b/i;

/** The console's regions, as the coach marks point at them. */
export const REGION = {
  status: '[aria-label="Mission status"]',
  resources: '[data-tour="tasks"]',
  map: "#console-map",
  needs: '[data-tour="needs"]',
  review: '[data-tour="review"]',
  timeline: '[data-tour="timeline"]',
  photos: 'button[title^="Photos:"]',
  report: '[aria-label="Mission report"]',
  debrief: '[data-tour="debrief"]',
} as const;

/** A survey photo every scenario shares (they fly the same ground): a grey bag at a photo's edge. */
export const STORY_NOT_A_PERSON = "f0452-d01";

const ms = (iso: string) => new Date(iso).getTime();

/** A clue's words up to its first comma: "possible whistle, three blasts" → "possible whistle". */
const short = (c: Clue) => c.text.split(",")[0]!.trim();

/** The scenario's first assignment: the proposal the story asks the visitor to approve. */
export function storyProposal(full: DemoFull | null): Proposal | null {
  return [...(full?.data.proposals ?? [])].filter((p) => p.kind === "assign_sector" && p.target.team && p.target.sector).sort((a, b) => a.created_at.localeCompare(b.created_at))[0] ?? null;
}

/**
 * The clue that moves the map before the first assignment: of the clues its reason names, the last to come
 * in (by radio when one did); else the last clue by radio before it; else the last clue before it.
 */
export function storyClue(full: DemoFull | null): Clue | null {
  const p = storyProposal(full);
  const by = p ? ms(p.created_at) : ms(BOARD_AT);
  const before = (full?.data.clues ?? []).filter((c) => ms(c.at) <= by).sort((a, b) => a.at.localeCompare(b.at));
  const named = p ? before.filter((c) => new RegExp(`\\b${c.id}\\b`).test(p.reason) || p.reason.includes(short(c))) : [];
  const radio = (xs: Clue[]) => xs.filter((c) => c.source === "radio");
  return radio(named).at(-1) ?? named.at(-1) ?? radio(before).at(-1) ?? before.at(-1) ?? null;
}
