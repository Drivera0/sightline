// The guided search (`#m/demo?guide=1`, .documents/SIM_DESIGN.md §2–§5): the scenario as a run of
// injects, each a decision the search manager makes while the mission clock waits. Survey · Triage · Clue ·
// Assign · Link · Wind · Find, the ones the loaded scenario has (no drones: no survey, link or wind). Each
// inject names its options with what each costs in mission minutes before the commit, and which is the
// agent's; the console's own actions (an answer in the review queue, Approve on the card, a sector on the
// map, Confirm on a read-back, the find in a sector's popover) count as the decision too. The same engine
// (sim.ts) plays the agent's line for "Watch instead" and for the end screen's comparison. Copy: verb
// first, one sentence, the key last, no first person, none of STORY_BANNED. Pure; built by lane A.

import type { Clue, MissionEvent, Proposal } from "../contract";
import { clock, DEMO_TZ } from "../lib/time";
import { SECOND_LOOK_ID } from "./demoReview";
import { BOARD_AT, CHECKPOINTS, isFoundEvent, poaOf, subjectOf, type DemoFull } from "./missionTime";
import { agentLine, passesFrom, playStanding, type Cost, type Line, type Pass } from "./sim";
import { REGION, STORY_NOT_A_PERSON, storyClue, storyProposal } from "./storyCopy";
import { podLabel, TERMS, thresholdNote } from "./terms";

export type InjectId = "survey" | "triage" | "clue" | "assign" | "link" | "wind" | "find";

/** The progress strip's names, in order. */
export const PIPS: readonly { id: InjectId; label: string }[] = [
  { id: "survey", label: "Survey" },
  { id: "triage", label: "Review photos" },
  { id: "clue", label: "Clue" },
  { id: "assign", label: "Assign" },
  { id: "link", label: "Link" },
  { id: "wind", label: "Wind" },
  { id: "find", label: "Find" },
];

export interface Option {
  /** "1".."4" (A picks the agent's). */
  key: string;
  id: string;
  label: string;
  /** Mission minutes it takes. */
  costMin: number;
  /** What it does, shown before the commit. */
  effect: string;
  agent?: boolean;
  /**
   * The console's own control that does it (the card's Approve, Confirm on the read-back, a sector on the
   * map): the coach bar names it and rings it, and shows no button of its own for it. The key still works.
   */
  on?: string;
}

/** One triage card. */
export interface TriageCard {
  id: string;
  /** What the agent shows: the score, or the second look. */
  says: string;
  /** The reference answer the agent's line plays. */
  line: TriageAnswer;
}

export type TriageAnswer = "person" | "not_person" | "not_subject" | "object" | "unsure";
/** The review card's own answers and keys (review/answers.tsx): triage is answered on the card. */
export const TRIAGE_OPTIONS: readonly { key: string; id: TriageAnswer; label: string }[] = [
  { key: "P", id: "person", label: "Person" },
  { key: "N", id: "not_person", label: "Not a person" },
  { key: "S", id: "not_subject", label: "Not the subject" },
  { key: "O", id: "object", label: "Object" },
  { key: "U", id: "unsure", label: "Unsure" },
];

export interface Inject {
  id: InjectId;
  /** Unique: the id, or "assign-2" for a later assignment. */
  key: string;
  /** When it fires, on the fixtures' clock (ms). */
  at: number;
  /** "Watch this": what happens while the clock runs toward it. */
  lead: string;
  /** "Your call": verb first, one sentence, the key last. */
  prompt: string;
  /** What the agent says (a number, a reason). */
  agentSays?: string;
  options: Option[];
  /** Where the ring goes. */
  target: string | readonly string[];
  /** Triage: the three cards, in order. */
  cards?: TriageCard[];
  /** The proposal the inject is about (assign, wind). */
  proposal?: string;
  /** The find: the team and the sector that report it. */
  find?: { team: string; sector: string };
}

