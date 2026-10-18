// The published state of the art on the HERIDAL test set, for the details screen. Hard-coded with
// its citation (no contract change), like the human baseline's 33 s. Checked against the paper:
// Pyrrö, Naseri & Jung 2021, "AIR: Aerial Inspection RetinaNet for Land Search and Rescue
// Missions", arXiv:2111.09406, Table 3 ("Comparison with the state-of-the-art in SAR-APD on the
// HERIDAL test set using two different evaluation methods"), values in percent there.

export const AIR_CITATION = "Pyrrö, Naseri & Jung 2021, arXiv:2111.09406, Table 3";

export interface PublishedRow {
  name: string;
  /** Which scoring the row uses; ours is paired with the same scheme. */
  scheme: "voc" | "sar";
  precision: number;
  recall: number;
  ap: number;
}

export const AIR_ROWS: readonly PublishedRow[] = [
  // "VOC2012 evaluation": AIR with NMS, PRC 90.1, RCL 86.1, AP 84.6.
  { name: "AIR with NMS", scheme: "voc", precision: 0.901, recall: 0.861, ap: 0.846 },
  // "SAR-APD evaluation": AIR with MOB (its own box merging), PRC 94.9, RCL 92.9, AP 91.7.
  { name: "AIR with MOB", scheme: "sar", precision: 0.949, recall: 0.929, ap: 0.917 },
];

/**
 * How the paper chose AIR's operating point: the confidence threshold ts was calibrated by testing
 * ten values on the HERIDAL test set (paper, section 5: "we test AIR with 10 different ts values").
 */
export const AIR_TUNING_NOTE =
  "AIR's score threshold was calibrated on the HERIDAL test set itself (paper, section 5); Sightline's threshold was chosen on a validation split.";
