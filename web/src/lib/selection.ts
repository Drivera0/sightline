import { create } from "zustand";

const DETECTION_ID = /^(f\d{4})-d\d{2}$/;

/** "f0042-d01" -> "f0042". */
export function frameIdOf(detectionId: string): string {
  const match = DETECTION_ID.exec(detectionId);
  if (!match) throw new Error(`Not a detection id: ${detectionId}`);
  return match[1] as string;
}

interface SelectionState {
  selectedDetectionId: string | null;
  selectedFrameId: string | null;
  /** Select a detection, and with it its frame. `null` clears both. */
  selectDetection: (id: string | null) => void;
  /** Select a frame; drops a selected detection that belongs to another frame. */
  selectFrame: (id: string | null) => void;
  clear: () => void;
}

/** Shared by the review queue (D), the map (B) and the heat layer (C). */
export const useSelection = create<SelectionState>((set) => ({
  selectedDetectionId: null,
  selectedFrameId: null,
  selectDetection: (id) =>
    set({ selectedDetectionId: id, selectedFrameId: id === null ? null : frameIdOf(id) }),
  selectFrame: (id) =>
    set((s) => ({
      selectedFrameId: id,
      selectedDetectionId:
        id !== null && s.selectedDetectionId !== null && frameIdOf(s.selectedDetectionId) === id
          ? s.selectedDetectionId
          : null,
    })),
  clear: () => set({ selectedDetectionId: null, selectedFrameId: null }),
}));
