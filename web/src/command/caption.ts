// The time-lapse's caption (the owner, 2026-10-26: "I don't understand what's being given to us"): one plain
// line per beat (story.ts `lapseBeats`) saying what happened and what it means for the search, in the words a
// search manager uses. Built only from the beat's own rows: their words, teams, sectors and counts; nothing
// is added that the rows do not say (no invented numbers). Pure. Built by lane A.

import type { Beat, LapseRow } from "./story";

const WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
/** "T2" → "Team Two"; a name stays a name. */
const teamName = (id: string) => (/^T\d$/.test(id) ? `Team ${WORDS[Number(id.slice(1))]}` : id);
/** "B3, C3 and B2". */
export function listOf(xs: readonly string[]): string {
  if (xs.length <= 1) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const uniq = (xs: readonly (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];
/** The callsign a row speaks for: "Sightline, Team Two. …", "Team Two: …", "(Team Two)", else its team id. */
function who(r: LapseRow): string | null {
  const m = /^Sightline, (Team \w+)\./.exec(r.text) ?? /^(Team \w+)\b/.exec(r.text) ?? /\((Team \w+)\)/.exec(r.text);
  return m?.[1] ?? (r.team ? teamName(r.team) : null);
}
const teamsIn = (rows: readonly LapseRow[]) => uniq(rows.map(who));
/** A sector a row names: its own field, else "B3" or "Bravo Three" in the words. */
function sectorOf(r: LapseRow): string | null {
  if (r.sector) return r.sector;
  const m = /\b(Alpha|Bravo|Charlie|Delta) (One|Two|Three|Four|Five|Six)\b/.exec(r.text);
  if (m) return `${m[1]![0]}${WORDS.indexOf(m[2]!)}`;
  return /\b([A-D]\d)\b/.exec(r.text)?.[1] ?? null;
}
/** The words after "kind: " in a clue row ("object: blue water bottle" → "blue water bottle"). */
const clueWords = (t: string) => t.replace(/^[A-Za-z]+: /, "").replace(/\s*\(photo review\)$/, "");

/** What a clue's state means for the map, from the row's own second line. */
function clueMeaning(detail: string | null | undefined): string {
  if (!detail) return "a confirmed clue moves the map toward where it points.";
  if (/awaiting read-back/.test(detail)) return "it waits for your confirmation before it moves the map.";
  if (/logged without mapping/.test(detail)) return "it is logged; the map stays as it was.";
  if (/confirmed/.test(detail)) return "the map now leans toward where it points.";
  if (/not confirmed|candidate/.test(detail)) return "it waits for a team to see it before it moves the map.";
  return "a confirmed clue moves the map toward where it points.";
}

const is = {
  found: (r: LapseRow) => r.kind === "found" || /Subject located/i.test(r.text),
  clue: (r: LapseRow) => r.kind === "clue",
  pass: (r: LapseRow) => /searched, no sign|searched at POD/.test(r.text),
  standing: (r: LapseRow) => r.kind === "decision" && /auto-approved/.test(r.text) && /assigned to/.test(r.text),
  suggest: (r: LapseRow) => /^AI suggests/.test(r.text),
  recheck: (r: LapseRow) => /re-check of a near-miss photo/.test(r.text),
  review: (r: LapseRow) => /^Photo review:/.test(r.text),
  toReview: (r: LapseRow) => /photo to review/i.test(r.text) && !/^AI suggests/.test(r.text),
  lines: (r: LapseRow) => r.kind === "drone" && /flight line approved/.test(r.text),
  lineStart: (r: LapseRow) => r.kind === "drone" && /flight line over \w+ started/.test(r.text),
  lineDone: (r: LapseRow) => r.kind === "drone" && /flight line over \w+ done/.test(r.text),
  droneBack: (r: LapseRow) => r.kind === "drone" && /back at base camp/.test(r.text),
  linkLost: (r: LapseRow) => /link lost/.test(r.text),
  linkWeak: (r: LapseRow) => /link degraded/.test(r.text),
  survey: (r: LapseRow) => /^Survey photos:/.test(r.text),
  headsBack: (r: LapseRow) => /heads back to base camp/.test(r.text),
  atBase: (r: LapseRow) => r.kind !== "drone" && /back at base camp/.test(r.text),
  hasty: (r: LapseRow) => /out on a hasty search/.test(r.text),
  position: (r: LapseRow) => /position report/.test(r.text),
  started: (r: LapseRow) => / started [A-Z]\d\b/.test(r.text) && r.kind === "checkin",
  conditions: (r: LapseRow) => /^Conditions looked up/.test(r.text),
  decided: (r: LapseRow) => /the AI's suggestion:/.test(r.text),
};
const droneOf = (r: LapseRow) => /^Drone \d+/.exec(r.text)?.[0] ?? null;

/** Whose standing approval sent the teams on, in the row's own words. */
function standingWhose(rows: readonly LapseRow[]): string {
  const t = rows.find(is.standing)?.text ?? "";
  if (/Watch instead/.test(t)) return "Watch instead's Send all";
  if (/last light/.test(t)) return "The night search";
  return "Your Send all";
}

/** Passes with no find, and the teams sent on after them. */
function passesLine(rows: readonly LapseRow[]): string {
  const passes = rows.filter(is.pass);
  const next = rows.filter(is.standing);
  const out: string[] = [];
  if (passes.length) {
    const teams = teamsIn(passes);
    const sectors = uniq(passes.map(sectorOf));
    const whom = teams.length === 1 ? teams[0]! : plural(teams.length || passes.length, "team");
    const where = sectors.length ? listOf(sectors) : "its sector";
    out.push(`${whom} searched ${where} with no sign of the subject: the map lowers ${sectors.length === 1 ? "that sector" : "those sectors"} and the others rise.`);
  }
  if (next.length) {
    const sectors = uniq(next.map(sectorOf));
    const n = uniq(next.map((r) => r.team ?? who(r))).length || next.length;
    out.push(`${standingWhose(rows)} sends ${n === 1 ? "the team" : `the ${n} teams`} on to the AI's next pick${sectors.length === 1 ? "" : "s"}${sectors.length ? `: ${listOf(sectors)}` : ""}.`);
  }
  return out.join(" ");
}

/** The AI re-checking photos, photos for review and a reviewer's answers. */
function photosLine(rows: readonly LapseRow[]): string {
  const re = rows.filter(is.recheck);
  const likely = re.filter((r) => /likely a person/.test(r.text)).length;
  const not = re.filter((r) => /probably not a person/.test(r.text)).length;
  const unsure = re.length - likely - not;
  const fresh = rows.filter(is.toReview).length;
  const clue = rows.find((r) => r.kind === "clue");
  const out: string[] = [];
  if (re.length === 1) {
    const what = likely ? "likely a person: it goes to Review photos for you to answer." : not ? "probably not a person." : "unclear.";
    out.push(`The AI re-checked a photo the detector nearly missed: ${what}`);
  } else if (re.length) {
    out.push(
      likely
        ? `The AI re-checked ${re.length} photos the detector nearly missed: ${likely} likely ${likely === 1 ? "shows" : "show"} a person and ${likely === 1 ? "goes" : "go"} to Review photos for you to answer.`
        : `The AI re-checked ${re.length} photos the detector nearly missed: ${not === re.length ? "probably no person in any of them" : `${not} probably not a person, ${unsure} unclear`}.`,
    );
  }
  if (fresh && !likely) out.push(`${plural(fresh, "photo")} ${fresh === 1 ? "needs" : "need"} a person's eye before the map trusts ${fresh === 1 ? "it" : "them"}.`);
  if (clue) out.push(`A photo review turned up a possible clue: “${clueWords(clue.text)}”.`);
  if (!likely) out.push("Only a person's answer on a photo pins a sighting on the map.");
  return out.join(" ");
}

/**
 * The caption for one beat: what happened, then what it means for the search. Read from the beat's rows
 * only (story.ts lapseBeats keeps them); falls back to the beat's own line.
 */
export function beatCaption(beat: Pick<Beat, "rows" | "text" | "count">): string {
  const rows = beat.rows.length ? beat.rows : [{ at: 0, text: beat.text }];
  const has = (f: (r: LapseRow) => boolean) => rows.some(f);
  const first = (f: (r: LapseRow) => boolean) => rows.find(f);

  const found = first(is.found);
  if (found) {
    const t = who(found);
    const s = sectorOf(found);
    return `${t ?? "A team"} reports the subject found${s ? ` in ${s}` : ""}: record the find in Needs you to close the search.`;
  }
  if (has(is.pass) || has(is.standing)) return passesLine(rows);
  if (has(is.recheck) || has(is.review) || has(is.toReview)) return photosLine(rows);
  const clue = first(is.clue);
  if (clue) {
    const t = who(clue) ?? teamsIn(rows.filter((r) => r.kind === "radio"))[0] ?? null;
    const how = rows.some((r) => r.kind === "radio") ? " by radio" : "";
    return `${t ? `${t} reports` : "A new clue"}${how}: “${clueWords(clue.text)}”. On the board as a clue; ${clueMeaning(clue.detail)}`;
  }
  const suggest = rows.filter(is.suggest);
  if (suggest.length) {
    const what = suggest[0]!.text.replace(/^AI suggests: /, "");
    return suggest.length > 1
      ? `The AI has ${suggest.length} suggestions, the first: ${what}. Each waits in Needs you until you decide.`
      : `The AI suggests: ${what}. It waits in Needs you until you decide.`;
  }
  if (has(is.lines) || has(is.lineStart)) {
    const drones = uniq(rows.filter((r) => is.lines(r) || is.lineStart(r)).map(droneOf));
    const sectors = uniq(rows.filter(is.lineStart).map(sectorOf));
    return `${drones.length === 1 ? drones[0] : `${drones.length} drones`} ${drones.length === 1 ? "takes" : "take"} off on ${drones.length === 1 ? "its flight line" : "their flight lines"}${sectors.length ? ` over ${listOf(sectors)}` : ""}: photos land for review as ${drones.length === 1 ? "it flies" : "they fly"}, and ground the camera sees lowers on the map.`;
  }
  const lost = first(is.linkLost);
  if (lost) return `${droneOf(lost) ?? "A drone"} lost its radio link: it keeps flying its approved flight line, and its photos arrive only when the link comes back.`;
  if (has(is.lineDone) || has(is.droneBack)) {
    const ds = uniq(rows.filter((r) => is.lineDone(r) || is.droneBack(r)).map(droneOf));
    const one = ds.length <= 1;
    const d = one ? (ds[0] ?? "The drone") : `${listOf(ds.map((x, i) => (i ? x.replace("Drone ", "") : x.replace("Drone ", "Drones "))))}`;
    const s = uniq(rows.filter(is.lineDone).map(sectorOf));
    const line = `${one ? "its flight line" : "their flight lines"}${s.length ? ` over ${listOf(s)}` : ""}`;
    const weak = has(is.linkWeak) ? ` ${droneOf(rows.find(is.linkWeak)!) ?? "A drone"}'s link is weak: telemetry and photos arrive late.` : "";
    return has(is.droneBack)
      ? `${d} finished ${line} and ${one ? "is" : "are"} back at base camp: a battery swap, then ${one ? "it" : "they"} can fly again.${weak}`
      : `${d} finished ${line}: what ${one ? "it" : "they"} photographed is in.${weak}`;
  }
  const weak = first(is.linkWeak);
  if (weak) return `${droneOf(weak) ?? "A drone"}'s link is weak: its telemetry and photos arrive late.`;
  const survey = first(is.survey);
  if (survey) return /ends/.test(survey.text) ? "The survey flight is over: all its photos are in and ranked, the likeliest first." : "The survey flight is up: its photos land and are ranked as it flies.";
  const hasty = rows.filter(is.hasty);
  if (hasty.length) {
    const t = teamsIn(hasty);
    return `${listOf(t)} ${t.length === 1 ? "is" : "are"} out on a hasty search along the trail, set before you took over: a fast first look along the trail.`;
  }
  const headsBack = rows.filter(is.headsBack);
  if (headsBack.length) {
    const t = teamsIn(headsBack);
    return `${listOf(t)} ${t.length === 1 ? "heads" : "head"} back to base camp, the hasty search done: free for a sector once ${t.length === 1 ? "it is" : "they are"} back.`;
  }
  const atBase = rows.filter(is.atBase);
  if (atBase.length) {
    const t = teamsIn(atBase);
    return `${listOf(t)} ${t.length === 1 ? "is" : "are"} back at base camp: free to send to a sector.`;
  }
  const pos = rows.filter(is.position);
  if (pos.length) {
    const t = teamsIn(pos);
    return `${listOf(t)} checked in by radio with ${t.length === 1 ? "a position report" : "position reports"}: ${t.length === 1 ? "its" : "each one's"} radio check-in clock starts again.`;
  }
  const started = first(is.started);
  if (started) return `${who(started) ?? "A team"} reached ${sectorOf(started) ?? "its sector"} and is searching it.`;
  if (has(is.conditions)) return "Weather and daylight looked up for the area: they set when the drones can fly and how long the light lasts.";
  const decided = first(is.decided);
  if (decided) return `${decided.text}. It is on the log.`;
  const radio = rows.filter((r) => r.kind === "radio");
  if (radio.length) {
    const inbound = radio.find((r) => /^Sightline, /.test(r.text));
    if (inbound) return `${who(inbound) ?? "A team"} on the radio: “${inbound.text.replace(/^Sightline, Team \w+\. /, "").replace(/, over\.$/, "")}”.`;
  }
  return beat.count > 1 ? beat.text : rows[0]!.text;
}
