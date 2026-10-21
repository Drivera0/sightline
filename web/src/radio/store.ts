// Radio desk state (LANE_E §8.5). Persist nothing except the radio-sound preference.
import { create } from "zustand";
import type { OutboundItem, RadioTurn } from "./api";

export type Stage = "idle" | "recording" | "sending" | "speaking";

export interface Team {
  id: string;
  callsign: string;
}

/** The LANE_E demo roster, until D's useMission provides the mission's teams (D-M1). */
export const DEMO_TEAMS: Team[] = [
  { id: "T1", callsign: "Team One" },
  { id: "T2", callsign: "Team Two" },
  { id: "T3", callsign: "Team Three" },
  { id: "T4", callsign: "Team Four" },
];

const SOUND_KEY = "sightline.radio.sound";

function loadSound(): boolean {
  try {
    return globalThis.localStorage?.getItem(SOUND_KEY) === "1";
  } catch {
    return false;
  }
}

interface RadioState {
  stage: Stage;
  turns: RadioTurn[]; // newest last
  outbound: OutboundItem[];
  speakingAs: string; // team id the operator plays (demo) or the cabled radio's team
  radioSound: boolean;
  error: string | null;
  micDenied: boolean;
  setStage: (s: Stage) => void;
  addTurn: (t: RadioTurn) => void;
  setOutbound: (o: OutboundItem[]) => void;
  setSpeakingAs: (id: string) => void;
  setRadioSound: (on: boolean) => void;
  setError: (e: string | null) => void;
  setMicDenied: (d: boolean) => void;
  reset: () => void;
}

const initial = { stage: "idle" as Stage, turns: [], outbound: [], speakingAs: "T2", error: null, micDenied: false };

export const useRadio = create<RadioState>((set) => ({
  ...initial,
  radioSound: loadSound(),
  setStage: (stage) => set({ stage }),
  addTurn: (t) => set((s) => ({ turns: [...s.turns, t] })),
  setOutbound: (outbound) => set({ outbound }),
  setSpeakingAs: (speakingAs) => set({ speakingAs }),
  setRadioSound: (radioSound) => {
    try {
      globalThis.localStorage?.setItem(SOUND_KEY, radioSound ? "1" : "0");
    } catch {
      /* private mode: the toggle still works for this page */
    }
    set({ radioSound });
  },
  setError: (error) => set({ error }),
  setMicDenied: (micDenied) => set({ micDenied }),
  reset: () => set({ ...initial }),
}));
