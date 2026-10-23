// What "Follow the search" says at each checkpoint, read off the loaded scenario: the call, the photos
// landing, the review, where next, the run, the find and the debrief, told from the search manager's seat
// in the present tense. Each beat is one or two sentences anchored to a real region of the console
// (Resources, the map, Needs you, the timeline, the status line). Nothing here names a fixed proposal, clue
// or sector: the story reads "the first assignment", "the clue it names", "the find" of whichever scenario
// is loaded, and a beat the scenario does not have is left out. The header's disclosure chip says what kind
// of search this is, so no beat does (`STORY_BANNED`). Pure; built by lane A.

import type { Clue, MissionEvent, Proposal, Team, TimelineEvent } from "../contract";
import { clock, DEMO_TZ } from "../lib/time";
import { BOARD_AT, CHECKPOINTS, FLIGHT, type Checkpoint, type DemoFull } from "./missionTime";

/** One coach mark. `target` is a CSS selector on the console, or several in order of preference. */
export interface Beat {
  text: string;
  target: string | readonly string[];
  /** The mark waits for the visitor's approval of the story's proposal (Skip moves on). */
  gate?: "approve";
}

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
const local = (iso: string) => clock(iso, DEMO_TZ);
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const word = (n: number) => WORDS[n] ?? String(n);
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
/** "Drone 2" → "drone two", "D2" → "drone two". */
function droneName(id: string, names: ReadonlyMap<string, string>): string {
  const name = names.get(id) ?? id;
  const n = /(\d+)$/.exec(name)?.[1];
  return n ? `drone ${word(Number(n))}` : name;
}
/** A name as said aloud: parentheses dropped ("Creek bridge pull-out (demo point)" → "creek bridge pull-out"). */
const spoken = (s: string) => s.replace(/\s*\([^)]*\)/g, "").trim();
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

/** Every line the mission logged, the server's timeline and the events alike, with its time. */
function lines(full: DemoFull): { at: string; text: string; e?: TimelineEvent; ev?: MissionEvent }[] {
  const tl = (full.data.timeline ?? []).map((e) => ({ at: e.at, text: e.text, e }));
  const ev = (full.data.events ?? []).map((e) => ({ at: e.at, text: e.summary, ev: e }));
  return [...tl, ...ev].sort((a, b) => a.at.localeCompare(b.at));
}

/** The call that reports the find: the finding team's last radio call in before it. */
function findCall(full: DemoFull): string | null {
  const f = full.data.mission?.found;
  if (!f) return null;
  const tl = (full.data.timeline ?? []).filter((e) => e.kind === "radio" && e.direction === "in" && e.team === f.team && ms(e.at) <= ms(f.at) && /located|found/i.test(e.text));
  const ev = (full.data.events ?? [])
    .filter((e) => e.type === "radio.turn" && ms(e.at) <= ms(f.at))
    .map((e) => String((e.data as { transcript?: unknown } | null)?.transcript ?? ""))
    .filter((t) => /located|found/i.test(t));
  const said = tl.at(-1)?.text ?? ev.at(-1);
  return said ? spoken(said) : null;
}

/** A recall the agent proposes during the run (gusts past the drones' limit), when the scenario has one. */
function recallProposal(full: DemoFull): Proposal | null {
  const end = ms(CHECKPOINTS[4]!.at);
  return (full.data.proposals ?? []).find((p) => (p.kind === "alert" || p.kind === "retask_drone") && /recall|return|home|base/i.test(`${p.summary} ${p.reason}`) && ms(p.created_at) > ms(BOARD_AT) && ms(p.created_at) <= end) ?? null;
}

/**
 * The story's beats, checkpoint by checkpoint (index = the checkpoint), for the loaded scenario. A
 * checkpoint the scenario has nothing for gets no beat, and the story steps over it.
 */
