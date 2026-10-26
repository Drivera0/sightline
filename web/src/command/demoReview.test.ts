// The demo's second look is from this flight (#192): a real near miss of the demo cache, its verdict the
// live model's word for word, its card third in the queue, and a person's "Person" pins it where the photo is.
import { describe, expect, it } from "vitest";
import type { CacheBundle, Detection } from "../contract";
import secondLook from "./__fixtures__/second_look/verdict.json";
import trace from "./__fixtures__/demo_trace.jsonl?raw";
import { candidatePosition, demoCards, SECOND_LOOK_ID, SECOND_LOOK_VERDICT, secondLookCard } from "./demoReview";
import { parseTrace } from "./trace";

const det = (id: string, conf: number, extra: Partial<Detection> = {}): Detection =>
  ({ id, box_px: [0, 0, 40, 40], conf, crop: conf >= 0.29 ? `crops/${id}.jpg` : null, lat: 49.37, lon: -122.94, radius_m: 10, ...extra }) as Detection;

const bundle = {
  detections: {
    candidate_threshold: 0.29,
    frames: {
      f0002: [det("f0002-d01", 0.74)],
      f0127: [det("f0127-d01", 0.8)],
      f0273: [det("f0273-d01", 0.415), det("f0273-d02", 0.173, { lat: 49.369921, lon: -122.9433 })],
    },
  },
} as unknown as CacheBundle;
const frames = ["f0002", "f0127", "f0273"].map((id) => ({ id })) as never;

describe("the second look from this flight", () => {
  it("is a near miss of the demo cache, under the review threshold", () => {
    expect(SECOND_LOOK_ID).toBe("f0273-d02");
    expect(secondLook.detection.conf).toBeLessThan(0.29);
    expect(secondLook.detection.conf).toBeGreaterThanOrEqual(0.12);
  });

  it("keeps the live model's verdict word for word, and the demo trace replays that answer", () => {
    const answer = JSON.parse(secondLook.answer as string) as { person: string; reason: string };
    expect(SECOND_LOOK_VERDICT.person).toBe(answer.person);
    expect(SECOND_LOOK_VERDICT.reason).toBe(answer.reason);
    expect(SECOND_LOOK_VERDICT.model).toBe(secondLook.model_call.model);
    const call = parseTrace(trace).find((e) => e.kind === "model_call" && e.refs.includes(SECOND_LOOK_ID))!;
    expect(call.model).toBe(`recorded/${secondLook.model_call.model}`);
    expect((call.output as { text: string }).text).toBe(secondLook.answer);
  });

  it("reads as a survey photo flagged by the AI re-check, with its OpenCV and VL chips and the zoom", () => {
    const c = secondLookCard();
    expect(c.frame).toBe("Survey photo f0273 · flagged by the AI re-check");
    expect(c.id).toBe(SECOND_LOOK_ID);
    expect(c.words).toMatch(/^AI re-check: likely a person/);
    expect(c.chips).toEqual(["OpenCV 5 zoom", "Nemotron-3.5-Super-VL"]);
    expect(c.relook?.map((r) => r.name)).toEqual(["relook/f0273-d02-zoom_native.jpg"]);
    expect(c.note).toContain(SECOND_LOOK_VERDICT.reason);
    expect(c.note).not.toMatch(/another photo|not this flight/i);
  });

  it("comes third in the queue from Confirm on, and confirming it has a place on the map", () => {
    const cards = demoCards(bundle, frames, (rel) => rel, true);
    expect(cards.map((c) => c.id)).toEqual(["f0127-d01", "f0002-d01", "f0273-d02", "f0273-d01"]);
    expect(demoCards(bundle, frames, (rel) => rel, false).map((c) => c.id)).not.toContain("f0273-d02");
    expect(candidatePosition(bundle, SECOND_LOOK_ID)).toEqual({ lat: 49.369921, lon: -122.9433, frame: "f0273", conf: 0.173 });
  });
});