/** A decision made. */
export interface Choice {
  key: string;
  inject: InjectId;
  option: string;
  label: string;
  /** The agent's option for this inject, in words. */
  agentLabel: string;
  agent: boolean;
  /** The fixtures' clock when it was made (ms). */
  f: number;
  costMs: number;
  /** Triage: one choice per card. */
  card?: string;
  /** Made by "Watch instead". */
  watched?: boolean;
  /** Wall clock (ms): when the decision was shown, and when it was made (the end screen's decision time). */
  shownAt?: number;
  decidedAt?: number;
}

export interface GuideInput {
  full: DemoFull | null;
  seed: string;
  /** The visitor's own events on the console. */
  user: readonly MissionEvent[];
  choices: readonly Choice[];
  /** The review queue's candidates, best first, once the survey is in. */
  queue: readonly { id: string; conf: number }[];
}

const ms = (iso: string) => new Date(iso).getTime();
const local = (t: number) => clock(new Date(t).toISOString(), DEMO_TZ);

/** The drone that loses its link during the run, and when (the fixtures' fleet notes). */
function lostLink(full: DemoFull): { drone: string; at: number } | null {
  const e = (full.data.events ?? []).find((x) => x.type === "mission.note" && /^(D\d+) link lost/.test(x.summary));
  const m = e ? /^(D\d+)/.exec(e.summary) : null;
  return e && m ? { drone: m[1]!, at: ms(e.at) } : null;
}

/** A recall the agent proposes when gusts rise past the drones' limit (a scenario that has one). */
function recall(full: DemoFull): Proposal | null {
  return (full.data.proposals ?? []).find((p) => (p.kind === "alert" || p.kind === "retask_drone") && /recall|return|home|base|gust/i.test(`${p.summary} ${p.reason}`) && ms(p.created_at) > ms(BOARD_AT)) ?? null;
}

const droneWord = (id: string, full: DemoFull) => {
  const name = (full.data.fleet?.drones ?? []).find((d) => d.id === id)?.name ?? id;
  const n = /(\d+)$/.exec(name)?.[1];
  return n ? `drone ${["zero", "one", "two", "three", "four", "five"][Number(n)] ?? n}` : name;
};

/** The three cards to triage: a plain person (another hiker), the grey bag, and the second look's catch. */
export function triageCards(queue: GuideInput["queue"]): TriageCard[] {
  const plain = queue.find((c) => c.id !== STORY_NOT_A_PERSON && c.id !== SECOND_LOOK_ID);
  const bag = queue.find((c) => c.id === STORY_NOT_A_PERSON) ?? queue.find((c) => c !== plain && c.id !== SECOND_LOOK_ID);
  const relook = queue.find((c) => c.id === SECOND_LOOK_ID);
  const out: TriageCard[] = [];
  if (plain) out.push({ id: plain.id, says: `Detector score ${plain.conf.toFixed(2)}.`, line: "person" });
  if (bag) out.push({ id: bag.id, says: `Detector score ${bag.conf.toFixed(2)}.`, line: "not_person" });
  if (relook) out.push({ id: relook.id, says: `Detector score ${relook.conf.toFixed(2)}, under 0.29 (${thresholdNote(0.29)}); ${TERMS.recheckFlagged}: likely a person.`, line: "person" });
  return out;
}

/** What one triage answer does, shown before the commit. */
export function triageEffect(card: TriageCard, a: TriageAnswer): { effect: string; costMin: number } {
  const bag = card.id === STORY_NOT_A_PERSON;
  const relook = card.id === SECOND_LOOK_ID;
  if (a === "person") return bag ? { effect: "a team walks to the pin to check it", costMin: 10 } : { effect: relook ? "a sighting pin goes on the map where the photo puts it" : "a sighting pin goes on the map", costMin: 0 };
  if (a === "not_subject") return { effect: bag ? `it leaves ${TERMS.review}` : "another person on the ground: a witness lead to ask about", costMin: 0 };
  if (a === "not_person") return { effect: relook ? `it leaves ${TERMS.review} and nothing goes on the map` : `it leaves ${TERMS.review}`, costMin: 0 };
  if (a === "object") return { effect: "a possible clue for a team to confirm on the ground", costMin: 0 };
  return { effect: "it stays flagged for a second reviewer", costMin: 0 };
}

