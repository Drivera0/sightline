// "You vs the agent" on the guided search's end screen (GuideEnd.tsx): the visitor's search against the
// agent's line (every decision its pick, same seed, same engine: sim.ts agentLine via guide.ts hotWash),
// in numbers that come only from the engine, the fixtures and the measured wall-clock time of each
// decision (Choice.shownAt/decidedAt, stamped by useGuide). Pure; built by lane A.

import { clock, DEMO_TZ } from "../lib/time";
import { SECOND_LOOK_ID } from "./demoReview";
import { CHECKPOINTS, FLIGHT, poaOf, subjectOf } from "./missionTime";
import { LAWNMOWER_MS, manualLine, passesFrom, type Line, type Pass } from "./sim";
import { costsOf, groundedAtCall, PIPS, triageCards, type GuideInput, type HotWash } from "./guide";
import { storyProposal } from "./storyCopy";
import { TERMS } from "./terms";

// ---- without Sightline vs with Sightline: the published figures the manual line rests on ----

/** Seconds a volunteer takes per photo, reviewing by eye (Pyrrö, Naseri & Jung 2021, quoted in README.md and report §3.9). */
export const BY_EYE_S = 33;
/** The share of people volunteers find reviewing by eye (same source; SAR-APD scoring, not a matched study). */
export const BY_EYE_RECALL = 0.68;
/** Reviewers assumed on the photos without Sightline (the docs quote one volunteer's time). */
export const REVIEWERS = 1;
/** The survey flight's photos (the demo cache's survey.json: 500 frames; missionTime.ts FLIGHT). */
export const SURVEY_PHOTOS = 500;
/** The detector's time per photo on the deployed server: AWS c7i.2xlarge, OpenCV 5 `cv2.dnn` on CPU (report §4, 4.7 s). */
export const DETECTOR_S = 4.7;

const DOCS = "https://github.com/Drivera0/sightline/blob/main";

export interface Assumption {
  text: string;
  source: string;
  href: string;
}

/** One column of "Without Sightline vs with Sightline". */
export interface Column {
  key: "manual" | "you" | "agent";
  title: string;
  /** Mission minutes from the call to the find, or null: not found by last light. */
  findMin: number | null;
  /** A person's time on the photos (ms), or null: none counted (the AI's picks; Watch instead). */
  personMs: number | null;
  /** The detector's time on the photos (ms), or null: no detector. */
  machineMs: number | null;
  /** Photos a person had to look at. */
  photos: number;
  /** Of them, the ones answered in this run (yours), or null. */
  answered: number | null;
  /** Review photos with a person in them that reached nobody in time (a missed sighting). */
  missed: number;
  sectors: number;
  teamHours: number;
}

export interface WithWithout {
  /** Without Sightline, you with Sightline, and the AI's every pick only when it is not your search. */
  columns: Column[];
  headline: string;
  /** "You followed the AI's pick every time": the third column is hidden. */
  followedNote: string | null;
  assumptions: Assumption[];
  /** Why each column misses the photo sightings it misses. */
  missedNotes: string[];
  /** Why the minutes matter: the published finding on search time and survival, and this run's hours since last seen. */
  timeMatters: Assumption | null;
  manual: Line;
}

/**
 * Search time and survival (Adams, Schmidt, Newgard et al., "Search is a time-critical event: when search and
 * rescue missions may become futile", Wilderness Environ Med 2007;18(2):95-101, PMID 17590071): 2,302 Oregon
 * searches for 3,287 people (1997-2003); search time was the only variable the model kept, with a cut-point of
 * 51 hours, 98.9 % and 99.3 % sensitive in the two cohorts. No per-minute survival rate is published, so none
 * is shown.
 */
export const SURVIVAL_STUDY = {
  searches: 2302,
  people: 3287,
  cutHours: 51,
  source: "Adams et al. 2007, Wilderness & Environmental Medicine",
  href: "https://pubmed.ncbi.nlm.nih.gov/17590071/",
} as const;

/** The manual line's start: the first assignment's time, plus the lawnmower's minutes when a survey flies. */
export function manualStart(input: GuideInput): { start: number; flies: boolean } {
  const p = storyProposal(input.full);
  const flies = !!input.full?.data.fleet?.drones.length && !groundedAtCall(input.full);
  const at = p ? new Date(p.created_at).getTime() : new Date(CHECKPOINTS[3]!.at).getTime();
  return { start: at + (flies ? LAWNMOWER_MS : 0), flies };
}

const manualMemo = new WeakMap<object, Map<string, Line>>();

