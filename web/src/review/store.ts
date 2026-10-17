import { create } from "zustand";

export type Answer = "person" | "not_person" | "unsure";

export interface HistoryEntry {
  detectionId: string;
  answer: Answer;
  at: number;
}

const ANSWERS: readonly string[] = ["person", "not_person", "unsure"];
const storageKey = (surveyId: string) => `sightline.review.${surveyId}`;

/** The latest answer for each detection. */
export function answersOf(history: readonly HistoryEntry[]): Record<string, Answer> {
  const answers: Record<string, Answer> = {};
  for (const entry of history) answers[entry.detectionId] = entry.answer;
  return answers;
}

function isHistory(value: unknown): value is HistoryEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        typeof e.detectionId === "string" &&
        ANSWERS.includes(e.answer) &&
        typeof e.at === "number",
    )
  );
}

// localStorage can be missing, full or blocked (private windows, previews): the queue must still work.
function readSaved(surveyId: string): HistoryEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey(surveyId)) ?? "[]");
    return isHistory(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSaved(surveyId: string | null, history: HistoryEntry[]): void {
  if (surveyId === null) return;
  try {
    localStorage.setItem(storageKey(surveyId), JSON.stringify(history));
  } catch {
    /* works without it */
  }
}

interface ReviewState {
  surveyId: string | null;
  /** Every answer in the order it was given. The single source of truth for review state. */
  history: HistoryEntry[];
  /** Derived from `history`: the latest answer per detection. */
  answers: Record<string, Answer>;
  /** Start working on a survey: load what was saved for it. */
  bind: (surveyId: string) => void;
  answer: (detectionId: string, answer: Answer, at?: number) => void;
  undo: () => void;
  reset: () => void;
}

export const useReview = create<ReviewState>((set, get) => {
  const change = (history: HistoryEntry[]) => {
    writeSaved(get().surveyId, history);
    set({ history, answers: answersOf(history) });
  };
  return {
    surveyId: null,
    history: [],
    answers: {},
    bind: (surveyId) => {
      const history = readSaved(surveyId);
      set({ surveyId, history, answers: answersOf(history) });
    },
    answer: (detectionId, answer, at = Date.now()) => {
      change([...get().history, { detectionId, answer, at }]);
    },
    undo: () => {
      const { history } = get();
      if (history.length > 0) change(history.slice(0, -1));
    },
    reset: () => change([]),
  };
});