/**
 * The scenario's injects in time order, for what has happened so far: the fixed ones, then the find once a
 * pass detects the subject, or another assignment each time a pass ends with no find and nobody is out.
 */
export function injects(input: GuideInput): Inject[] {
  const { full } = input;
  if (!full) return [];
  const d = full.data;
  const teams = d.teams ?? [];
  const callsign = (id: string | null | undefined) => teams.find((t) => t.id === id)?.callsign ?? id ?? "";
  const drones = d.fleet?.drones ?? [];
  const out: Inject[] = [];

  // 1. survey: the planner's legs or a serpentine; nothing flies until then
  if (drones.length) {
    const poa = [...poaOf(full).entries()].sort((a, b) => b[1] - a[1]);
    const top = poa.slice(0, 3);
    const share = top.reduce((n, [, p]) => n + p, 0) / Math.max(1e-9, poa.reduce((n, [, p]) => n + p, 0));
    out.push({
      id: "survey",
      key: "survey",
      at: ms(CHECKPOINTS[0]!.at),
      lead: "The call comes in; the agent drafts the survey.",
      prompt: `Launch the survey: fly ${TERMS.aiChoices.replace("choices", "flight lines")}, or a ${TERMS.lawnmower}.`,
      agentSays: top.length ? `${top.map(([s]) => s).join(", ")} first: ${Math.round(share * 100)} % of the probability in ${top.length} of ${poa.length} sectors.` : undefined,
      options: [
        { key: "1", id: "planner", label: "The AI's flight lines", costMin: 0, effect: `${droneWord(drones[0]!.id, full)} photographs the likeliest sectors first`, agent: true },
        { key: "2", id: "serpentine", label: "Lawnmower pattern, whole grid", costMin: 12, effect: "every sector once, row by row; the likeliest ones are photographed 12 min later" },
      ],
      target: [REGION.map],
    });
  }

  // 2. triage: three candidates, one at a time
  const cards = triageCards(input.queue);
  if (cards.length)
    out.push({
      id: "triage",
      key: "triage",
      at: ms(CHECKPOINTS[2]!.at),
      lead: drones.length ? "The drones fly the survey; photos land and the detector ranks each one." : "The survey's photos land and the detector ranks each one.",
      prompt: "Is it a person? Answer on the photo's card in Needs you: Person, Not a person, Not the subject, Object or Unsure.",
      options: [],
      cards,
      target: [`${REGION.review} li[data-candidate]`, REGION.review, REGION.needs],
    });

  // 3. the radio clue: confirm, ask for a bearing, or log it
  const clue = storyClue(full);
  if (clue && clue.source === "radio") {
    const who = callsign(clue.reported_by);
    out.push({
      id: "clue",
      key: "clue",
      at: ms(clue.at),
      lead: "The teams stand by at base camp while the review lands.",
      prompt: `Read back ${who}'s call: press Confirm clue on its card in Needs you, ask for a bearing, or log it without mapping.`,
      agentSays: `${who}: ${clue.text}.`,
      options: [
        { key: "1", id: "confirm", label: `Confirm at ${clue.reliability ?? "low"} reliability`, costMin: 0, effect: "the map shifts toward it", agent: true, on: "Confirm clue on the card in Needs you" },
        { key: "2", id: "bearing", label: "Ask for a bearing", costMin: 2, effect: "the map shifts toward it at medium reliability" },
        { key: "3", id: "log", label: "Log without mapping", costMin: 0, effect: "it goes in the log; the map stays as it is" },
      ],
      target: [`[data-need="clue-${clue.id}"]`, '[aria-label="Awaiting read-back"]', `group:${REGION.timeline} li[data-kind="clue"], ${REGION.timeline} li[data-kind="radio"]`, REGION.needs],
    });
  }

  // 4. the first assignment
  const p = storyProposal(full);
  const subject = subjectOf(full);
  if (p?.target.team && p.target.sector) {
    const other = teams.find((t) => t.id !== p.target.team && t.status !== "off_duty") ?? teams.find((t) => t.id !== p.target.team);
    out.push({
      id: "assign",
      key: "assign",
      at: ms(p.created_at),
      lead: "The AI ranks the sectors with what is on the map now.",
      prompt: `Assign a team: press Send ${callsign(p.target.team)} to ${p.target.sector} on the card in Needs you, Edit it to send another team, or click another sector on the map.`,
      // the reason's first clause (the card has the whole of it)
      agentSays: p.reason.split(/:\s/)[0],
      options: [
        { key: "1", id: "approve", label: `${callsign(p.target.team)} to ${p.target.sector}`, costMin: 0, effect: `${callsign(p.target.team)} walks out and sweeps ${p.target.sector}`, agent: true, on: "the card's button in Needs you" },
        ...(other ? [{ key: "2", id: `team:${other.id}`, label: `${callsign(other.id)} to ${p.target.sector}`, costMin: 0, effect: `${callsign(other.id)} walks out and sweeps ${p.target.sector}`, on: "Edit on the card, then its button" }] : []),
        { key: "M", id: "map", label: "Another sector, on the map", costMin: 0, effect: "the team you assign there sweeps it", on: "a sector on the map" },
      ],
      target: ["[data-story-proposal]", `[data-proposal="${p.id}"]`, REGION.needs],
      proposal: p.id,
    });
  }

  // 5. the lost link: let it finish, or divert drone three as a relay
  const link = drones.length ? lostLink(full) : null;
  if (link) {
    const relay = drones.find((x) => x.id !== link.drone && x.id !== drones[0]!.id) ?? drones.find((x) => x.id !== link.drone);
    out.push({
      id: "link",
      key: "link",
      at: link.at,
      lead: "Teams walk to their sectors; the drones fly their flight lines.",
      prompt: `Handle the lost link: let ${droneWord(link.drone, full)} finish its flight line, or divert ${relay ? droneWord(relay.id, full) : "another drone"} as a relay.`,
      agentSays: `${droneWord(link.drone, full)[0]!.toUpperCase()}${droneWord(link.drone, full).slice(1)} has lost its link and flies its approved flight line on its own.`,
      options: [
        { key: "1", id: "finish", label: "Let it finish the flight line", costMin: 0, effect: "its photos arrive late, when the link comes back", agent: true },
        { key: "2", id: "relay", label: `Divert ${relay ? droneWord(relay.id, full) : "a drone"} as a relay`, costMin: 0, effect: `the link comes back now; ${relay ? droneWord(relay.id, full) : "that drone"}'s own flight line stops` },
      ],
      target: [`[data-drone="${link.drone}"]`, REGION.resources],
    });
  }

  // 6. gusts: recall now, or finish the line inside the margin
  const r = drones.length && full ? recall(full) : null;
  if (r)
    out.push({
      id: "wind",
      key: "wind",
      at: ms(r.created_at),
      lead: "Gusts build against the drones' limit.",
      prompt: "Bring the drones in: press the recall card's button in Needs you, or finish the current flight line first.",
      agentSays: r.reason,
      options: [
        { key: "1", id: "recall", label: "Recall now", costMin: 0, effect: "the drones turn for base; the ground teams carry the search", agent: true, on: "the card's button in Needs you" },
        { key: "2", id: "finish", label: "Finish the flight line first", costMin: 2, effect: "two more minutes of photos, inside the margin" },
      ],
      target: [`[data-proposal="${r.id}"]`, REGION.needs],
      proposal: r.id,
    });

  // 7. the find, once a pass detects the subject; or another assignment after a pass with no find
  const passes = passesFrom(input.seed, subject, input.user);
  const detected = passes.find((x) => x.detected && !x.cut);
  const foundMarked = input.user.some(isFoundEvent);
  const live = passes.filter((x) => !x.cut);
  let k = 1;
  for (const x of live) {
    if (x.detected) break;
    // a pass with no find, with nobody else still out and nobody sent since: the agent's next proposal waits
    const sentSince = input.user.some((e) => e.type === "task.updated" && ms(e.at) > x.start && (e.data as { state?: string } | null)?.state === "assigned");
    const othersOut = live.some((o) => o !== x && o.start < x.end && o.end > x.end);
    if (othersOut) continue;
    k += 1;
    // the second assignment can stand for the rest: the agent's picks in turn until the find, no more decisions
    if (k > 2 && standing(input.choices)) continue;
    if (!sentSince || input.choices.some((c) => c.key === `assign-${k}`)) {
      out.push({
        id: "assign",
        key: `assign-${k}`,
        at: x.end,
        lead: "The teams sweep their sectors.",
        prompt: k === 2 ? "Assign again: press Send on the card in Needs you, and every free team takes the AI's picks until the find; or click a sector on the map." : "Assign again: press Send on the card in Needs you for the AI's next sector, or click a sector on the map.",
        agentSays: `${x.sector} searched at ${podLabel(x.pod)}, no sign. The AI suggests the likeliest open sector next.`,
        options: [
          { key: "1", id: "approve", label: k === 2 ? "The AI's picks, every free team" : "The AI's next sector", costMin: 0, effect: k === 2 ? "each team that comes free takes the likeliest open sector, until the find" : `${callsign(x.team)} walks to it and sweeps it`, agent: true, on: "the card's button in Needs you" },
          { key: "M", id: "map", label: "Another sector, on the map", costMin: 0, effect: "the team you assign there sweeps it", on: "a sector on the map" },
        ],
        target: ["[data-story-proposal]", REGION.needs],
        proposal: `g${String(passes.indexOf(x) + 1).padStart(3, "0")}`,
      });
    }
  }
  if (detected || foundMarked) {
    const team = detected?.team ?? "";
    out.push({
      id: "find",
      key: "find",
      at: detected?.end ?? 0,
      lead: "The teams sweep their sectors.",
      prompt: `Answer ${callsign(team)}'s call: press Record find on its card in Needs you (the nearest team goes to carry out), or ask for a confirmation first.`,
      agentSays: detected ? `${callsign(team)}: subject located in ${detected.sector}, conscious and talking.` : undefined,
      options: [
        { key: "1", id: "found", label: "Mark Found, send a carry-out", costMin: 0, effect: "the status line flips to Found", agent: true, on: "Record find on the card in Needs you" },
        { key: "2", id: "confirm", label: "Ask for a confirmation first", costMin: 1, effect: "one more radio exchange, then Found" },
      ],
      target: [`[data-need="report-${team}"]`, `[aria-label="${callsign(team)} reports the subject"]`, '[aria-label="Mission status"]', REGION.needs],
      find: detected ? { team, sector: detected.sector } : undefined,
    });
  }
  return out.sort((a, b) => a.at - b.at || PIPS.findIndex((x) => x.id === a.id) - PIPS.findIndex((x) => x.id === b.id));
}