/**
 * The manual line for this run's scenario and seed (sim.ts manualLine over every team on the mission). It
 * depends on the scenario and the seed only, never on the visitor's choices, so it is worked out once.
 */
export function manualOf(input: GuideInput, lastLight: number): Line {
  const key = `${input.seed}|${lastLight}`;
  let memo = input.full ? manualMemo.get(input.full) : undefined;
  if (input.full && !memo) manualMemo.set(input.full, (memo = new Map()));
  const hit = memo?.get(key);
  if (hit) return hit;
  const teams = (input.full?.data.teams ?? []).filter((t) => t.status !== "off_duty").map((t) => t.id);
  const sectors = (input.full?.data.sectors ?? []).map((s) => s.sector_id);
  const line = manualLine(input.seed, subjectOf(input.full), sectors, teams, manualStart(input).start, lastLight);
  memo?.set(key, line);
  return line;
}

const hm = (msv: number) => fmtMin(msv / 60_000);
const local = (t: number) => clock(new Date(t).toISOString(), DEMO_TZ);

/**
 * Without Sightline vs with Sightline: the manual line (no detector, photos reviewed by eye, a hand split,
 * no map) against the visitor's search, from the same engine and seed, every assumption stated.
 */
export function withWithout(input: GuideInput, lastLight: number, you: SideStats, agent: SideStats, followedAll: boolean, manual: Line = manualOf(input, lastLight)): WithWithout {
  const call = ms(CHECKPOINTS[0]!.at);
  const { start, flies } = manualStart(input);
  const poa = poaOf(input.full);
  const m = sideStats(manual.passes, manual.found ?? lastLight, poa);
  const photos = flies ? SURVEY_PHOTOS : 0;
  const reviewMs = (photos * BY_EYE_S * 1000) / REVIEWERS;
  const reviewEnds = ms(FLIGHT.end) + (flies ? LAWNMOWER_MS : 0) + reviewMs;
  const manualEnd = manual.found ?? lastLight;

  // the review photos with a person in them (the AI's pick on each against this subject)
  const cards = triageCards(input.queue, input.full?.data.mission?.subject ?? null);
  const people = new Set(cards.filter((c) => c.line !== "not_person").map((c) => c.id));
  const tri = input.choices.filter((c) => c.inject === "triage");
  const youMissed = tri.filter((c) => c.card && people.has(c.card) && c.option === "not_person").length;
  const manualMissed = photos === 0 ? 0 : reviewEnds >= manualEnd ? people.size : Math.round(people.size * (1 - BY_EYE_RECALL));
  const mine = tri.filter((c) => !c.watched && c.shownAt !== undefined && c.decidedAt !== undefined);
  const youPerson = mine.length ? mine.reduce((n, c) => n + Math.max(0, c.decidedAt! - c.shownAt!), 0) : null;
  const queued = Math.max(input.queue.length, cards.length);
  const machineMs = photos ? photos * DETECTOR_S * 1000 : null;

  const columns: Column[] = [
    { key: "manual", title: "Without Sightline (manual)", findMin: manual.found !== null ? (manual.found - call) / 60_000 : null, personMs: reviewMs || null, machineMs: null, photos, answered: null, missed: manualMissed, sectors: m.sectors, teamHours: m.teamHours },
    { key: "you", title: "You, with Sightline", findMin: you.findMin, personMs: youPerson, machineMs, photos: queued, answered: tri.length, missed: youMissed, sectors: you.sectors, teamHours: you.teamHours },
  ];
  if (!followedAll) columns.push({ key: "agent", title: "Following the AI every time", findMin: agent.findMin, personMs: null, machineMs, photos: queued, answered: null, missed: 0, sectors: agent.sectors, teamHours: agent.teamHours });

  // the headline, in plain words, from the first two columns
  const [man, me] = columns as [Column, Column];
  const looked = photos ? `a person had ${queued} photos to look at instead of ${photos}` : "";
  const subject = subjectOf(input.full)?.sector;
  const rank = subject ? [...poa.entries()].sort((a, b) => b[1] - a[1]).findIndex(([s]) => s === subject) : -1;
  const low = rank >= poa.size / 2 ? `, a sector the map ranked ${rank + 1} of ${poa.size}` : "";
  let headline: string;
  if (me.findMin !== null && man.findMin !== null) {
    const d = Math.round(man.findMin - me.findMin);
    headline =
      d > 0
        ? `With Sightline the subject was found ${fmtMin(d)} sooner${looked ? `, and ${looked}` : ""}.`
        : d < 0
          ? `Without Sightline the subject was found ${fmtMin(-d)} sooner this time: the hand split reached ${subject ?? "the subject's sector"} early${low}.${looked ? ` With Sightline ${looked}.` : ""}`
          : `With and without Sightline the subject was found at the same mission minute${looked ? `, and with Sightline ${looked}` : ""}.`;
  } else if (me.findMin !== null) headline = `With Sightline the subject was found ${fmtMin(me.findMin)} after the call; without it, not found by last light${looked ? `, and ${looked}` : ""}.`;
  else if (man.findMin !== null) headline = `Without Sightline the subject was found ${fmtMin(man.findMin)} after the call; your search with Sightline had not found them by last light.`;
  else headline = `Neither search found the subject by last light${looked ? `; with Sightline ${looked}` : ""}.`;

  const report = `${DOCS}/docs/report/OPENCV_REPORT.md`;
  const site = `${report}#14-the-site-the-command-post-and-the-guided-simulation`;
  const assumptions: Assumption[] = [
    ...(flies
      ? [
          { text: `Survey: a ${TERMS.lawnmower}, ${LAWNMOWER_MS / 60_000} min longer than the AI's flight lines, as on the survey step.`, source: "the survey step", href: site },
          { text: `Photos reviewed by eye: ${BY_EYE_S} s a photo, ${REVIEWERS} reviewer, so ${photos} photos take ${hm(reviewMs)} and end at ${local(reviewEnds)}; by eye, about ${Math.round(BY_EYE_RECALL * 100)} % of people are found.`, source: "Pyrrö et al. 2021, report §3.9", href: `${report}#39-detector-accuracy-heridal-test-set-101-photos-337-people` },
          { text: `No detector and no ${TERMS.recheck}: a sighting reaches the search only when the reviewer gets to its photo.`, source: "README, the human reference", href: `${DOCS}/README.md` },
        ]
      : [{ text: "No survey: the drones stay on the ground, so neither search has photos.", source: "the conditions at the call", href: `${report}#7-conditions-tavily` }]),
    { text: "Teams: a fixed hand split, the grid row by row cut in one block per team, each block searched in order and then again; no map, so a pass that finds nothing changes no plan.", source: "the hand split, FLEET_V2", href: `${DOCS}/docs/report/FLEET_V2.md` },
    { text: `Teams go out at ${local(start)}, when Sightline's first assignment does${flies ? `, plus the survey's ${LAWNMOWER_MS / 60_000} min` : ""}; they do not wait for the photo review. The radio clue still comes in; a hand split does not change for it.`, source: "the same engine", href: site },
    { text: "The same engine and rolls as your search: POD 60 % a pass, a 6 min walk and a 10 min sweep, until last light.", source: "How POD is measured", href: `${DOCS}/docs/report/POD.md` },
    ...(flies ? [{ text: `With Sightline the detector takes ${DETECTOR_S} s a photo on the deployed server (AWS c7i.2xlarge, OpenCV 5 cv2.dnn on CPU), ${hm(photos * DETECTOR_S * 1000)} for ${photos}, as the photos land; a person's time is yours, measured on this device.`, source: "report §4, AWS deployment", href: `${report}#4-aws-deployment` }] : []),
  ];
  const relook = people.has(SECOND_LOOK_ID);
  const conf = input.queue.find((q) => q.id === SECOND_LOOK_ID)?.conf;
  const missedNotes = [
    photos ? (reviewEnds >= manualEnd ? `Without Sightline: the review by eye ends at ${local(reviewEnds)}, after ${manual.found !== null ? "the find" : "last light"}, so no photo sighting reaches a team in time.` : `Without Sightline: about ${Math.round((1 - BY_EYE_RECALL) * 100)} % of people are missed by eye.`) : "",
    relook ? `With Sightline: the ${conf !== undefined ? `${conf.toFixed(2)} ` : ""}photo, under the detector's 0.29 review line, is in the queue because the ${TERMS.recheck} flagged it.` : "",
  ].filter(Boolean);
  // why the minutes matter: the published finding, then this run's hours since the subject was last seen
  const seen = input.full?.data.mission?.last_seen_at ? ms(input.full.data.mission.last_seen_at) : null;
  const sinceSeen = (findMin: number | null) => (seen !== null && findMin !== null ? fmtMin((call + findMin * 60_000 - seen) / 60_000) : null);
  const study = `In ${SURVIVAL_STUDY.searches.toLocaleString("en-US")} Oregon searches for ${SURVIVAL_STUDY.people.toLocaleString("en-US")} people, search time was the only thing that predicted whether a person was found alive, and about 99 % of those found alive were found within ${SURVIVAL_STUDY.cutHours} hours of searching.`;
  const mineSeen = sinceSeen(me.findMin);
  const theirs = sinceSeen(man.findMin);
  const here =
    mineSeen && theirs && me.findMin !== null && man.findMin !== null && man.findMin > me.findMin
      ? ` Here the subject was found ${mineSeen} after they were last seen with Sightline, against ${theirs} without it.`
      : mineSeen && man.findMin === null
        ? ` Here the subject was found ${mineSeen} after they were last seen with Sightline; without it, the search went into the night.`
        : "";
  const timeMatters: Assumption | null = seen !== null ? { text: `Every hour counts. ${study}${here}`, source: SURVIVAL_STUDY.source, href: SURVIVAL_STUDY.href } : null;
  return { columns, headline, followedNote: followedAll ? "You followed the AI's pick every time, so your search is the AI's: one column for both." : null, assumptions, missedNotes, timeMatters, manual };
}

export interface SideStats {
  /** Mission minutes from the call to the find, or null: suspended at last light. */
  findMin: number | null;
  /** Distinct sectors a team finished a pass of (the finding pass included). */
  sectors: number;
  /** Team-hours on passes (walk and sweep) up to the find. */
  teamHours: number;
  /** Photo candidates triaged. */
  candidates: number;
  /** Decisions that went another way than the agent's pick. */
  differed: number;
  decisions: number;
  /** Share of the probability (the agent's map) searched without a find before the find, 0..1. */
  covered: number;
}

export interface DecisionTime {
  key: string;
  label: string;
  /** Wall-clock ms from shown to made. */
  ms: number;
  agent: boolean;
}

export interface DecisionRow {
  key: string;
  label: string;
  you: string;
  agent: string;
  same: boolean;
  /** Mission minutes the choice put on the clock (0: none). */
  costMin: number;
  /** Wall-clock ms it took, when measured. */
  thinkMs: number | null;
}

export interface Comparison {
  you: SideStats;
  agent: SideStats;
  /** The visitor's own decisions (not "Watch instead"), with their measured times. */
  times: DecisionTime[];
  totalMs: number;
  medianMs: number | null;
  /** Decisions "Watch instead" made for the visitor. */
  watched: number;
  rows: DecisionRow[];
  /** Every decision was the agent's pick: the two lines are one search. */
  followedAll: boolean;
  /** Minutes the visitor's find came after the agent's (negative: sooner), when both found. */
  deltaMin: number | null;
  verdict: string;
  /** Without Sightline vs with Sightline (the end screen leads with it). */
  sightline: WithWithout;
}

const ms = (iso: string) => new Date(iso).getTime();

export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** "2 min 14 s", "48 s", "1.6 s". */
export function fmtDuration(msv: number): string {
  const s = msv / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  const r = Math.round(s);
  if (r < 60) return `${r} s`;
  const m = Math.floor(r / 60);
  return `${m} min ${String(r % 60).padStart(2, "0")} s`;
}

export const fmtMin = (n: number) => (n < 60 ? `${Math.round(n)} min` : `${Math.floor(n / 60)} h ${String(Math.round(n % 60)).padStart(2, "0")} min`);

/**
 * One line's numbers from its passes, on the fixtures' clock: `until` is the find (or last light), and
 * `real` maps a fixture time to the mission clock (the visitor's costs stretch it; the agent's are zero).
 */
export function sideStats(passes: readonly Pass[], until: number, poa: ReadonlyMap<string, number>, real: (f: number) => number = (f) => f): Pick<SideStats, "sectors" | "teamHours" | "covered"> {
  const sectors = new Set<string>();
  let teamMs = 0;
  const miss = new Map<string, number>();
  for (const p of passes) {
    if (p.start >= until) continue;
    const end = Math.min(p.end, until);
    teamMs += real(end) - real(p.start);
    if (p.cut || p.end > until) continue;
    sectors.add(p.sector);
    if (!p.detected) miss.set(p.sector, 1 - (1 - (miss.get(p.sector) ?? 0)) * (1 - p.pod));
  }
  const total = [...poa.values()].reduce((n, x) => n + x, 0);
  const got = [...miss.entries()].reduce((n, [s, pod]) => n + (poa.get(s) ?? 0) * pod, 0);
  return {
    sectors: sectors.size,
    teamHours: teamMs / 3600_000,
    covered: total > 0 ? got / total : 0,
  };
}

/** The comparison, from the hot wash and the run's input. */
export function compare(input: GuideInput, wash: HotWash, lastLight: number, manual?: Line): Comparison {
  const { full, choices } = input;
  const call = ms(CHECKPOINTS[0]!.at);
  const costs = costsOf(choices);
  const real = (f: number) => f + costs.filter((c) => c.f < f).reduce((n, c) => n + c.ms, 0);
  const poa = poaOf(full);
  const subject = subjectOf(full);

  // the visitor's line: every pass, cut ones too (the team walked)
  const mine = passesFrom(input.seed, subject, input.user);
  const hit = mine.find((p) => p.detected && !p.cut);
  const youUntil = wash.outcome.foundAt !== null && hit ? hit.end : lastLight;
  const agentUntil = wash.agent.foundAt ?? lastLight;

  const tri = choices.filter((c) => c.inject === "triage");
  const triAgent = new Set(tri.map((c) => c.card)).size;
  const differed = choices.filter((c) => !c.agent).length;
  const you: SideStats = {
    findMin: wash.outcome.foundAt !== null ? (wash.outcome.foundAt - call) / 60_000 : null,
    ...sideStats(mine, youUntil, poa, real),
    candidates: tri.length,
    differed,
    decisions: choices.length,
  };
  const agent: SideStats = {
    findMin: wash.agent.foundAt !== null ? (wash.agent.foundAt - call) / 60_000 : null,
    ...sideStats(wash.agent.passes, agentUntil, poa),
    candidates: triAgent,
    differed: 0,
    decisions: choices.length,
  };

  const pip = (id: string) => PIPS.find((x) => x.id === id)?.label ?? id;
  const label = (c: (typeof choices)[number]) => (c.inject === "triage" ? pip("triage") : c.key.startsWith("assign-") ? `Assign ${c.key.slice(7)}` : pip(c.inject));
  const think = (c: (typeof choices)[number]) => (!c.watched && c.shownAt !== undefined && c.decidedAt !== undefined ? Math.max(0, c.decidedAt - c.shownAt) : null);
  const times: DecisionTime[] = choices.flatMap((c) => {
    const t = think(c);
    return t === null ? [] : [{ key: c.key, label: label(c), ms: t, agent: c.agent }];
  });
  const totalMs = times.reduce((n, t) => n + t.ms, 0);
  const rows: DecisionRow[] = choices.map((c) => ({
    key: c.key,
    label: label(c),
    you: c.label,
    // a photo's AI pick without the photo's name again (the row's own answer names it)
    agent: c.inject === "triage" ? c.agentLabel.replace(/^Photo \d+ \([^)]*\): /, "") : c.agentLabel,
    same: c.agent,
    costMin: c.costMs / 60_000,
    thinkMs: think(c),
  }));
  const followedAll = choices.length > 0 && differed === 0;
  const deltaMin = you.findMin !== null && agent.findMin !== null ? Math.round(you.findMin - agent.findMin) : null;

  let verdict: string;
  // (free play: the clock runs while an item waits, so the AI's picks approved later can find later)
  if (followedAll && deltaMin !== null && deltaMin > 0) verdict = `Every decision went the AI's way, but the clock ran on while they waited in Needs you: the AI's choices, approved the moment each landed, found the subject ${fmtMin(deltaMin)} sooner.`;
  else if (followedAll && deltaMin !== null && deltaMin < 0) verdict = `Every decision went the AI's way, and your search found the subject ${fmtMin(-deltaMin)} sooner than the AI's choices.`;
  else if (followedAll) verdict = "Every decision went the AI's way, so your search and the AI's choices are the same search.";
  else if (deltaMin !== null)
    verdict =
      deltaMin === 0
        ? `Your search and the AI's choices found the subject at the same mission minute, with ${differed} of your ${choices.length} decisions different from its picks.`
        : deltaMin < 0
          ? `Your search found the subject ${fmtMin(-deltaMin)} sooner than the AI's choices.`
          : `The AI's choices found the subject ${fmtMin(deltaMin)} sooner; ${differed} of your ${choices.length} decisions went another way.`;
  else if (you.findMin === null && agent.findMin !== null) verdict = "Your search suspended at last light; the AI's choices found the subject before it.";
  else if (you.findMin !== null && agent.findMin === null) verdict = "Your search found the subject; the AI's choices suspended at last light.";
  else verdict = "Neither line found the subject before last light.";

  return {
    you,
    agent,
    times,
    totalMs,
    medianMs: median(times.map((t) => t.ms)),
    watched: choices.filter((c) => c.watched).length,
    rows,
    followedAll,
    deltaMin,
    verdict,
    sightline: withWithout(input, lastLight, you, agent, followedAll, manual),
  };
}
