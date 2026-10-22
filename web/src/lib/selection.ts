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
  /** Live missions (D-M2): a team, a drone or a clue picked on the map, the roster or the clue log.
   * Selecting one of these clears the other two (one thing is selected at a time). */
  selectedTeamId: string | null;
  selectedDroneId: string | null;
  selectedClueId: string | null;
  selectTeam: (id: string | null) => void;
  selectDrone: (id: string | null) => void;
  selectClue: (id: string | null) => void;
  clear: () => void;
}

const NO_MISSION_THING = { selectedTeamId: null, selectedDroneId: null, selectedClueId: null };

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
  selectedTeamId: null,
  selectedDroneId: null,
  selectedClueId: null,
  selectTeam: (id) => set({ ...NO_MISSION_THING, selectedTeamId: id }),
  selectDrone: (id) => set({ ...NO_MISSION_THING, selectedDroneId: id }),
  selectClue: (id) => set({ ...NO_MISSION_THING, selectedClueId: id }),
  clear: () => set({ selectedDetectionId: null, selectedFrameId: null, ...NO_MISSION_THING }),
}));
