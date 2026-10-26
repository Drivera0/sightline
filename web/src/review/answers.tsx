// The image reviewer's answers (contract 15.7, `POST /reviews`): The subject, Another person (a person,
// not the missing one: the map counts the look as for Not a person), Not a person, and under More: A group,
// Object (a thing a lost person may have left or used: it becomes a clue candidate a team on the ground
// confirms, with its type) and Unsure. The review rail and the large review frame share them, their keys and the object type picker.
// Built by lane A.
import { useEffect } from "react";
import type { Verdict } from "../contract";
import { KeyHint } from "../shell/components";

export type LiveAnswer = "person" | "not_person" | "not_subject" | "group" | "object" | "unsure";
/**
 * What a reviewer can call an object: the contract's types plus clothing and gear (round 2: a SAR manager
 * looks for the subject's clothing and kit first). The server takes the contract's, so those two go as "other".
 */
export type ObjectKind = NonNullable<Verdict["object"]> | "clothing" | "water bottle / gear";
/** The contract's object type for a reviewer's (clothing and gear are "other" on the server). */
export const serverObject = (o: ObjectKind | null | undefined): NonNullable<Verdict["object"]> | undefined => (o === "clothing" || o === "water bottle / gear" ? "other" : (o ?? undefined));

/**
 * One fixed meaning per answer, on every photo (the cold test: the person answer meant a pin on one photo and a
 * team's walk on the next). The first three are the main buttons; `more` ones sit under a More toggle.
 */
export const REVIEW_ANSWERS: readonly { id: LiveAnswer; label: string; key: string; title: string; more?: boolean }[] = [
  { id: "person", label: "The subject", key: "P", title: "The missing person: a sighting pin on the map where the photo puts it" },
  { id: "not_subject", label: "Another person", key: "S", title: "A person, not the one missing: a witness lead to ask what they saw (the map counts the look as for Not a person)" },
  { id: "not_person", label: "Not a person", key: "N", title: "Not a person: it leaves the queue, and the map counts the look" },
  { id: "group", label: "A group (2+ people)", key: "G", title: "Two or more people together: a sighting pin and a witness lead, since the subject may be with them", more: true },
  { id: "object", label: "Object…", key: "O", title: "A thing the subject may have left or used: a clue candidate for a team to confirm on the ground", more: true },
  { id: "unsure", label: "Unsure", key: "U", title: "Can't tell: it stays flagged for a second reviewer", more: true },
];

/** What the server takes (contract 15.7 has no group): a group is people, so a person sighting. */
export const serverAnswer = (a: LiveAnswer): Exclude<LiveAnswer, "group"> => (a === "group" ? "person" : a);

/** The answer a review key gives (P, N, S, O, U), or null. */
export function answerForKey(key: string): LiveAnswer | null {
  return REVIEW_ANSWERS.find((a) => a.key.toLowerCase() === key.toLowerCase())?.id ?? null;
}

export const OBJECT_KINDS: readonly ObjectKind[] = ["backpack", "clothing", "water bottle / gear", "fire ring", "shelter", "other"];

/**
 * While the object picker is open, 1–6 pick a type and Esc closes it. The keys are taken in the capture phase
 * so the console's own 1–6 (the views) do not act on them.
 */
export function usePickerKeys(open: boolean, pick: (o: ObjectKind) => void, close: () => void): void {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const n = /^[1-6]$/.test(e.key) ? Number(e.key) : 0;
      if (n) pick(OBJECT_KINDS[n - 1]!);
      else if (e.key === "Escape") close();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  });
}

/** The object types, the second look's own guess marked; each picks and answers. */
export function ObjectPicker({ suggested, onPick, onCancel, large = false }: { suggested?: ObjectKind | null; onPick: (o: ObjectKind) => void; onCancel: () => void; large?: boolean }) {
  return (
    <div role="group" aria-label="Object type" className="sl-slide-in flex flex-wrap items-center gap-1.5 rounded-md border border-[color-mix(in_srgb,var(--clue)_45%,transparent)] bg-[color-mix(in_srgb,var(--clue)_6%,transparent)] p-1.5">
      <span className="px-1 text-caption text-text-2">What is it?</span>
      {OBJECT_KINDS.map((o, i) => (
        <button
          key={o}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPick(o);
          }}
          title={o === suggested ? "The second look's guess" : undefined}
          className={`sl-tap inline-flex items-center gap-1.5 rounded-full border px-2.5 text-text ${large ? "h-8 text-small" : "py-0.5 text-caption"} ${o === suggested ? "border-[var(--clue)]" : "border-border hover:bg-surface-strong"}`}
        >
          {o}
          {large && <KeyHint>{i + 1}</KeyHint>}
        </button>
      ))}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onCancel();
        }}
        className="sl-tap px-1.5 text-caption text-text-3 hover:text-text"
      >
        Cancel
      </button>
    </div>
  );
}
