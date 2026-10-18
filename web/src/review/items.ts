import type { CacheBundle, Detection, Frame } from "../contract";
import type { Answer } from "./store";

export interface ReviewItem {
  id: string;
  detection: Detection;
  frame: Frame;
}

/** Detections at or above the candidate threshold, most confident first (ties: better frame rank). */
export function reviewItems(cache: CacheBundle): ReviewItem[] {
  const frames = new Map(cache.survey.frames.map((f) => [f.id, f]));
  const items: ReviewItem[] = [];
  for (const [frameId, detections] of Object.entries(cache.detections.frames)) {
    const frame = frames.get(frameId);
    if (!frame) continue;
    for (const detection of detections) {
      if (detection.conf >= cache.detections.candidate_threshold) {
        items.push({ id: detection.id, detection, frame });
      }
    }
  }
  return items.sort(
    (a, b) =>
      b.detection.conf - a.detection.conf || a.frame.rank - b.frame.rank || a.id.localeCompare(b.id),
  );
}

export function reviewProgress(
  items: readonly Pick<ReviewItem, "id">[],
  answers: Readonly<Record<string, Answer>>,
): { reviewed: number; total: number; persons: number } {
  let reviewed = 0;
  let persons = 0;
  for (const { id } of items) {
    const answer = answers[id];
    if (answer === undefined) continue;
    reviewed++;
    if (answer === "person") persons++;
  }
  return { reviewed, total: items.length, persons };
}
