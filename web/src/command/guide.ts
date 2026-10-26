// The guided search (`#m/demo?guide=1`, .documents/SIM_DESIGN.md §2–§5): the scenario as a run of
// injects, each a decision the search manager makes while the mission clock waits. Survey · Triage · Clue ·
// Assign · Link · Wind · Find, the ones the loaded scenario has (no drones: no survey, link or wind). Each
// inject names its options with what each costs in mission minutes before the commit, and which is the
// agent's; the console's own actions (an answer in the review queue, Approve on the card, a sector on the
// map, Confirm on a read-back, the find in a sector's popover) count as the decision too. The same engine
// (sim.ts) plays the agent's line for "Watch instead" and for the end screen's comparison. Copy: verb
// first, one sentence, the key last, no first person, none of STORY_BANNED. Pure; built by lane A.

import type { Clue, MissionEvent, Proposal, Team } from "../contract";
import { clock, DEMO_TZ } from "../lib/time";
import { SECOND_LOOK_ID } from "./demoReview";
import { BOARD_AT, CHECKPOINTS, conditionsAt, hastyAt, hastyLeaves, isFoundEvent, pendingSightings, poaOf, subjectOf, type DemoFull } from "./missionTime";
import { agentLine, passesFrom, playStanding, RETURN_MS, type Cost, type Line, type Pass } from "./sim";
import { WATCH_BY } from "./console";
import { REGION, STORY_NOT_A_PERSON, storyClue, storyProposal } from "./storyCopy";
import { aiPick } from "./subjectMatch";
import { podLabel, TERMS } from "./terms";

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

