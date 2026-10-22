// A pick on the live map requested from elsewhere on the page (lane E's clue form asks; the live map,
// a sibling, answers through B's `onPick`). Built by lane A for lanes B and E (#74, #70).
import { create } from "zustand";

export type LatLon = { lat: number; lon: number };

interface PickState {
  /** Set while a pick is wanted; the map calls it with the point, or null when cancelled. */
  pending: ((p: LatLon | null) => void) | null;
  request: () => Promise<LatLon | null>;
}

export const usePick = create<PickState>((set, get) => ({
  pending: null,
  request: () =>
    new Promise((resolve) => {
      get().pending?.(null); // one pick at a time: an earlier request is cancelled
      set({
        pending: (p) => {
          set({ pending: null });
          resolve(p);
        },
      });
    }),
}));
