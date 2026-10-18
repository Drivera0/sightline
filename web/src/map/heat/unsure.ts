// "Unsure" answers on the map (LANE_C_SEARCH §3.5). "I can't tell" is no evidence, so the map does
// not change: the area stays held (heldCells in search/store.ts) until someone answers "Not a
// person". What this file adds is visibility, so a coordinator does not overlook an unresolved area:
// an amber ring on the heat map, an entry at the top of the Search next list, a tag on the
// sectors holding them and a line in Review's readout.
import type { UnsureArea } from "../../search/store";

/** The label shared by the pin, the legend, the Search next entry, the sector tags and the ring. */
export const UNSURE_LABEL = "Unsure · check again";

/** 1 for every cell within radius_m of an "Unsure" detection whose photo has been flown. */
export function unsureMask(cellCount: number, areas: readonly UnsureArea[]): Uint8Array {
  const mask = new Uint8Array(cellCount);
  for (const a of areas) for (const c of a.cells) if (c >= 0 && c < cellCount) mask[c] = 1;
  return mask;
}

const areasText = (n: number) => (n === 1 ? "1 area" : `${n} areas`);

/** The Search next entry: "Unsure · check again: 2 areas the reviewer couldn't call". */
export function unsureListText(n: number): string {
  return `${UNSURE_LABEL}: ${areasText(n)} the reviewer couldn't call`;
}

/** Review's readout line (shown only when n > 0). */
export function unsureReadoutText(n: number): string {
  return n === 1
    ? "1 unsure area kept at its value before the photo"
    : `${n} unsure areas kept at their value before the photo`;
}