/** The second assignment approved as standing: the agent's next picks go without asking. */
export const standing = (choices: readonly Choice[]): boolean => choices.some((c) => c.key === "assign-2" && c.option === "approve");

/** The teams the standing approval sends: every team on the mission. */
const teamIds = (full: DemoFull) => (full.data.teams ?? []).map((t) => t.id);

/**
 * The visitor's events with the standing approval played out (sim.ts playStanding): from the second
 * assignment on, after each pass with no find, that team and every free team go to the agent's next picks.
 */
export function standingUser(full: DemoFull | null, seed: string, user: readonly MissionEvent[], choices: readonly Choice[]): MissionEvent[] {
  if (!standing(choices) || !full) return [...user];
  const from = choices.find((c) => c.key === "assign-2")!.f;
  return playStanding(seed, subjectOf(full), poaOf(full), user, teamIds(full), from, lastLight(full), isFoundEvent, true);
}

/** The inject waiting for a decision: the first not yet decided (triage: until all three cards are). */
export function activeInject(list: readonly Inject[], choices: readonly Choice[]): Inject | null {
  return list.find((i) => !injectDone(i, choices)) ?? null;
}

export function injectDone(i: Inject, choices: readonly Choice[]): boolean {
  if (i.id === "triage") return (i.cards ?? []).every((c) => choices.some((x) => x.key === `triage:${c.id}`));
  return choices.some((x) => x.key === i.key);
}

