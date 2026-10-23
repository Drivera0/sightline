// The console's own state (not the mission's): which sector's popover is open and where, whether a T-card's
// Task button has put the map in pick-a-sector mode, the timeline's filter, who the talk bar is addressed to,
// and the phone's tab. One store so the map, the cards and the timeline can hand each other work. Built by lane A.
import { create } from "zustand";
import type { Filter } from "./timeline";

export type PhoneTab = "map" | "needs" | "timeline" | "more";

export interface ConsoleState {
  /** The sector popover: its sector and the screen point it opens at (map coordinates, px). */
  sector: { id: string; x: number; y: number } | null;
  /** Task mode: the next sector clicked on the map goes to this team or drone. */
  picking: { kind: "team" | "drone"; id: string } | null;
  filter: Filter;
  /** The talk bar's recipient (a team id). */
  talkTo: string | null;
  /** Bumped to put the cursor in the talk bar (Call, Reply). */
  talkFocus: number;
  /** What the talk bar starts with (Reply: "Team Two, Sightline. "). */
  talkDraft: string;
  tab: PhoneTab;
  openSector: (id: string, x: number, y: number) => void;
  closeSector: () => void;
  pick: (p: ConsoleState["picking"]) => void;
  setFilter: (f: Filter) => void;
  /** Address the talk bar to a team and put the cursor there. */
  talk: (team: string, draft?: string) => void;
  setTalkTo: (team: string) => void;
  setTab: (t: PhoneTab) => void;
  reset: () => void;
}

const INITIAL = { sector: null, picking: null, filter: "All" as Filter, talkTo: null, talkFocus: 0, talkDraft: "", tab: "map" as PhoneTab };

export const useConsole = create<ConsoleState>((set) => ({
  ...INITIAL,
  openSector: (id, x, y) => set({ sector: { id, x, y } }),
  closeSector: () => set({ sector: null }),
  pick: (picking) => set({ picking, sector: null }),
  setFilter: (filter) => set({ filter }),
  talk: (team, draft = "") => set((s) => ({ talkTo: team, talkFocus: s.talkFocus + 1, talkDraft: draft })),
  setTalkTo: (talkTo) => set({ talkTo }),
  setTab: (tab) => set({ tab }),
  reset: () => set({ ...INITIAL }),
}));
