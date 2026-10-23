// The console's notification centre (V3 §2 Feedback): every change the search manager should see comes
// in as a toast (bottom right, 5 s, stacking, with "Show me") and is kept in a short log behind the bell
// in the status line, with an unread count. Toasts with the same key merge ("3 candidates to review",
// "Team Two: … ×2") instead of piling up. The store only holds them; command/notifications.ts says which
// mission event becomes which toast, and command/showMe.ts what "Show me" does. Built by lane A.
import { create } from "zustand";

/** What a toast is about: one semantic colour each (theme.css, the v3 colour block). */
export type NoteTone = "team" | "drone" | "clue" | "proposal" | "found" | "alert" | "review" | "note";

/** Where "Show me" goes. */
export type ShowTarget =
  | { kind: "proposal"; id: string }
  | { kind: "candidate"; id: string | null }
  | { kind: "clue"; id: string }
  | { kind: "team"; id: string }
  | { kind: "radio"; id: string | null }
  | { kind: "sector"; id: string }
  | { kind: "found" }
  /** Open the Add clue form (at a point, when one was picked on the map). */
  | { kind: "addClue"; at?: { lat: number; lon: number } | null };

export interface NoteDraft {
  /** Toasts with one key merge: the newest text, a count. */
  key: string;
  tone: NoteTone;
  title: string;
  body?: string | null;
  target?: ShowTarget | null;
  /** The action's label ("Show me" unless said). */
  action?: string;
}

export interface Note extends NoteDraft {
  id: number;
  /** How many times it came (merged). */
  count: number;
  /** When it last came (ms, performance-free wall clock). */
  at: number;
  read: boolean;
}

/** How long a toast stays (ms), unless the pointer is on it. */
export const TOAST_MS = 5000;
/** The most toasts on screen at once; older ones leave for the log. */
export const TOAST_MAX = 4;
/** The log behind the bell keeps this many. */
export const LOG_MAX = 30;

interface NotifyState {
  toasts: Note[];
  log: Note[];
  push: (d: NoteDraft, now?: number) => Note;
  dismiss: (id: number) => void;
  markRead: () => void;
  reset: () => void;
}

let seq = 0;

export const useNotify = create<NotifyState>((set, get) => ({
  toasts: [],
  log: [],
  push: (d, now = Date.now()) => {
    const { toasts, log } = get();
    const open = toasts.find((t) => t.key === d.key);
    const note: Note = open
      ? { ...open, ...d, count: open.count + 1, at: now, read: false }
      : { ...d, id: ++seq, count: 1, at: now, read: false };
    const rest = toasts.filter((t) => t.id !== note.id);
    const nextToasts = [...rest, note].slice(-TOAST_MAX);
    const nextLog = [note, ...log.filter((n) => n.id !== note.id)].slice(0, LOG_MAX);
    set({ toasts: nextToasts, log: nextLog });
    return note;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  markRead: () => set((s) => ({ log: s.log.map((n) => (n.read ? n : { ...n, read: true })) })),
  reset: () => set({ toasts: [], log: [] }),
}));

/** The bell's count: notes not read yet. */
export const unreadCount = (log: readonly Note[]) => log.filter((n) => !n.read).length;