/** Triage: the card waiting for its answer. */
export function currentCard(i: Inject | null, choices: readonly Choice[]): TriageCard | null {
  if (!i?.cards) return null;
  return i.cards.find((c) => !choices.some((x) => x.key === `triage:${c.id}`)) ?? null;
}

/** The agent's option for an inject (triage: the reference answer for the card). */
export function agentOption(i: Inject, card: TriageCard | null = null): { id: string; label: string } {
  if (i.id === "triage" && card) return { id: card.line, label: TRIAGE_OPTIONS.find((o) => o.id === card.line)!.label };
  const o = i.options.find((x) => x.agent) ?? i.options[0];
  return { id: o?.id ?? "", label: o?.label ?? "" };
}

/** A choice record for an option of an inject made at fixture time `f`. */
export function choiceFor(i: Inject, optionId: string, f: number, card: TriageCard | null = null, watched = false): Choice {
  if (i.id === "triage" && card) {
    const a = optionId as TriageAnswer;
    const label = TRIAGE_OPTIONS.find((o) => o.id === a)?.label ?? a;
    return { key: `triage:${card.id}`, inject: "triage", option: a, label: `${card.id}: ${label}`, agentLabel: `${card.id}: ${agentOption(i, card).label}`, agent: a === card.line, f, costMs: triageEffect(card, a).costMin * 60_000, card: card.id, watched };
  }
  const o = i.options.find((x) => x.id === optionId);
  const ag = agentOption(i);
  return { key: i.key, inject: i.id, option: optionId, label: o?.label ?? optionId, agentLabel: ag.label, agent: optionId === ag.id || !!o?.agent, f, costMs: (o?.costMin ?? 0) * 60_000, watched };
}

