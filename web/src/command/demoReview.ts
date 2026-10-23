// The demo mission's Photos and Review rails: the survey's photos and candidates as far as the mission
// clock has got (the demo cache), plus the one second look from this flight (#192): f0273-d02, a 0.17
// detection the queue would have dropped, two people on a trail under the trees. Its second look is real:
// OpenCV 5's native-resolution zoom of the photo and Nemotron VL's verdict, run live on 22 Oct 2026 by
// scripts/make_second_look_fixture.py (`__fixtures__/second_look/`, the verdict word for word). Confirming
// it pins a sighting where the photo puts it, like any other candidate.

import type { CacheBundle, Frame, Verdict } from "../contract";
import { verdictChips, verdictWords, type ReviewCard } from "../review/LiveReview";
import secondLook from "./__fixtures__/second_look/verdict.json";
import cropUrl from "./__fixtures__/second_look/f0273-d02-crop.jpg?url";
import zoomUrl from "./__fixtures__/second_look/f0273-d02-zoom_native.jpg?url";

/** The detection the second look is on: a real near miss of the demo cache, so its pin has a place. */
export const SECOND_LOOK_ID: string = secondLook.detection.id;

/** The verdict as the live run stored it (`second_look/verdict.json`, from its trace). */
export const SECOND_LOOK_VERDICT = secondLook.verdict as Verdict;

export function secondLookCard(): ReviewCard {
  const v = SECOND_LOOK_VERDICT;
  return {
    id: SECOND_LOOK_ID,
    conf: secondLook.detection.conf,
    crop: cropUrl,
    frame: "Second look · this flight",
    words: verdictWords(v),
    chips: verdictChips(v),
    relook: v.relook_crops.map((name) => ({ url: zoomUrl, name })),
    promoted: true,
    ms: v.ms,
    note: `Survey photo ${SECOND_LOOK_ID.slice(0, 5)}, below the 0.29 review threshold, so the queue would have dropped it; the agent promoted it after the second look (OpenCV 5 zoom, then Nemotron VL, a live call): "${v.reason}"`,
  };
}

/** The survey's photos that have landed: the first `count` in flight order. */
export function landedFrames(bundle: CacheBundle | null, count: number): Frame[] {
  if (!bundle) return [];
  return [...bundle.survey.frames].sort((a, b) => a.flight_index - b.flight_index).slice(0, count);
}

/** The review queue at this moment: candidates in landed photos, most confident first; the second look from this flight third. */
export function demoCards(bundle: CacheBundle | null, landed: readonly Frame[], imageUrl: (rel: string) => string, withSecondLook: boolean): ReviewCard[] {
  if (!bundle) return [];
  const photoOf = (id: string) => {
    const f = bundle.survey?.frames.find((x) => x.id === id.slice(0, 5));
    const det = bundle.detections.frames[id.slice(0, 5)]?.find((d) => d.id === id);
    return f && det ? { photo: imageUrl(f.file), size: [f.width_px, f.height_px] as [number, number], box: det.box_px } : {};
  };
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
      ...photoOf(d.id),
    }));
  if (withSecondLook) {
    const own = secondLookCard();
    const f = bundle.survey?.frames.find((x) => x.id === SECOND_LOOK_ID.slice(0, 5));
    cards.splice(Math.min(2, cards.length), 0, f ? { ...own, photo: imageUrl(f.file), size: [f.width_px, f.height_px], box: secondLook.detection.box_px as [number, number, number, number] } : own);
  }
  return cards;
}

/** Where a demo candidate is on the map (its pin when a person confirms it). */
export function candidatePosition(bundle: CacheBundle | null, id: string): { lat: number; lon: number; frame: string; conf: number } | null {
  const det = bundle?.detections.frames[id.slice(0, 5)]?.find((d) => d.id === id);
  return det && det.lat !== null && det.lon !== null ? { lat: det.lat, lon: det.lon, frame: id.slice(0, 5), conf: det.conf } : null;
}