export type TriageAnswer = "person" | "not_person" | "not_subject" | "group" | "object" | "unsure";
/** The review card's own answers and keys (review/answers.tsx): triage is answered on the card. */
export const TRIAGE_OPTIONS: readonly { key: string; id: TriageAnswer; label: string }[] = [
  { key: "P", id: "person", label: "The subject" },
  { key: "S", id: "not_subject", label: "Another person" },
  { key: "N", id: "not_person", label: "Not a person" },
  { key: "G", id: "group", label: "A group (2+ people)" },
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
  /** The lost link: the drone, and the one that can relay for it (ids and names). */
  link?: { drone: string; relay: string | null; lostName: string; relayName: string | null };
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

/** How long the drones wait before the wind is looked at again. */
export const RECHECK_MS = 30 * 60_000;

/**
 * The drones grounded at the call (the conditions as they stood then say so): why, and when the wind is
 * looked at again (fixtures' clock). Null: they can fly.
 */
export function groundedAtCall(full: DemoFull | null): { reason: string; recheck: number } | null {
  if (!full?.data.fleet?.drones.length) return null;
  const at = ms(CHECKPOINTS[0]!.at);
  const c = conditionsAt(full.data, at);
  return c && c.flyable === false ? { reason: c.flyability_reason || "over the drones' limits", recheck: at + RECHECK_MS } : null;
}

/** "Fly anyway" was chosen at the survey step (logged with who approved it). */
export const flewAnyway = (choices: readonly { inject: string; option: string }[]): boolean => choices.some((c) => c.inject === "survey" && c.option === "override");

/**
 * How long after the call the survey was approved (ms, on the fixtures' clock): the scenario's drones fly
 * that much later (missionTime.ts dronesLater). The guided run decides it at the call (0); free play asks
 * for it in Needs you and the flight takes off when the visitor approves it.
 */
export function surveyLate(choices: readonly { inject: string; f?: number }[]): number {
  const c = choices.find((x) => x.inject === "survey");
  return c && typeof c.f === "number" ? Math.max(0, c.f - ms(CHECKPOINTS[0]!.at)) : 0;
}

/** The scenario's flight lines after the survey fly: the AI's flight lines were chosen (they include them), not the lawnmower pattern. */
export const legsFly = (choices: readonly { inject: string; option: string }[]): boolean => choices.some((c) => c.inject === "survey" && c.option !== "serpentine");

/**
 * The standing approval's words on Send all, said before the click (the cold test: later assignments said
 * "auto-approved (your standing approval)" with nothing on the button saying so).
 */
export const STANDING_NOTE = ", and keep sending free teams to the AI's picks until you change it";

/** The drones stay on the ground for this run: grounded at the call and no "Fly anyway". */
export function dronesWait(full: DemoFull | null, choices: readonly { inject: string; option: string }[]): { recheck: number } | null {
  const g = groundedAtCall(full);
  return g && !flewAnyway(choices) ? { recheck: g.recheck } : null;
}

/**
 * The three cards to triage: a plain person, the grey bag, and the second look's catch. The AI's pick on
 * each (its reference answer, what Watch instead answers and what the end screen scores against) compares
 * the photo with this scenario's subject (subjectMatch.ts): the same red-jacket adult is the overdue
 * hiker's subject and another person in the missing child's search.
 */
export function triageCards(queue: GuideInput["queue"], subject: string | null = null): TriageCard[] {
  const plain = queue.find((c) => c.id !== STORY_NOT_A_PERSON && c.id !== SECOND_LOOK_ID);
  const bag = queue.find((c) => c.id === STORY_NOT_A_PERSON) ?? queue.find((c) => c !== plain && c.id !== SECOND_LOOK_ID);
  const relook = queue.find((c) => c.id === SECOND_LOOK_ID);
  const out: TriageCard[] = [];
  const card = (id: string, fallback: TriageAnswer, says: string): TriageCard => {
    const p = aiPick(id, subject);
    return p ? { id, says: p.line, line: p.answer } : { id, says, line: fallback };
  };
  if (plain) out.push(card(plain.id, "person", `AI: a person — detector score ${plain.conf.toFixed(2)}`));
  if (bag) out.push(card(bag.id, "not_person", `AI: not a person — detector score ${bag.conf.toFixed(2)}`));
  if (relook) out.push(card(relook.id, "person", `AI: likely a person — ${TERMS.recheckFlagged}`));
  return out;
}

/** Each answer's one meaning, whatever the photo (the review frame and the cards say the same). */
export const ANSWER_EFFECT: Readonly<Record<TriageAnswer, string>> = {
  person: "a sighting pin goes on the map where the photo puts it",
  not_subject: "a witness lead goes on the map: someone to ask what they saw",
  group: "a sighting pin for the group and a witness lead: the subject may be with them",
  not_person: `it leaves ${TERMS.review}; the map counts the look`,
  object: "a possible clue for a team to confirm on the ground",
  unsure: "it stays flagged for a second reviewer",
};

/**
 * What one triage answer does, shown before the commit: one meaning per answer on every photo (the cold
 * test found Person meant a pin on one photo and a team's walk on the next).
 */
export function triageEffect(_card: TriageCard, a: TriageAnswer): { effect: string; costMin: number } {
  return { effect: ANSWER_EFFECT[a], costMin: 0 };
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

  // 1. survey: the planner's legs or a serpentine; nothing flies until then. Grounded at the call: the
  // ground teams first and the drones wait for the wind, or fly anyway (an override, logged with its approver)
  const grounded = groundedAtCall(full);
  const wait = dronesWait(full, input.choices);
  if (drones.length && grounded) {
    const recheck = local(grounded.recheck);
    out.push({
      id: "survey",
      key: "survey",
      at: ms(CHECKPOINTS[0]!.at),
      lead: "The call comes in; the wind is over the drones' limit.",
      prompt: `${hastyFact(full)}Drones are grounded (${grounded.reason}): send ground teams first and let the drones wait for the wind, or fly anyway.`,
      agentSays: `Send ground teams first; drones wait for the wind (re-check at ${recheck}).`,
      options: [
        { key: "1", id: "wait", label: `Ground teams first; drones wait for the wind (re-check at ${recheck})`, costMin: 0, effect: "no drone flies while the status says grounded; the teams carry the search", agent: true },
        { key: "2", id: "override", label: "Fly anyway (override, logged)", costMin: 0, effect: "the survey flies in gusts over the limit; the override goes in the log with your name" },
      ],
      target: [REGION.status, REGION.map],
    });
  } else if (drones.length) {
    const poa = [...poaOf(full).entries()].sort((a, b) => b[1] - a[1]);
    const top = poa.slice(0, 3);
    const share = top.reduce((n, [, p]) => n + p, 0) / Math.max(1e-9, poa.reduce((n, [, p]) => n + p, 0));
    // the scenario's flight lines after the survey come with the AI's flight lines, and the option says so
    const lines = [...new Set((d.fleet?.legs ?? []).filter((l) => l.status !== "proposed" && l.sector_id).map((l) => l.sector_id as string))];
    const then = lines.length ? `; once the photos are in, flight lines over ${lines.length > 1 ? `${lines.slice(0, -1).join(", ")} and ${lines.at(-1)}` : lines[0]}` : "";
    out.push({
      id: "survey",
      key: "survey",
      at: ms(CHECKPOINTS[0]!.at),
      lead: "The call comes in; the agent drafts the survey.",
      prompt: `${hastyFact(full)}Launch the survey: fly ${TERMS.aiChoices.replace("choices", "flight lines")}, or a ${TERMS.lawnmower}.`,
      agentSays: top.length ? `${top.map(([s]) => s).join(", ")} first: ${Math.round(share * 100)} % of the probability in ${top.length} of ${poa.length} sectors.` : undefined,
      options: [
        { key: "1", id: "planner", label: "The AI's flight lines", costMin: 0, effect: `${droneWord(drones[0]!.id, full)} photographs the likeliest sectors first${then}`, agent: true },
        { key: "2", id: "serpentine", label: "Lawnmower pattern, whole grid", costMin: 12, effect: `every sector once, row by row; the likeliest ones are photographed 12 min later${then ? "; no flight lines after it" : ""}` },
      ],
      target: [REGION.map],
    });
  }

  // 2. triage: three candidates, one at a time
  // (no photos while the drones wait on the ground)
  const cards = wait ? [] : triageCards(input.queue, d.mission?.subject ?? null);
  // free play: the survey flies when it is approved, and everything of the drones after it that much later
  const late = surveyLate(input.choices);
  if (cards.length)
    out.push({
      id: "triage",
      key: "triage",
      at: ms(CHECKPOINTS[2]!.at) + late,
      lead: drones.length ? "The drones fly the survey; photos land and the detector ranks each one." : "The survey's photos land and the detector ranks each one.",
      prompt: "Look at the photo beside the subject's description: is it the subject, another person, or not a person?",
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
      // the team that radios it is out on a hasty search along the trail (missionTime.ts hastyAt), the others at base camp
      lead: `${who}, out on a hasty search along the trail, radios a clue.`,
      prompt: `Read back ${who}'s call. In Needs you, press “Confirm clue” on its card; or ask for a bearing, or log it without mapping.`,
      agentSays: `${who}: ${clue.text}.`,
      options: [
        { key: "1", id: "confirm", label: `Confirm at ${clue.reliability ?? "low"} reliability`, costMin: 0, effect: "the map shifts toward it", agent: true, on: "Confirm clue on the card in Needs you" },
        { key: "2", id: "bearing", label: "Ask for a bearing", costMin: 2, effect: "the team radios its bearing and distance to it; the clue waits for you to confirm it" },
        { key: "3", id: "log", label: "Log without mapping", costMin: 0, effect: "it goes in the log; the map stays as it is" },
      ],
      target: [`[data-need="clue-${clue.id}"]`, '[aria-label="Awaiting read-back"]', `group:${REGION.timeline} li[data-kind="clue"], ${REGION.timeline} li[data-kind="radio"]`, REGION.needs],
    });
  }

  // 4. the first assignment: one primary (every free team to the agent's picks), "only this team" second
  const p = storyProposal(full);
  const subject = subjectOf(full);
  const passes = passesFrom(input.seed, subject, input.user);
  const live = passes.filter((x) => !x.cut);
  /** The teams at `at`: free at base camp, walking back (a pass ended, or the hasty search), out on the hasty search. */
  const freeAt = (at: number) => teamsFree(full, live, at);
  if (p?.target.team && p.target.sector) {
    const other = teams.find((t) => t.id !== p.target.team && t.status !== "off_duty") ?? teams.find((t) => t.id !== p.target.team);
    const team = callsign(p.target.team);
    const fr = freeAt(ms(p.created_at));
    const n = Math.max(1, fr.free.length);
    const seen = pendingSightings(full, input.user, passes, ms(p.created_at))[0]?.sector ?? null;
    const ext = { returning: fr.returning.length, hasty: fr.hasty.length, sighting: seen };
    const many = n > 1 || ext.returning + ext.hasty > 0;
    out.push({
      id: "assign",
      key: "assign",
      at: ms(p.created_at),
      lead: "The AI ranks the sectors with what is on the map now.",
      prompt: many ? `Send the teams. On the AI's card in Needs you, press “${sendAllLabel(n, team, p.target.sector, ext)}”; or send only ${team}.` : `Send the team. On the AI's card in Needs you, press “${sendAllLabel(n, team, p.target.sector, ext)}”.`,
      // the reason's first clause (the card has the whole of it)
      agentSays: p.reason.split(/:\s/)[0],
      options: [
        { key: "1", id: "all", label: `${sendAllLabel(n, team, p.target.sector, ext)}${STANDING_NOTE}`, costMin: 0, effect: `${seen ? `the nearest team to the sighting in ${seen} first, then ` : ""}${team} to ${p.target.sector}${many ? ", every other team to the next likeliest sector" : ""}; each team that comes back takes the AI's next pick, until the find or until you stop it`, agent: true, on: "the card's main button in Needs you" },
        ...(many ? [{ key: "2", id: "approve", label: sendOnlyLabel(team, p.target.sector), costMin: 0, effect: `${team} walks out and sweeps ${p.target.sector}; the other teams wait at base camp`, on: "the card's second button" }] : []),
        ...(other ? [{ key: "3", id: `team:${other.id}`, label: `${callsign(other.id)} to ${p.target.sector}`, costMin: 0, effect: `${callsign(other.id)} walks out and sweeps ${p.target.sector}`, on: "Edit on the card, then its button" }] : []),
        { key: "M", id: "map", label: "Another sector, on the map", costMin: 0, effect: "the team you assign there sweeps it", on: "a sector on the map" },
      ],
      target: ["[data-story-proposal] button[data-primary]", "[data-story-proposal]", `[data-proposal="${p.id}"]`, REGION.needs],
      proposal: p.id,
    });
  }

  // 5. the lost link: let it finish, or divert drone three as a relay
  // (the scenario's flight lines fly with the AI's flight lines only: no lost link on a line the lawnmower pattern never flew)
  const lines = !input.choices.some((c) => c.inject === "survey") || legsFly(input.choices);
  const link = drones.length && !wait && lines ? lostLink(full) : null;
  if (link) {
    const relay = drones.find((x) => x.id !== link.drone && x.id !== drones[0]!.id) ?? drones.find((x) => x.id !== link.drone);
    out.push({
      id: "link",
      key: "link",
      at: link.at + late,
      lead: "Teams walk to their sectors; the drones fly their flight lines.",
      prompt: `Handle the lost link: let ${droneWord(link.drone, full)} finish its flight line, or divert ${relay ? droneWord(relay.id, full) : "another drone"} as a relay.`,
      agentSays: `${droneWord(link.drone, full)[0]!.toUpperCase()}${droneWord(link.drone, full).slice(1)} has lost its link and flies its approved flight line on its own.`,
      options: [
        { key: "1", id: "finish", label: "Let it finish the flight line", costMin: 0, effect: "its photos arrive late, when the link comes back", agent: true },
        { key: "2", id: "relay", label: `Divert ${relay ? droneWord(relay.id, full) : "a drone"} as a relay`, costMin: 0, effect: `the link comes back now; ${relay ? droneWord(relay.id, full) : "that drone"}'s own flight line stops` },
      ],
      target: [`[data-drone="${link.drone}"]`, REGION.resources],
      link: { drone: link.drone, relay: relay?.id ?? null, lostName: droneWord(link.drone, full).replace(/^d/, "D"), relayName: relay ? droneWord(relay.id, full).replace(/^d/, "D") : null },
    });
  }

  // 6. gusts: recall now, or finish the line inside the margin
  const r = drones.length && full && !wait ? recall(full) : null;
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
        { key: "2", id: "finish", label: "Finish the flight line first (override, logged)", costMin: 2, effect: "two more minutes of photos in gusts over the limit; the override goes in the log with your name" },
      ],
      target: [`[data-proposal="${r.id}"]`, REGION.needs],
      proposal: r.id,
    });

  // 7. the find, once a pass detects the subject; or, after every pass with no find, the agent's next pick
  // for that team (it keeps proposing until the find, so no team waits at base camp with nobody asked)
  const detected = passes.find((x) => x.detected && !x.cut);
  const foundMarked = input.user.some(isFoundEvent);
  const windows = standingWindows(input.choices, input.user, full);
  let k = 1;
  // (the clock waits at each pass's end, so whatever the visitor does there is that step's decision)
  for (const x of [...live].sort((a, b) => a.end - b.end || a.start - b.start)) {
    if (x.detected || (detected && x.end > detected.end)) continue;
    k += 1;
    // "send all" (until stopped) or last light: the agent's picks go to each team as it comes back, until the find
    if (windows.some((w) => w.from <= x.end && x.end < w.until)) continue;
    const team = callsign(x.team);
    const fr = freeAt(x.end);
    // the team whose pass just ended is the one asked about: counted where the board has it (walking back),
    // so the button's numbers are the header's (round 3: "Send all 3 free teams" over "2 free · 1 returning")
    const mine = fr.free.some((t) => t.id === x.team) || fr.returning.some((t) => t.id === x.team);
    const returning = mine ? fr.returning : [...fr.returning, ...teams.filter((t) => t.id === x.team)];
    const n = fr.free.length;
    const seen = pendingSightings(full, input.user, passes, x.end)[0]?.sector ?? null;
    const ext = { returning: returning.length, hasty: fr.hasty.length, sighting: seen };
    const many = n + ext.returning + ext.hasty > 1;
    out.push({
      id: "assign",
      key: `assign-${k}`,
      at: x.end,
      lead: "The teams sweep their sectors.",
      prompt: many ? `Send the teams again (a team is back). On the AI's card in Needs you, press “${sendAllLabel(n, team, "the AI's pick", ext)}”; or send only ${team}.` : `Send ${team} again (it is back). On the AI's card in Needs you, press its main button for the AI's next sector.`,
      agentSays: `${x.sector} searched at ${podLabel(x.pod)}, no sign. The AI suggests the likeliest open sector next.`,
      options: [
        { key: "1", id: "all", label: `${sendAllLabel(n, team, "the AI's pick", ext)}${STANDING_NOTE}`, costMin: 0, effect: `${seen ? `the nearest team to the sighting in ${seen} first; ` : ""}each free team takes the likeliest open sector, and each team that comes back the next one, until the find or until you stop it`, agent: true, on: "the card's main button in Needs you" },
        ...(many ? [{ key: "2", id: "approve", label: `Send only ${team} to the AI's pick`, costMin: 0, effect: `${team} walks to it and sweeps it; the other free teams wait at base camp`, on: "the card's second button" }] : []),
        { key: "M", id: "map", label: "Another sector, on the map", costMin: 0, effect: "the team you assign there sweeps it", on: "a sector on the map" },
      ],
      target: ["[data-story-proposal] button[data-primary]", "[data-story-proposal]", REGION.needs],
      proposal: `g${String(passes.indexOf(x) + 1).padStart(3, "0")}`,
    });
  }
  if (detected || foundMarked) {
    const team = detected?.team ?? "";
    out.push({
      id: "find",
      key: "find",
      at: detected?.end ?? 0,
      lead: "The teams sweep their sectors.",
      prompt: `Answer ${callsign(team)}'s call. In Needs you, press “Record find” on its card (the nearest team goes to carry out); or ask for a confirmation first.`,
      agentSays: detected ? `${callsign(team)}: subject located in ${detected.sector}, conscious and talking.` : undefined,
      options: [
        { key: "1", id: "found", label: "Mark Found, send a carry-out", costMin: 0, effect: "the status line flips to Found", agent: true, on: "Record find on the card in Needs you" },
        { key: "2", id: "confirm", label: "Ask for a confirmation first", costMin: 1, effect: "one more radio exchange, then Found" },
      ],
      target: [`[data-need="report-${team}"]`, `[aria-label="${callsign(team)} reports the subject"]`, '[aria-label="Mission status"]', REGION.needs],
      find: detected ? { team, sector: detected.sector } : undefined,
    });
  }
  const sorted = out.sort((a, b) => a.at - b.at || PIPS.findIndex((x) => x.id === a.id) - PIPS.findIndex((x) => x.id === b.id));
  // nothing comes after the find (a lost link or the gusts that would have come later never ask)
  const find = sorted.find((i) => i.id === "find");
  return find && detected ? sorted.filter((i) => i.at <= find.at || i.id === "find" || injectDone(i, input.choices)) : sorted;
}

