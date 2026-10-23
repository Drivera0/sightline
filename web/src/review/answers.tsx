// The image reviewer's answers (contract 15.7, `POST /reviews`): Person, Not a person, Not the subject (a
// person, not the missing one: the map counts the look as for Not a person), Object (a thing a lost person
// may have left or used: it becomes a clue candidate a team on the ground confirms, with its type) and
// Unsure. The review rail and the large review frame share them, their keys and the object type picker.
// Built by lane A.
import { useEffect } from "react";
import type { Verdict } from "../contract";
import { KeyHint } from "../shell/components";

export type LiveAnswer = "person" | "not_person" | "not_subject" | "object" | "unsure";
export type ObjectKind = NonNullable<Verdict["object"]>;

export const REVIEW_ANSWERS: readonly { id: LiveAnswer; label: string; key: string; title: string }[] = [
  { id: "person", label: "Person", key: "P", title: "A person: a sighting pin on the map" },
  { id: "not_person", label: "Not a person", key: "N", title: "Not a person: the map counts the look" },
  { id: "not_subject", label: "Not the subject", key: "S", title: "A person, but not the one missing (another hiker): the map counts the look as for Not a person" },
  { id: "object", label: "Object", key: "O", title: "A thing the subject may have left or used: a clue candidate for a team to confirm on the ground" },
  { id: "unsure", label: "Unsure", key: "U", title: "Can't tell: the area stays held until someone answers" },
];

/** The answer a review key gives (P, N, S, O, U), or null. */
export function answerForKey(key: string): LiveAnswer | null {
  return REVIEW_ANSWERS.find((a) => a.key.toLowerCase() === key.toLowerCase())?.id ?? null;
}

export const OBJECT_KINDS: readonly ObjectKind[] = ["backpack", "fire ring", "shelter", "other"];

/**
 * While the object picker is open, 1–4 pick a type and Esc closes it. The keys are taken in the capture phase
 * so the console's own 1–6 (the views) do not act on them.
 */
export function usePickerKeys(open: boolean, pick: (o: ObjectKind) => void, close: () => void): void {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const n = /^[1-4]$/.test(e.key) ? Number(e.key) : 0;
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
