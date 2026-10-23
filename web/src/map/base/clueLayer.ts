// B-C1: clue pins. A colour per kind; the label is the clue id and kind; a click shows what, reliability,
// radius and how it came in ("by radio" / "entered at command"). Built by lane A for lane B (#74).
import type { Clue } from "../../contract";
import { point, type MissionFeature, type Tone } from "./missionFeature";

/** Clues are amber everywhere (the v3 colour system); the kind is in the label and the popup. */
export const CLUE_TONE: Record<Clue["kind"], Tone> = { object: "clue", track: "clue", sighting: "clue", sound: "clue", other: "clue" };

/** `time`: the page's clock (lib/time); by default the clue's UTC HH:MM. */
export function clueFeatures(
  clues: readonly Clue[],
  callsign: (id: string) => string = (id) => id,
  time: (iso: string) => string = (iso) => iso.slice(11, 16),
): MissionFeature[] {
  return clues.map((c) =>
    point("clue", c.id, `${c.id} ${c.kind}`, CLUE_TONE[c.kind], c.lon, c.lat,
      `${c.text}\n${c.kind} · ${c.reliability} reliability · within ${Math.round(c.radius_m)} m\n` +
        `${c.source === "radio" ? "by radio" : "entered at command"} · ${callsign(c.reported_by)} · ${time(c.at)}`),
  );
}