/**
 * The assign step's one primary, the same words on the card and the coach bar. `n` counts only the teams
 * free at base camp; the ones walking back or out on the hasty search are said apart (they go from where
 * they are), and a sighting still waiting for a team is sent first (the cold test: Send all dropped it).
 */
export function sendAllLabel(n: number, team: string, sector: string, ext: { returning?: number; hasty?: number; sighting?: string | null } = {}): string {
  const r = ext.returning ?? 0;
  const h = ext.hasty ?? 0;
  const first = ext.sighting ? `, the nearest one to the sighting in ${ext.sighting} first` : "";
  if (!r && !h) return n > 1 ? `Send all ${n} free teams to the AI's picks${first}` : ext.sighting ? `Send ${team} to ${sector}, and the nearest team to the sighting in ${ext.sighting}` : `Send ${team} to ${sector}`;
  if (!n && r + h === 1) return ext.sighting ? `Send ${team} to ${sector}, and the nearest team to the sighting in ${ext.sighting}` : `Send ${team} to ${sector}`;
  // the counts are the board's (Resources: free, returning, out on the hasty search), never one team twice
  const parts = n ? [`the ${n} free ${n === 1 ? "team" : "teams"}`] : [];
  // the returning ones (and any still on the hasty search) go now too, from where they are on the trail
  if (r) parts.push(`the ${r} returning ${r === 1 ? "one" : "ones"}`);
  if (h) parts.push(`the ${h} on the hasty search`);
  const list = parts.length > 2 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts.join(" and ");
  return `Send ${list} to the AI's picks now${first}`;
}

