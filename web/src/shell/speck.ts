// "Find the speck": the Survey hero's opening moment. One real photo comes out of the wall, the
// scan line passes over it, and the detector's box snaps onto the person. Pure parts here: which
// photo and box, the label (from the cache only), the timeline, and the play-once state machine.
// SpeckReveal.tsx owns the clock and the markup.

import type { CacheBundle, Detection, Frame } from "../contract";

export interface SpeckPick {
  frame: Frame;
  detection: Detection;
}

/**
 * The top-ranked candidate: the most confident detection at or above the candidate threshold whose
 * frame is in the survey. Ties go to the earlier photo in flight order, then the detection id, so
 * the pick never changes between loads. Null when there is no candidate (then nothing plays).
 */
export function topCandidate(cache: Pick<CacheBundle, "survey" | "detections">): SpeckPick | null {
  const threshold = cache.detections.candidate_threshold;
  const frames = new Map(cache.survey.frames.map((f) => [f.id, f] as const));
  let best: SpeckPick | null = null;
  for (const [frameId, detections] of Object.entries(cache.detections.frames)) {
    const frame = frames.get(frameId);
    if (!frame) continue;
    for (const detection of detections) {
      if (!(detection.conf >= threshold)) continue;
      const [x1, y1, x2, y2] = detection.box_px;
      if (!(x2 > x1 && y2 > y1)) continue;
      if (
        !best ||
        detection.conf > best.detection.conf ||
        (detection.conf === best.detection.conf &&
          (frame.flight_index < best.frame.flight_index ||
            (frame.flight_index === best.frame.flight_index && detection.id < best.detection.id)))
      ) {
        best = { frame, detection };
      }
    }
  }
  return best;
}

/** Box width in pixels, rounded. */
export function boxWidthPx(detection: Detection): number {
  return Math.round(detection.box_px[2] - detection.box_px[0]);
}

export interface SpeckLabel {
  /** "Person · detector score 0.82" */
  title: string;
  /** "44 px wide in a 1000 px photo" */
  size: string;
  /** Both, for screen readers and tests. */
  text: string;
}

/**
 * The label beside the box, built only from the cache: the detector's score and how many pixels
 * wide the box is in this photo. No time or effort claims (those are per full photo, elsewhere).
 */
export function speckLabel({ frame, detection }: SpeckPick): SpeckLabel {
  const title = `Person · detector score ${detection.conf.toFixed(2)}`;
  const size = `${boxWidthPx(detection)} px wide in a ${frame.width_px} px photo`;
  return { title, size, text: `${title} · ${size}` };
}

/**
 * The square region the loupe magnifies, in frame pixels: centred on the box, about twice its
 * larger side (at least `minSide`), moved inside the photo where the box is near an edge.
 */
export function loupeRegion(
  { frame, detection }: SpeckPick,
  scale = 2.2,
  minSide = 72,
): { x: number; y: number; side: number } {
  const [x1, y1, x2, y2] = detection.box_px;
  const side = Math.min(Math.max((x2 - x1) * scale, (y2 - y1) * scale, minSide), frame.width_px, frame.height_px);
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const x = Math.min(Math.max(cx - side / 2, 0), frame.width_px - side);
  const y = Math.min(Math.max(cy - side / 2, 0), frame.height_px - side);
  return { x, y, side };
}

/** Which side of the box the loupe goes: the side with more photo. */
export function loupeSide({ frame, detection }: SpeckPick): "left" | "right" {
  const cx = (detection.box_px[0] + detection.box_px[2]) / 2;
  return cx / frame.width_px < 0.55 ? "right" : "left";
}

/** Wait after the page loads before the photo comes forward. */
export const SPECK_DELAY_MS = 1700;
/** The photo lifting out of the wall. */
export const SPECK_RISE_MS = 750;
/** One pass of the scan line, top to bottom (linear, so it passes the box on time). */
export const SPECK_SCAN_MS = 1500;
/** The card going back into the wall. */
export const SPECK_SETTLE_MS = 700;

export interface SpeckTimeline {
  scanAt: number;
  scanMs: number;
  /** When the scan line passes the box's centre: the box snaps on. */
  boxAt: number;
  loupeAt: number;
  labelAt: number;
  settleAt: number;
  /** The card is gone; the resting state shows. */
  endAt: number;
}

/** When each beat happens, in ms after the photo starts to come forward. */
export function speckTimeline({ frame, detection }: SpeckPick): SpeckTimeline {
  const cy = (detection.box_px[1] + detection.box_px[3]) / 2;
  const fy = Math.min(1, Math.max(0, cy / frame.height_px));
  const scanAt = SPECK_RISE_MS - 100;
  const boxAt = Math.round(scanAt + SPECK_SCAN_MS * fy);
  const loupeAt = boxAt + 550;
  const labelAt = loupeAt + 300;
  // Hold long enough to read the label, and never settle before the scan has finished.
  const settleAt = Math.max(labelAt + 2300, scanAt + SPECK_SCAN_MS + 400);
  return { scanAt, scanMs: SPECK_SCAN_MS, boxAt, loupeAt, labelAt, settleAt, endAt: settleAt + SPECK_SETTLE_MS };
}

/**
 * waiting: before the first play (the photo is loading, the delay is running). playing: the
 * animation. rest: done; only a quiet Replay control. still: reduced motion, the end state shown
 * without animation.
 */
export type SpeckStatus = "waiting" | "playing" | "rest" | "still";

export type SpeckEvent =
  /** The photo is loaded and the delay has passed. */
  | { type: "start" }
  | { type: "ended" }
  | { type: "replay" }
  /** Something else takes the stage (the guided tour): stop and stay quiet. */
  | { type: "quiet" };

export function initialSpeck({ reducedMotion, played }: { reducedMotion: boolean; played: boolean }): SpeckStatus {
  if (reducedMotion) return "still";
  return played ? "rest" : "waiting";
}

export function speckReducer(status: SpeckStatus, event: SpeckEvent): SpeckStatus {
  if (status === "still") return status;
  switch (event.type) {
    case "start":
      return status === "waiting" ? "playing" : status;
    case "ended":
      return status === "playing" ? "rest" : status;
    case "replay":
      return "playing";
    case "quiet":
      return "rest";
  }
}
