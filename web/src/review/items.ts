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

/** How many photos the queue covers and how many boxes in them: a photo can hold more than one box. */
export function queueCounts(items: readonly Pick<ReviewItem, "frame">[]): { photos: number; boxes: number } {
  return { photos: new Set(items.map((i) => i.frame.id)).size, boxes: items.length };
}

/**
 * "f0127 · box 2" for photos with more than one box in the queue (numbered in queue order), and
 * just the photo id otherwise.
 */
export function itemLabels(items: readonly Pick<ReviewItem, "id" | "frame">[]): Map<string, string> {
  const perFrame = new Map<string, string[]>();
  for (const item of items) perFrame.set(item.frame.id, [...(perFrame.get(item.frame.id) ?? []), item.id]);
  const labels = new Map<string, string>();
  for (const item of items) {
    const ids = perFrame.get(item.frame.id)!;
    labels.set(item.id, ids.length > 1 ? `${item.frame.id} · box ${ids.indexOf(item.id) + 1}` : item.frame.id);
  }
  return labels;
}