/**
 * The teams at `at`, in three kinds: free at base camp (no pass under way, not walking back), walking back to
 * base camp (a pass ended with no find, or the hasty search's way home), and out on the hasty search. A team
 * on a pass is in none of them. "Send all N free teams" counted the returning ones (the cold test: 4 for 2).
 */
export function teamsFree(full: DemoFull, live: readonly Pass[], at: number): { free: Team[]; returning: Team[]; hasty: Team[] } {
  const out = { free: [] as Team[], returning: [] as Team[], hasty: [] as Team[] };
  for (const t of full.data.teams ?? []) {
    if (t.status === "off_duty") continue;
    const own = live.filter((x) => x.team === t.id && x.start <= at);
    if (own.some((x) => x.end > at)) continue;
    const last = own.sort((a, b) => a.end - b.end).at(-1);
    if (last && at < last.end + RETURN_MS) out.returning.push(t);
    else if (!last) {
      const h = hastyAt(t, full.data.clues ?? [], at);
      if (h?.status === "returning") out.returning.push(t);
      else if (h) out.hasty.push(t);
      else out.free.push(t);
    } else out.free.push(t);
  }
  return out;
}

/** The hasty search as a fact before the first decision: who is already out on it, pre-planned in the scenario. */
export function hastyFact(full: DemoFull): string {
  const out = hastyLeaves(full);
  if (!out.length) return "";
  const names = out.map((x) => x.team.callsign);
  const who = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]!;
  const nums = names.length > 1 ? `Teams ${names.map((x) => x.replace(/^Team /, "")).slice(0, -1).join(", ")} and ${names.at(-1)!.replace(/^Team /, "")}` : who;
  const at = local(Math.min(...out.map((x) => x.leave)));
  return `${names.every((x) => /^Team /.test(x)) ? nums : who} ${names.length > 1 ? "are" : "is"} already out on a hasty search along the trail (sent at the call, ${at}: pre-planned in the scenario, before you took over). `;
}
/** The assign step's second choice: the proposal's own team only. */
export const sendOnlyLabel = (team: string, sector: string): string => `Send only ${team} to ${sector}`;

