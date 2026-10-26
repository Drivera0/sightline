// The console's one vocabulary (usability test 2026-10-25, "Terms a SAR manager wouldn't know"): plain
// words first, the SAR term beside it where SAR people use it (POA, POD, LKP, ROW), each explained once by
// a tooltip. Every manager-facing string takes its words from here, and `plainWords` rewrites the lines the
// fixtures and the simulation carry (legs, second looks, internal ids) at render time. The Trace keeps the
// ids and the engine's own words. Pure. Built by lane A.

/** The words, once. */
export const TERMS = {
  /** The probability outside the grid (the rest of the world). */
  row: "Rest of world (ROW)",
  rowTip: "Rest of world (ROW): the chance the subject is outside the search grid. The sectors hold the rest; together they make 100 %.",
  poaTip: "POA (probability of area): the chance the subject is in this sector.",
  podTip: "POD (probability of detection): the chance a search of the sector would have found the subject if they were there.",
  /** The step where a person answers the detector's photos, and one of its items. */
  review: "Review photos",
  reviewItem: "photo to review",
  reviewItems: "photos to review",
  /** The AI's second pass on a near miss (OpenCV 5 zoom, then a vision model). */
  recheck: "AI re-check",
  recheckRun: "Run AI re-check",
  recheckFlagged: "flagged by the AI re-check",
  /** A drone's planned pass over a sector (a "leg" in the engine). */
  flightLine: "flight line",
  flightLines: "flight lines",
  lawnmower: "lawnmower pattern over the whole grid",
  sentElsewhere: "sent elsewhere",
  commandPost: "logged at the command post",
  aiSuggests: "AI suggests",
  aiChoices: "the AI's choices",
} as const;

/** "photos scoring under 0.29 normally skip review": the review threshold, said once where it matters. */
export const thresholdNote = (t: number) => `photos scoring under ${t.toFixed(2)} normally skip review`;

/** "1 photo to review", "3 photos to review". */
export const toReview = (n: number) => `${n} ${n === 1 ? TERMS.reviewItem : TERMS.reviewItems}`;

/** POD always as a percentage: 0.6 or 60 → "60 %". */
export function formatPod(v: number): string {
  const pct = v <= 1 ? v * 100 : v;
  return `${Math.round(pct)} %`;
}

/** "POD 60 %". */
export const podLabel = (v: number) => `POD ${formatPod(v)}`;

const WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
/** "T2" → "Team Two" (the console's callsigns). */
const teamName = (n: string) => `Team ${WORDS[Number(n)] ?? n}`;

/** A leg's place among its drone's legs, for "Drone 1 · flight line 2". */
export interface LegLike {
  id: string;
  drone_id: string;
}

/** Each leg id → "Drone 1 · flight line 1", numbered per drone in the order the fleet lists them. */
export function flightLineNames(legs: readonly LegLike[] | null | undefined, droneName: (id: string) => string = (id) => id): Map<string, string> {
  const out = new Map<string, string>();
  const n = new Map<string, number>();
  for (const l of legs ?? []) {
    const k = (n.get(l.drone_id) ?? 0) + 1;
    n.set(l.drone_id, k);
    out.set(l.id, `${droneName(l.drone_id)} · ${TERMS.flightLine} ${k}`);
  }
  return out;
}

export interface PlainCtx {
  /** Leg id → "Drone 1 · flight line 1" (flightLineNames); without it a leg is "a flight line". */
  legs?: ReadonlyMap<string, string>;
}

/**
 * A fixture's or the simulation's line in the console's words: legs are flight lines, a second look is the
 * AI re-check, POD is a percentage, and the internal ids (f0336-d01, c001, p002, s-…, L001) are gone. The
 * Trace shows the lines as they are.
 */