export function storyBeats(full: DemoFull | null): Beat[][] {
  const out: Beat[][] = CHECKPOINTS.map(() => []);
  if (!full) return out;
  const d = full.data;
  const m = d.mission;
  const teams = d.teams ?? [];
  const callsign = (id: string | null | undefined) => teams.find((t: Team) => t.id === id)?.callsign ?? id ?? "";
  const drones = d.fleet?.drones ?? [];
  const names = new Map(drones.map((x) => [x.id, x.name]));
  const firstDrone = drones[0] ? droneName(drones[0].id, names) : null;
  const all = lines(full);

  // t0, the call: the status line and base camp, as the manager says it on the radio
  const camp = m?.base_camp?.name ? spoken(m.base_camp.name) : "";
  const at0 = CHECKPOINTS[0]!.at;
  out[0]!.push({
    text: [
      `${local(at0)}.`,
      m?.last_seen_at ? `Last seen at ${local(m.last_seen_at)}.` : "",
      teams.length ? `${cap(word(teams.length))} teams at base${camp && !/^base camp$/i.test(camp) ? `, the ${camp[0]!.toLowerCase()}${camp.slice(1)}` : ""}.` : "",
      firstDrone ? `${cap(firstDrone)} up.` : "",
    ]
      .filter(Boolean)
      .join(" "),
    target: REGION.status,
  });

  // t1, photos land: the map under the survey, the Photos count, the first candidates in Needs you
  const photos = (d.mapUpdates ?? []).filter((u) => u.source === "frame" && ms(u.at) <= ms(FLIGHT.end)).length;
  const count = photos > 1 ? `${photos} photos` : "";
  out[1]!.push({
    text: firstDrone
      ? `${cap(firstDrone)} flies the survey from base and ${count || "its photos"} land as it goes. The map dims where it has looked and brightens where it has not.`
      : `${count ? cap(count) : "The photos"} land from the survey flight. The map dims where it has looked and brightens where it has not.`,
    target: [`${REGION.map} figure`, REGION.map],
  });
  out[1]!.push({ text: "The detector ranks each photo as it lands, and the first candidates are already waiting for me in Needs you.", target: [REGION.review, REGION.needs] });

  // t2, confirm: two plain people, one thing that is not a person, and the one the queue would have dropped
  out[2]!.push({ text: "The first two are plainly people: Person, Person, two clicks, and each one is a pin on the map.", target: [`group:${REGION.review} ol > li[data-candidate]:nth-child(-n+2)`, REGION.review, REGION.needs] });
  out[2]!.push({ text: "This one is a grey bag at the edge of a photo. Not a person, and it leaves the queue.", target: [`[data-candidate="${STORY_NOT_A_PERSON}"]`, REGION.review, REGION.needs] });
  // the second look's promotion still waiting at the review, when the queue has no card for it
  const t2 = ms(CHECKPOINTS[2]!.at);
  const relook = (d.proposals ?? []).find((p) => p.kind === "promote_detection" && ms(p.created_at) <= t2 && (!p.decided_at || ms(p.decided_at) > t2));
  out[2]!.push({
    text: "This one scored under the line the queue keeps, and the second look caught it. I open its images, see a person and mark Person: the pin lands and the map brightens there.",
    target: [`${REGION.review} li:has(button[aria-expanded])`, ...(relook ? [`[data-proposal="${relook.id}"]`] : []), REGION.review, REGION.needs],
  });

  // t3, where next: the clue by radio, then the agent's proposal that names it, which waits for approval
  const p = storyProposal(full);
  const clue = storyClue(full);
  if (clue) {
    const who = clue.source === "radio" ? callsign(clue.reported_by) : "";
    out[3]!.push({
      text: who
        ? `${who} on the radio: ${clue.text}. I confirm it as a clue and the map moves toward it.`
        : `A clue comes in: ${clue.text}. I confirm it and the map moves toward it.`,
      // the call and the clue it became: the newest entries of the two kinds, ringed together
      target: [`group:${REGION.timeline} li[data-kind="clue"], ${REGION.timeline} li[data-kind="radio"]`, REGION.timeline],
    });
  }
  if (p) {
    const names = clue && (new RegExp(`\\b${clue.id}\\b`).test(p.reason) || p.reason.includes(short(clue)));
    out[3]!.push({
      text: `The agent proposes ${callsign(p.target.team)} for ${p.target.sector}${names ? ", and its reason names that clue" : ", and says why"}. Nobody moves until I approve.`,
      target: ["[data-story-proposal]", `[data-proposal="${p.id}"]`, REGION.needs],
      gate: "approve",
    });
  }

  // t4, run: the fleet's trouble (a lost link, a relay), a recall when gusts rise, and the team walking the sector
  const run = all.filter((x) => ms(x.at) > ms(BOARD_AT) && ms(x.at) <= ms(CHECKPOINTS[4]!.at));
  const lost = run.map((x) => /^(D\d+) link lost/.exec(x.text)?.[1]).find(Boolean);
  const relay = run.map((x) => /^(.+?) heard via (D\d+)/.exec(x.text)).find(Boolean);
  const fleet = [
    lost ? `${cap(droneName(lost, names))} loses its link and flies its approved leg on its own.` : "",
    relay ? `${cap(droneName(relay[2]!, names))} relays ${relay[1]}, who has no signal.` : "",
  ].filter(Boolean);
  const cards = [lost, relay?.[2]].filter(Boolean).map((id) => `[data-drone="${id}"]`);
  if (fleet.length) out[4]!.push({ text: fleet.join(" "), target: [`group:${cards.join(", ")}`, REGION.resources] });
  const recall = recallProposal(full);
  if (recall) out[4]!.push({ text: "Gusts rise past the drones' limit and the agent proposes a recall. I approve, and the drones turn for base.", target: [`[data-proposal="${recall.id}"]`, REGION.needs] });
  if (p) out[4]!.push({ text: `${callsign(p.target.team)} walks ${p.target.sector}, the sector the clue raised.`, target: [`${REGION.map} figure`, REGION.map] });

  // t5, the find: the radio, and the status line flips to Found
  const f = m?.found;
  if (f) {
    const call = findCall(full);
    out[5]!.push({
      text: `${call ? `"${call}"` : `${callsign(f.team)} finds the subject${f.sector ? ` in ${f.sector}` : ""}.`} The status line flips to Found, and the map holds on the find.`,
      target: REGION.status,
    });
  }

  // t6, the debrief: the after-action report once the subject is found
  out[6]!.push(
    f
      ? { text: "Back at base, the after-action report is already written from the timeline: every clue, every decision and who made it, ready to print or file.", target: [REGION.report, REGION.debrief] }
      : { text: "The debrief: what the detector found, how fast, and what breaks first.", target: REGION.debrief },
  );
  return out;
}

/** How many beats each checkpoint has (the story store steps through them). */
export const beatCounts = (beats: readonly (readonly Beat[])[]): number[] => beats.map((b) => b.length);

/** A beat's 1-based number in the whole story (the dots on the card). */
export function markIndex(beats: readonly (readonly Beat[])[], t: Checkpoint, beat: number): number {
  return beats.slice(0, t).reduce((n, b) => n + b.length, 0) + Math.min(beat, Math.max(0, (beats[t]?.length ?? 1) - 1)) + 1;
}
