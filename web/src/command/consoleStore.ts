// The console's own state (not the mission's): which sector's popover is open and where, whether a T-card's
// Task button has put the map in pick-a-sector mode, the timeline's filter, who the talk bar is addressed to,
// and the phone's tab. One store so the map, the cards and the timeline can hand each other work. Built by lane A.
import { create } from "zustand";
import { FILTERS, type Filter } from "./timeline";

/** The timeline's filter stays as this browser left it (V3 §3: filters are sticky). */
export const FILTER_KEY = "sightline.timelineFilter";
function savedFilter(): Filter {
  try {
    const v = globalThis.localStorage?.getItem(FILTER_KEY);
    return (FILTERS as readonly string[]).includes(v ?? "") ? (v as Filter) : "All";
  } catch {
    return "All";
  }
}

export type PhoneTab = "map" | "needs" | "timeline" | "more";

/** What the search manager is looking at in Needs you: the map highlights it (V3 §2). */
export type Focus = { kind: "candidate"; id: string } | { kind: "proposal"; id: string };

export interface ConsoleState {
  /** The sector popover: its sector and the screen point it opens at (map coordinates, px). */
  sector: { id: string; x: number; y: number } | null;
  /** Task mode: the next sector clicked on the map goes to this team or drone. */
  picking: { kind: "team" | "drone"; id: string } | null;
  /** A T-card being dragged toward the map: the map outlines the sector under it and says what a drop does. */
  dragging: { kind: "team" | "drone"; id: string } | null;
  filter: Filter;
  /** The talk bar's recipient (a team id). */
  talkTo: string | null;
  /** Bumped to put the cursor in the talk bar (Call, Reply). */
  talkFocus: number;
  /** What the talk bar starts with (Reply: "Team Two, Sightline. "). */
  talkDraft: string;
  tab: PhoneTab;
  /** The candidate or proposal in focus (the map pans to it and highlights it). */
  focus: Focus | null;
  /** The large review frame: open, and on which candidate (null: the first waiting). */
  review: { open: boolean; id: string | null };
  /** The Add clue form, opened from the header, the map's right-click or a hint (bumped each time). */
  clue: { open: boolean; at: { lat: number; lon: number } | null; n: number };
  /** A timeline row to bring into view and highlight ("Show me" on a radio call), by entry id or ref. */
  row: { ref: string; n: number } | null;
  openSector: (id: string, x: number, y: number) => void;
  closeSector: () => void;
  pick: (p: ConsoleState["picking"]) => void;
  drag: (d: ConsoleState["dragging"]) => void;
  setFilter: (f: Filter) => void;
  /** Address the talk bar to a team and put the cursor there. */
  talk: (team: string, draft?: string) => void;
  setTalkTo: (team: string) => void;
  setTab: (t: PhoneTab) => void;
  setFocus: (f: Focus | null) => void;
  openReview: (id?: string | null) => void;
  closeReview: () => void;
  openClue: (at?: { lat: number; lon: number } | null) => void;
  closeClue: () => void;
  showRow: (ref: string) => void;
  reset: () => void;
}

const INITIAL = { sector: null, picking: null, dragging: null as ConsoleState["dragging"], filter: savedFilter(), talkTo: null, talkFocus: 0, talkDraft: "", tab: "map" as PhoneTab,
  focus: null as Focus | null,
  review: { open: false, id: null as string | null },
  clue: { open: false, at: null as { lat: number; lon: number } | null, n: 0 },
  row: null as { ref: string; n: number } | null,
};

export const useConsole = create<ConsoleState>((set) => ({
  ...INITIAL,
  openSector: (id, x, y) => set({ sector: { id, x, y } }),
  closeSector: () => set({ sector: null }),
  pick: (picking) => set({ picking, sector: null }),
  drag: (dragging) => set({ dragging }),
  setFilter: (filter) => {
    try {
      globalThis.localStorage?.setItem(FILTER_KEY, filter);
    } catch {
      /* private mode: this page only */
    }
    set({ filter });
  },
  talk: (team, draft = "") => set((s) => ({ talkTo: team, talkFocus: s.talkFocus + 1, talkDraft: draft })),
  setTalkTo: (talkTo) => set({ talkTo }),
  setTab: (tab) => set({ tab }),
  setFocus: (focus) => set({ focus }),
  openReview: (id = null) => set({ review: { open: true, id } }),
  closeReview: () => set((s) => ({ review: { ...s.review, open: false } })),
  openClue: (at = null) => set((s) => ({ clue: { open: true, at, n: s.clue.n + 1 } })),
  closeClue: () => set((s) => ({ clue: { ...s.clue, open: false, at: null } })),
  showRow: (ref) => set((s) => ({ row: { ref, n: (s.row?.n ?? 0) + 1 }, filter: "All" })),
  reset: () => set({ ...INITIAL, filter: savedFilter() }),
}));