/**
 * When the agent's picks start going to every free team without asking (fixtures' clock): when "send all"
 * was chosen, or at last light at the latest (the fallback: the search goes on through the night with every
 * team out, so a run where the visitor sent one team at a time still reaches the find). Null: no scenario.
 */
export function standingFrom(choices: readonly Choice[], full: DemoFull | null): number | null {
  const c = choices.find((x) => x.inject === "assign" && x.option === "all");
  const xs = [c?.f, full ? lastLight(full) : undefined].filter((x): x is number => typeof x === "number");
  return xs.length ? Math.min(...xs) : null;
}

/** How long the guided search runs on after last light (night search) before it would suspend. */
export const NIGHT_MS = 8 * 3600_000;
/** The end of the guided run on the fixtures' clock: last light and the night after it. */
export const searchEnd = (full: DemoFull | null): number => lastLight(full) + NIGHT_MS;

/** The teams the standing approval sends: every team on the mission. */
const teamIds = (full: DemoFull) => (full.data.teams ?? []).filter((t) => t.status !== "off_duty").map((t) => t.id);

/**
 * The visitor's events with "send all" played out (sim.ts playStanding): from that choice on, every free
 * team goes to the agent's picks at once, and after each pass with no find that team takes the next one.
 */
export function standingUser(full: DemoFull | null, seed: string, user: readonly MissionEvent[], choices: readonly Choice[]): MissionEvent[] {
  if (!full) return [...user];
  let out = [...user];
  for (const w of standingWindows(choices, user, full)) out = playStanding(seed, subjectOf(full), poaOf(full), out, teamIds(full), w.from, w.until, isFoundEvent, true, w.note);
  return out;
}

