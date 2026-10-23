// The demo mission's Photos and Review rails: the survey's photos and candidates as far as the mission
// clock has got (the demo cache), plus one recorded second look. That one is real and recorded on another
// HERIDAL photo (docs/architecture/av-chain): a 0.18 detection the queue would have dropped, OpenCV 5's
// native-resolution zoom, Nemotron VL's verdict. It is labelled as recorded, and confirming it pins nothing.

import type { CacheBundle, Frame, Verdict } from "../contract";
import { verdictChips, verdictWords, type ReviewCard } from "../review/LiveReview";
import cropUrl from "./__fixtures__/trace_crop.jpg?url";
import zoomUrl from "./__fixtures__/trace_zoom_native.jpg?url";

export const RECORDED_ID = "recorded-f0001-d01";

/** The verdict as the trace recorded it (demo_trace_avchain.jsonl, t000004). */
export const RECORDED_VERDICT: Verdict = {
  id: "v0001",
  detection_id: "f0001-d01",
  tools: ["zoom_native"],
  relook_crops: ["relook/f0001-d01-zoom_native.jpg"],
  person: "yes",
  posture: "lying",
  group_size: 1,
  clothing: "white top, dark pants",
  reason: "A human shape with a head, torso, and limbs is visible lying on the ground.",
  model: "nvidia/Nemotron-3.5-Super-VL",
  ms: 1488,
  at: "2026-10-21T00:33:25.917Z",
};

export function recordedCard(): ReviewCard {
  return {
    id: RECORDED_ID,
    conf: 0.179,
    crop: cropUrl,
    frame: "Second look on HERIDAL photo train_ZRI_2061, not this flight",
    words: verdictWords(RECORDED_VERDICT),
    chips: verdictChips(RECORDED_VERDICT),
    relook: [{ url: zoomUrl, name: "relook/f0001-d01-zoom_native.jpg" }],
    promoted: true,
    note: "Below the 0.29 review threshold, so the queue would have dropped it; the agent promoted it after the second look. Recorded 21 Oct 2026; it has no place on this map.",
  };
}

/** The survey's photos that have landed: the first `count` in flight order. */
export function landedFrames(bundle: CacheBundle | null, count: number): Frame[] {
  if (!bundle) return [];
  return [...bundle.survey.frames].sort((a, b) => a.flight_index - b.flight_index).slice(0, count);
}

/** The review queue at this moment: candidates in landed photos, most confident first; the recorded one third. */
export function demoCards(bundle: CacheBundle | null, landed: readonly Frame[], imageUrl: (rel: string) => string, withRecorded: boolean): ReviewCard[] {
  if (!bundle) return [];
  const ids = new Set(landed.map((f) => f.id));
  const threshold = bundle.detections.candidate_threshold;
  const cards: ReviewCard[] = Object.entries(bundle.detections.frames)
    .filter(([frame]) => ids.has(frame))
    .flatMap(([, dets]) => dets)
    .filter((d) => d.conf >= threshold && d.crop)
    .sort((a, b) => b.conf - a.conf || a.id.localeCompare(b.id))
    .map((d) => ({
      id: d.id,
      conf: d.conf,
      crop: imageUrl(d.crop as string),
      frame: `Survey photo ${d.id.slice(0, 5)}`,
      words: null,
      note: undefined,
    }));
  if (withRecorded) cards.splice(Math.min(2, cards.length), 0, recordedCard());
  return cards;
}

/** Where a demo candidate is on the map (its pin when a person confirms it). */
export function candidatePosition(bundle: CacheBundle | null, id: string): { lat: number; lon: number; frame: string; conf: number } | null {
  const det = bundle?.detections.frames[id.slice(0, 5)]?.find((d) => d.id === id);
  return det && det.lat !== null && det.lon !== null ? { lat: det.lat, lon: det.lon, frame: id.slice(0, 5), conf: det.conf } : null;
}