/**
 * A decision the visitor made on the console itself (not on the mark): an answer in the review queue, a
 * read-back confirmed, an assignment (Approve on the card, Edit, a sector on the map), the find recorded.
 */
export function choiceFromConsole(i: Inject, input: GuideInput, answers: Readonly<Record<string, string>>, f: number): Choice | null {
  const after = (e: MissionEvent) => ms(e.at) >= i.at;
  if (i.id === "triage") {
    const card = currentCard(i, input.choices);
    const a = card ? answers[card.id] : undefined;
    return card && a ? choiceFor(i, a, f, card) : null;
  }
  if (i.id === "clue") {
    const clue = storyClue(input.full);
    const ok = input.user.some((e) => after(e) && e.type === "clue.added" && e.ref === clue?.id && (e.data as Clue | null)?.confirmed);
    return ok ? choiceFor(i, "confirm", f) : null;
  }
  if (i.id === "assign") {
    const e = input.user.find((x) => after(x) && x.type === "task.updated" && (x.data as { state?: string } | null)?.state === "assigned");
    if (!e) return null;
    const t = e.data as unknown as { team_id: string; sector_id: string };
    const p = input.full?.data.proposals?.find((x) => x.id === i.proposal);
    if (i.key === "assign") {
      if (p && t.team_id === p.target.team && t.sector_id === p.target.sector) return choiceFor(i, "approve", f);
      if (p && t.sector_id === p.target.sector) return { ...choiceFor(i, `team:${t.team_id}`, f), label: `${teamName(input, t.team_id)} to ${t.sector_id}` };
    } else if (input.user.some((x) => x.type === "proposal.decided" && x.ref === i.proposal && after(x))) return choiceFor(i, "approve", f);
    return { ...choiceFor(i, "map", f), label: `${teamName(input, t.team_id)} to ${t.sector_id}` };
  }
  if (i.id === "wind") {
    const ok = input.user.some((e) => after(e) && e.type === "proposal.decided" && e.ref === i.proposal);
    return ok ? choiceFor(i, "recall", f) : null;
  }
  if (i.id === "find") return input.user.some(isFoundEvent) ? choiceFor(i, "found", f) : null;
  return null;
}