/** The visitor's "Stop sending" on a standing approval (a mission note with this action). */
export const STANDING_STOP = "standing_stop";
const isStop = (e: MissionEvent) => e.type === "mission.note" && (e.data as { action?: string } | null)?.action === STANDING_STOP;

/**
 * When the agent's picks go to the free teams without asking again (fixtures' clock): from each Send all
 * until the visitor stops it (Needs you's "Stop sending"), and from last light through the night (the guided
 * search's own rule, so every run reaches the find), each with whose approval it is, in the log's words.
 */
export function standingWindows(choices: readonly Choice[], user: readonly MissionEvent[], full: DemoFull | null): { from: number; until: number; note: string; mine: boolean }[] {
  if (!full) return [];
  const end = searchEnd(full);
  const light = lastLight(full);
  const marks = [
    ...choices.filter((x) => x.inject === "assign" && x.option === "all").map((c) => ({ at: c.f, start: c })),
    ...user.filter(isStop).map((e) => ({ at: ms(e.at), start: null })),
  // (at one minute, a Send all comes before its Stop: a paused clock makes both at the same minute)
  ].sort((a, b) => a.at - b.at || Number(!!b.start) - Number(!!a.start));
  const out: { from: number; until: number; note: string; mine: boolean }[] = [];
  let open: Choice | null = null;
  for (const m of marks) {
    if (m.start && !open) open = m.start;
    else if (!m.start && open) {
      out.push({ from: open.f, until: Math.min(m.at, end), note: `the agent's pick, approved in turn${open.watched ? ` (${WATCH_BY} chose Send all)` : ""}`, mine: true });
      open = null;
    }
  }
  if (open) out.push({ from: open.f, until: end, note: `the agent's pick, approved in turn${open.watched ? ` (${WATCH_BY} chose Send all)` : ""}`, mine: true });
  if (!out.some((w) => w.from <= light && light < w.until)) out.push({ from: light, until: end, note: "the agent's pick, approved in turn from last light", mine: false });
  return out.sort((a, b) => a.from - b.from);
}