export function plainWords(text: string, ctx: PlainCtx = {}): string {
  const leg = (id: string) => ctx.legs?.get(id) ?? null;
  let s = text;
  // the mission's first line: its name, never "(demo)" (the header's chip says what kind of search this is)
  s = s.replace(/^mission created: (.+?) \(demo\)$/, "Mission opened: $1");
  // the scenario's prior, said plainly (the model and its citations stay in the Trace)
  s = s.replace(/^Demo scenario: ([^(;]+?) \(seed \d+\);.*\bprior$/, (_, name: string) => `Search area drawn from how ${priorWho(name)} usually travel (ISRID)`);
  // the scenario's scripted decisions are the search manager's
  s = s.replace(/the scenario's search manager/g, "the search manager").replace(/The scenario's search manager/g, "The search manager");
  // the visitor is the console's "Search manager": "you", so the scenario's decisions stay apart from theirs
  s = s.replace(/\(by Search manager\)/g, "(by you)").replace(/^Search manager approved\b/, "You approved").replace(/^Search manager rejected\b/, "You rejected");
  // drone legs
  s = s.replace(/^(Drone \d+): leg (L\d+) \(sector ([A-Z]\d+)\) (started|done)/, (_, d: string, id: string, sec: string, what: string) => `${leg(id) ?? `${d} · ${TERMS.flightLine}`} over ${sec} ${what}`);
  s = s.replace(/^(L\d+) approved for (Drone \d+) \(re-task: (L\d+) cancelled\)/, (_, id: string, d: string, old: string) => `${leg(id) ?? `${d}: new ${TERMS.flightLine}`} approved (${TERMS.sentElsewhere}: ${leg(old) ?? `its earlier ${TERMS.flightLine}`} cancelled)`);
  s = s.replace(/^(L\d+) approved for (Drone \d+)/, (_, id: string, d: string) => `${leg(id) ?? `${d}: ${TERMS.flightLine}`} approved`);
  s = s.replace(/\b(L\d{3})\b/g, (m: string) => leg(m) ?? `a ${TERMS.flightLine}`);
  s = s.replace(/\bOpening leg\b/g, `Opening ${TERMS.flightLine}`);
  s = s.replace(/^Re-task (Drone \d+) to /, "Send $1 elsewhere, to ").replace(/\bre-task(?:ed)?\b/g, TERMS.sentElsewhere);
  // only a drone's leg (never a person's: "a cut on his leg" stays as it is)
  s = s.replace(/\b([Dd]rone|approved|its|own|survey|planner's) legs\b/g, `$1 ${TERMS.flightLines}`).replace(/\b([Dd]rone|approved|its|own|survey|current) leg\b/g, `$1 ${TERMS.flightLine}`);
  // drones and teams by their short ids at the start of a line, or relayed via one
  s = s.replace(/^D(\d+) link/, "Drone $1 link").replace(/\bvia D(\d+)\b/g, "via Drone $1");
  s = s.replace(/^T(\d) /, (_, n: string) => `${teamName(n)} `);
  // the AI re-check (the engine's "second look")
  s = s.replace(/^[Ss]econd look on \S+: (yes|no|unclear)$/, (_, v: string) => `${TERMS.recheck} of a near-miss photo: ${v === "yes" ? "likely a person" : v === "no" ? "probably not a person" : "unclear"}`);
  s = s.replace(/the second look \(zoom_native\)/g, `the ${TERMS.recheck}`);
  s = s.replace(/\bAI second looks?\b/g, TERMS.recheck).replace(/\b[Ss]econd look says\b/g, `the ${TERMS.recheck} says`).replace(/\bthe second look\b/g, `the ${TERMS.recheck}`).replace(/\b[Ss]econd look\b/g, TERMS.recheck);
  s = s.replace(/Detector confidence (\d\.\d\d) is below the review threshold (\d\.\d\d)/g, (_, c: string, t: string) => `Detector score ${c}, under ${t} (${thresholdNote(Number(t))})`);
  s = s.replace(/\bthe review queue\b/g, TERMS.review).replace(/\breview queue\b/g, TERMS.review);
  s = s.replace(/^review \S+: /, "Photo review: ");
  s = s.replace(/\bcandidate f\d{4}-d\d{2} \((\d\.\d\d)\)/g, `${TERMS.reviewItem} (score $1)`);
  s = s.replace(/\bclue candidate c\d+\b/g, "a possible clue");
  s = s.replace(/\bby the image reviewer\b/g, "in Review photos").replace(/\(image review\)/g, "(photo review)");
  // decisions on the AI's suggestions
  s = s.replace(/\bapproved agent p\d+:/g, "approved the AI's suggestion:").replace(/\brejected agent p\d+:/g, "rejected the AI's suggestion:");
  s = s.replace(/^p\d+ approved by /, "Approved by ");
  s = s.replace(/^Agent proposes:/, `${TERMS.aiSuggests}:`);
  s = s.replace(/\bthe agent's pick\b/g, "the AI's pick");
  // clues
  s = s.replace(/^Clue c\d+ \(([^)]*)\) confirmed from radio turn r\d+/, "Clue confirmed from the radio call: $1");
  s = s.replace(/\bc\d{3,}\b \(([^)]*)\)/g, "“$1”");
  s = s.replace(/\bentered at command(?: · entered at command)?\b/g, TERMS.commandPost);
  // POD as a percentage
  s = s.replace(/\bPOD (0?\.\d+|1\.0+)\b/g, (_, v: string) => `POD ${formatPod(Number(v))}`).replace(/\bPOD (\d+)%/g, "POD $1 %");
  // the ids that are left: photos and detections
  s = s.replace(/\bin (f\d{4}) \(f\d{4}-d\d{2}, detector (\d\.\d\d)\)/g, "in a survey photo (score $2)");
  s = s.replace(/\b([Pp]hoto) f0*(\d+)\b/g, "$1 $2");
  s = s.replace(/\b(?:Put|Add) f\d{4}-d\d{2} (?:in|to) /g, (m: string) => `${m.startsWith("Put") ? "Put" : "Add"} this photo ${m.includes(" in ") ? "in" : "to"} `);
  s = s.replace(/\bs-f\d{4}-d\d{2}\b/g, "").replace(/\bf\d{4}-d\d{2}\b/g, "the photo").replace(/\bf\d{4}\b/g, "a photo");
  return s.replace(/\s{2,}/g, " ").replace(/^\s*·\s*/, "").trim();
}

/** Who a scenario's prior is about: "Missing child" → "lost children". */
function priorWho(name: string): string {
  if (/child/i.test(name)) return "lost children";
  if (/despondent/i.test(name)) return "despondent people";
  if (/dementia/i.test(name)) return "people with dementia";
  if (/hiker/i.test(name)) return "lost hikers";
  return "lost people";
}

/** The words a manager-facing console may not show (noJargon.test.tsx scans the rendered console for them). */
export const BANNED = [
  /\btriage\b/i,
  /\blegs?\b/i,
  /\bsecond look\b/i,
  /\bf\d{4}-d\d{2}\b/,
  /\bserpentine\b/i,
  /\bre-task/i,
  /\bpromoted\b/i,
  // usability test round 2's leftovers
  /\bSurvey photo f\d{4}\b/,
  /\bevery draw\b/i,
  /\bAgent's line\b/i,
  /\bline \d+ of \d+\b/,
  /\bno quote in the trace\b/i,
  /\(seed \d+\)/,
  /\bterrain affinity\b/i,
  /\bBase camp: Base camp\b/i,
  /\bAI suggests: Detector score\b/i,
] as const;