const teamName = (input: GuideInput, id: string) => input.full?.data.teams?.find((t) => t.id === id)?.callsign ?? id;

/** The decisions' costs, for the clocks (sim.ts fixtureOf, realOf). */
export const costsOf = (choices: readonly Choice[]): Cost[] => choices.filter((c) => c.costMs > 0).map((c) => ({ f: c.f, ms: c.costMs }));

/** The last light the search runs to (the fixtures' conditions), on the fixtures' clock. */
export function lastLight(full: DemoFull | null): number {
  const c = full?.data.conditions;
  const at = c?.civil_twilight_end ?? c?.sunset;
  return at ? ms(at) : ms(CHECKPOINTS[6]!.at) + 3 * 3600_000;
}

// ---- the end screen: what you did, and the agent's line through the same engine ----

export interface Outcome {
  /** When the find was marked (mission clock), or null: suspended at last light. */
  foundAt: number | null;
  team: string | null;
  sector: string | null;
  passes: Pass[];
}

export interface HotWash {
  outcome: Outcome;
  agent: Line & { team: string | null; foundAt: number | null };
  subject: { sector: string } | null;
  rows: { at: number; inject: InjectId; label: string; you: string; agent: string; changed: string; same: boolean }[];
  /** One line per divergence, and the overall comparison. */
  lines: string[];
  /** Every draw, in order ("C2 pass 1: POD 0.60, draw 0.41 → detected"). */
  draws: string[];
  /** Searched sectors with their cumulative POD (the end screen's map). */
  searched: Map<string, number>;
  strengths: string[];
  tryNext: string[];
}

const fmtMin = (n: number) => (n < 60 ? `${Math.round(n)} min` : `${Math.floor(n / 60)} h ${String(Math.round(n % 60)).padStart(2, "0")} min`);