/** The visitor's own standing approval in force at `f` (fixtures' clock), or null. */
export function standingAt(choices: readonly Choice[], user: readonly MissionEvent[], full: DemoFull | null, f: number): { from: number; mine: boolean } | null {
  const w = standingWindows(choices, user, full).find((x) => x.from <= f && f < x.until);
  return w ? { from: w.from, mine: w.mine } : null;
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

/** "Photo 1 (survey photo 336)": a triage card as the end screen names it (never the detection's id). */
export function photoTitle(i: Pick<Inject, "cards"> | null | undefined, id: string): string {
  const n = (i?.cards ?? []).findIndex((c) => c.id === id);
  const num = /^f0*(\d+)/.exec(id)?.[1];
  const photo = num ? `survey photo ${num}` : "a photo";
  return n >= 0 ? `Photo ${n + 1} (${photo})` : `${photo[0]!.toUpperCase()}${photo.slice(1)}`;
}

/** A choice record for an option of an inject made at fixture time `f`. */
export function choiceFor(i: Inject, optionId: string, f: number, card: TriageCard | null = null, watched = false): Choice {
  if (i.id === "triage" && card) {
    const a = optionId as TriageAnswer;
    const label = TRIAGE_OPTIONS.find((o) => o.id === a)?.label ?? a;
    const title = photoTitle(i, card.id);
    return { key: `triage:${card.id}`, inject: "triage", option: a, label: `${title}: ${label}`, agentLabel: `${title}: ${agentOption(i, card).label}`, agent: a === card.line, f, costMs: triageEffect(card, a).costMin * 60_000, card: card.id, watched };
  }
  const o = i.options.find((x) => x.id === optionId);
  const ag = agentOption(i);
  return { key: i.key, inject: i.id, option: optionId, label: o?.label ?? optionId, agentLabel: ag.label, agent: optionId === ag.id || !!o?.agent, f, costMs: (o?.costMin ?? 0) * 60_000, watched };
}

/**
 * An assignment that carried out an approved sighting proposal (`sight-…`, missionTime.ts): the same team
 * and sector, within a minute of the approval.
 */
export function sightingSend(user: readonly MissionEvent[], e: MissionEvent): boolean {
  const t = e.data as { team_id?: string; sector_id?: string } | null;
  if (e.type !== "task.updated" || !t) return false;
  return user.some((x) => {
    if (x.type !== "proposal.decided" || !x.ref?.startsWith("sight-")) return false;
    const p = x.data as unknown as Proposal | null;
    if (!p || p.status !== "approved") return false;
    return (p.edits?.team ?? p.target.team) === t.team_id && p.target.sector === t.sector_id && Math.abs(ms(e.at) - ms(x.at)) <= 60_000;
  });
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
    const e = input.user.find((x) => after(x) && x.type === "clue.added" && x.ref === clue?.id && ((x.data as Clue | null)?.confirmed || (x.data as { logged?: boolean } | null)?.logged));
    // Confirm clue on its card, or Log without mapping there
    return e ? choiceFor(i, (e.data as { logged?: boolean } | null)?.logged ? "log" : "confirm", f) : null;
  }
  if (i.id === "assign") {
    // the visitor's own move, made by now (not the agent's standing picks, which come later and alone)
    // sending a team to a reviewer's sighting (the AI's "Send Team Two to the sighting") is its own decision, not this step's
    const e = input.user.find((x) => after(x) && ms(x.at) <= f && !x.id.startsWith("auto-") && x.type === "task.updated" && (x.data as { state?: string } | null)?.state === "assigned" && !sightingSend(input.user, x));
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
  // the find at the time the timeline and the header give it (its event on the mission clock): the confirmation's
  // minute was added here on top as well, so the end screen said 15:58 over a timeline's 15:57 (the cold test)
  const outcome: Outcome = { foundAt: foundEv ? real(ms(foundEv.at)) : null, team: fm?.team ?? null, sector: fm?.sector ?? null, passes };
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
  // the sector the first team went to: the proposal's for "send all" and "send only", else the label's end
  const firstSector = firstAssign && p ? (firstAssign.option === "all" || firstAssign.option === "approve" ? p.target.sector : /\b([A-Z]\d+)$/.exec(firstAssign.label)?.[1]) : null;
  if (firstAssign && firstAssign.option === "approve" && p) {
    lines.push(`You sent only ${calls(p.target.team)} to ${p.target.sector} at ${local(real(ms(p.created_at)))}; the AI would have sent every free team at once.`);
  } else if (firstAssign && !firstAssign.agent && p && subject) {
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
    return `${tag}${x.sector} pass ${x.n}: ${podLabel(x.pod)}, roll ${x.draw.toFixed(2)} → ${x.detected ? "detected" : x.inside ? "missed (the subject was there)" : "no sign (the subject was elsewhere)"}`;
  });
  const searched = new Map<string, number>();
  for (const x of passes) if (!x.detected && (mine === null || x.end <= (foundEv ? ms(foundEv.at) : Infinity))) searched.set(x.sector, 1 - (1 - (searched.get(x.sector) ?? 0)) * (1 - x.pod));
  const strengths: string[] = [];
  const tryNext: string[] = [];
  const tri = choices.filter((c) => c.inject === "triage");
  if (tri.length && tri.every((c) => c.agent)) strengths.push("Review photos matched the AI's picks against the subject's description: only a photo that fits the subject went on the map as a sighting.");
  // a bearing asked for confirms nothing by itself: the clue counts once the manager confirmed it
  const clueId = storyClue(full)?.id;
  const confirmedLater = input.user.some((e) => e.type === "clue.added" && e.ref === clueId && (e.data as { confirmed?: boolean; logged?: boolean } | null)?.confirmed === true && !(e.data as { logged?: boolean }).logged);
  if (clueChoice && (clueChoice.option === "confirm" || (clueChoice.option === "bearing" && confirmedLater))) strengths.push("The radio clue was read back and mapped before the first assignment.");
  if (firstAssign && subject && firstSector === subject.sector) strengths.push(`The first team went to ${subject.sector}, the sector that held the subject.`);
  if (clueChoice?.option === "log") tryNext.push("Confirm the radio clue next time and watch which sectors rise.");
  const wrongPin = choices.find((c) => c.inject === "triage" && c.option === "person" && c.card && !c.agent);
  if (wrongPin) {
    const triage = list.find((x) => x.id === "triage");
    const says = triage?.cards?.find((x) => x.id === wrongPin.card)?.says.replace(/^AI: /, "");
    tryNext.push(wrongPin.card === STORY_NOT_A_PERSON ? "Look again at the grey bag before pinning it: a pin on it pulls the search toward an empty spot." : `Compare ${photoTitle(triage, wrongPin.card!).replace(/^P/, "p")} with the subject's description before pinning it${says ? ` (${says})` : ""}: a sighting pin sends a team there first.`);
  }
  if (firstAssign && subject && firstSector !== subject.sector) tryNext.push("Compare the sector you picked with the AI's reason on the card.");
  return { outcome, agent, subject: subject ? { sector: subject.sector } : null, rows, lines, draws, searched, strengths, tryNext };
}
