// The AI's pick on a survey photo, against this scenario's subject (usability test round 2, problem 4):
// every scenario flies the same ground and lands the same photos (an adult in a red jacket, two people in
// red on a trail, a grey bag), so the pick and the reference answer come from comparing what a photo shows
// with the mission's subject description (age, colours, clothing), never from the detector score alone.
// Only the overdue hiker's red-jacket adult is "the subject"; in the missing child's search the same adult
// is another person, a witness to ask. Pure; built by lane A.

/** The review answers a pick can be (review/answers.tsx; guide.ts TriageAnswer). */
export type PickAnswer = "person" | "not_person" | "not_subject" | "group" | "object" | "unsure";

/** What a survey photo shows, as a reviewer would describe it. */
export interface PhotoSeen {
  people: number;
  /** Adult or child, as far as the air shows (null: cannot tell). */
  age: "adult" | "child" | null;
  /** The clothing's colours. */
  colours: string[];
  /** Dressed for the trail (a jacket, boots), not for indoors. */
  outdoor: boolean;
  /** In a few words: "an adult in a red jacket". */
  what: string;
}

/** The survey photos every scenario shares (the demo cache's review candidates and the AI re-check's catch). */
export const SURVEY_PHOTOS: Readonly<Record<string, PhotoSeen>> = {
  "f0336-d01": { people: 1, age: "adult", colours: ["red"], outdoor: true, what: "an adult in a red jacket" },
  "f0273-d02": { people: 2, age: null, colours: ["red"], outdoor: true, what: "two people in red on a trail" },
  "f0452-d01": { people: 0, age: null, colours: ["grey"], outdoor: false, what: "a grey bag" },
};

const COLOURS = ["red", "yellow", "blue", "green", "grey", "black", "white", "orange", "purple", "pink", "brown"] as const;
const WORD_AGE = /\b(\d{1,2})\b/;

/** The subject as the description gives it. */
export interface SubjectLook {
  age: "child" | "adult" | "older";
  years: number | null;
  colours: string[];
  /** The clothing named ("yellow raincoat", "slippers"), or null. */
  wear: string | null;
  /** Dressed for indoors (slippers, a dressing gown): walked away from a home. */
  indoor: boolean;
}

/** "child, 8, missing from a family picnic, yellow raincoat" → a child of 8 in yellow, a raincoat. */
export function subjectLook(text: string | null | undefined): SubjectLook {
  const s = (text ?? "").toLowerCase().replace(/\bgray\b/g, "grey");
  const n = WORD_AGE.exec(s);
  const years = n ? Number(n[1]) : null;
  const age = /\b(child|boy|girl|kid|toddler)\b/.test(s) || (years !== null && years < 13) ? "child" : /\b(older|elderly|dementia)\b/.test(s) || (years !== null && years >= 65) ? "older" : "adult";
  const colours = COLOURS.filter((c) => new RegExp(`\\b${c}\\b`).test(s));
  const parts = s.split(",").map((x) => x.trim());
  const wear = parts.find((p) => colours.some((c) => p.includes(c))) ?? parts.find((p) => /slipper|gown|coat|jacket|raincoat|cardigan|hood/.test(p)) ?? null;
  return { age, years, colours, wear, indoor: /slipper|dressing gown|pyjama|nightgown/.test(s) };
}

/** "a child of 8 in a yellow raincoat", "an older adult in slippers": the subject in a few words. */
export function subjectWords(l: SubjectLook): string {
  const who = l.age === "child" ? (l.years ? `a child of ${l.years}` : "a child") : l.age === "older" ? "an older adult" : "an adult";
  if (!l.wear) return who;
  const wear = l.wear.replace(/^(wearing|in)\s+/, "");
  return `${who} in ${/s$/.test(wear) || /^(a|an|the)\b/.test(wear) ? wear : `a ${wear}`}`;
}

export interface Pick {
  answer: PickAnswer;
  /** One line, for the review card and Needs you: "AI: likely the subject — red jacket matches". */
  line: string;
}

/**
 * The AI's pick on a photo for this subject, or null for a photo it has no description of. The rules,
 * in order: no person is not a person; a child against an adult is another person; colours that are not
 * the subject's are another person; trail clothes against a subject who walked away in slippers are
 * another person; else the subject (one person) or the subject maybe among them (two people, the overdue
 * hiker's AI re-check catch keeps "the subject": its colour matches and the re-check says a person).
 */
export function aiPick(photoId: string, subject: string | null | undefined): Pick | null {
  const p = SURVEY_PHOTOS[photoId];
  if (!p) return null;
  const l = subjectLook(subject);
  const them = subjectWords(l);
  const other = p.people > 1 ? "other people" : "another person";
  if (p.people === 0) return { answer: "not_person", line: `AI: not a person — ${p.what}` };
  if (l.age === "child" && p.age === "adult") return { answer: "not_subject", line: `AI: ${other} — ${p.what}; the subject is ${them}` };
  if (l.colours.length && p.colours.length && !p.colours.some((c) => l.colours.includes(c))) return { answer: "not_subject", line: `AI: ${other} — ${p.what}; the subject is ${them}` };
  if (l.indoor && p.outdoor) return { answer: "not_subject", line: `AI: ${other} — ${p.what}, dressed for the trail; the subject is ${them}` };
  const match = l.colours.filter((c) => p.colours.includes(c));
  const why = match.length ? `${match.join(" and ")} ${l.wear && /jacket|coat|raincoat/.test(l.wear) ? (l.wear.match(/jacket|raincoat|coat/)?.[0] ?? "clothing") : "clothing"} matches` : "nothing in the photo rules them out";
  return { answer: "person", line: p.people > 1 ? `AI: likely the subject — ${why}; someone is with them` : `AI: likely the subject — ${why}` };
}