/** The hot wash: the decisions against the agent's, the draws, one line per divergence. No score. */
export function hotWash(input: GuideInput, list: readonly Inject[]): HotWash {
  const { full, choices } = input;
  const costs = costsOf(choices);
  const real = (f: number) => f + costs.filter((c) => c.f < f).reduce((n, c) => n + c.ms, 0);
  const subject = subjectOf(full);
  const calls = (id: string | null | undefined) => full?.data.teams?.find((t) => t.id === id)?.callsign ?? id ?? "";
  const passes = passesFrom(input.seed, subject, input.user).filter((p) => !p.cut);
  const foundEv = input.user.find(isFoundEvent);
  const fm = (foundEv?.data as { mission?: { found?: { team: string; sector: string } } } | null)?.mission?.found;
  const findChoice = choices.find((c) => c.inject === "find");
  const outcome: Outcome = { foundAt: foundEv ? real(ms(foundEv.at)) + (findChoice?.costMs ?? 0) : null, team: fm?.team ?? null, sector: fm?.sector ?? null, passes };
  const p = storyProposal(full);
  const line = agentLine(input.seed, subject, p?.target.team && p.target.sector ? { team: p.target.team, sector: p.target.sector, at: ms(p.created_at) } : null, poaOf(full), lastLight(full), full ? teamIds(full) : []);
  const agent = { ...line, team: p?.target.team ?? null, foundAt: line.found };
  const rows = choices.map((c) => {
    const i = list.find((x) => x.key === c.key || (c.inject === "triage" && x.id === "triage"));
    const pip = PIPS.find((x) => x.id === c.inject)?.label ?? c.inject;
    let changed = c.costMs ? `+${c.costMs / 60_000} min` : "";
    if (c.inject === "triage" && i?.cards) {
      const card = i.cards.find((x) => x.id === c.card);
      if (card) changed = [triageEffect(card, c.option as TriageAnswer).effect, changed].filter(Boolean).join(", ");
    } else {
      const o = i?.options.find((x) => x.id === c.option) ?? i?.options.find((x) => c.option.startsWith("team:") && x.id.startsWith("team:"));
      if (o) changed = [o.effect, changed].filter(Boolean).join(", ");
    }
    return { at: real(c.f), inject: c.inject, label: pip, you: c.label, agent: c.agentLabel, changed, same: c.agent };
  });
  const lines: string[] = [];
  const firstAssign = choices.find((c) => c.key === "assign");
  if (firstAssign && !firstAssign.agent && p && subject) {
    lines.push(`The agent would have sent ${calls(p.target.team)} to ${p.target.sector} at ${local(real(ms(p.created_at)))}; you sent ${firstAssign.label}; the subject was in ${subject.sector}.`);
  }
  for (const c of choices) if (!c.agent && c.costMs > 0 && c.inject !== "assign") lines.push(`${PIPS.find((x) => x.id === c.inject)?.label}: ${c.label} added ${c.costMs / 60_000} min to the clock.`);
  const clueChoice = choices.find((c) => c.inject === "clue");
  if (clueChoice?.option === "log") lines.push("Clue: logged without mapping, so the map did not shift toward it.");
  const mine = outcome.foundAt;
  const theirs = agent.foundAt;
  if (mine !== null && theirs !== null) {
    const d = Math.round((mine - theirs) / 60_000);
    lines.push(
      d === 0
        ? `Your choices and the AI's choices found the subject at the same time, ${local(mine)}.`
        : d < 0
          ? `Your choices found the subject ${fmtMin(-d)} sooner than the AI's (${local(mine)} against ${local(theirs)}).`
          : `The AI's choices found the subject at ${local(theirs)}, ${fmtMin(d)} before yours (${local(mine)}).`,
    );
  } else if (mine === null && theirs !== null) lines.push(`The AI's choices found the subject at ${local(theirs)}.`);
  // the agent's draws too, where its line went another way
  const sameLine = agent.passes.length === passes.length && agent.passes.every((x, i) => x.sector === passes[i]?.sector && x.team === passes[i]?.team);
  const draws = [...passes, ...(sameLine ? [] : agent.passes.map((x) => ({ ...x, agentLine: true })))].map((x) => {
    const tag = "agentLine" in x ? "the AI's choices, " : "";
    return `${tag}${x.sector} pass ${x.n}: ${podLabel(x.pod)}, draw ${x.draw.toFixed(2)} → ${x.detected ? "detected" : x.inside ? "missed (the subject was there)" : "no sign (the subject was elsewhere)"}`;
  });
  const searched = new Map<string, number>();
  for (const x of passes) if (!x.detected && (mine === null || x.end <= (foundEv ? ms(foundEv.at) : Infinity))) searched.set(x.sector, 1 - (1 - (searched.get(x.sector) ?? 0)) * (1 - x.pod));
  const strengths: string[] = [];
  const tryNext: string[] = [];
  const tri = choices.filter((c) => c.inject === "triage");
  if (tri.length && tri.every((c) => c.agent)) strengths.push("Review photos matched the reference answers: the bag stayed off the map and the photo flagged by the AI re-check went on it.");
  if (clueChoice && clueChoice.option !== "log") strengths.push("The radio clue was read back and mapped before the first assignment.");
  if (firstAssign && subject && firstAssign.label.endsWith(subject.sector)) strengths.push(`The first team went to ${subject.sector}, the sector that held the subject.`);
  if (clueChoice?.option === "log") tryNext.push("Confirm the radio clue next time and watch which sectors rise.");
  if (choices.some((c) => c.inject === "triage" && c.option === "person" && c.card && !c.agent)) tryNext.push("Look again at the grey bag before pinning it: the check cost a team 10 minutes.");
  if (firstAssign && subject && !firstAssign.label.endsWith(subject.sector)) tryNext.push("Compare the sector you picked with the AI's reason on the card.");
  return { outcome, agent, subject: subject ? { sector: subject.sector } : null, rows, lines, draws, searched, strengths, tryNext };
}
