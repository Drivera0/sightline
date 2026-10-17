import { describe, expect, it } from "vitest";
import type { CacheBundle } from "../contract";
import { loadCache } from "../lib/cache";
import { diskFetch } from "../lib/diskFetch";
import { reviewItems, reviewProgress } from "./items";

const sample = (): Promise<CacheBundle> => loadCache("sample", diskFetch());

describe("reviewItems", () => {
  it("lists detections at or above the candidate threshold, most confident first", async () => {
    const items = reviewItems(await sample());

    expect(items.map((i) => i.id)).toEqual(["f0005-d01", "f0012-d01", "f0008-d01"]);
    expect(items.map((i) => i.detection.conf)).toEqual([0.874, 0.612, 0.31]);
  });

  it("leaves out detections below the threshold", async () => {
    const items = reviewItems(await sample());

    expect(items.map((i) => i.id)).not.toContain("f0005-d02");
  });

  it("includes a detection exactly on the threshold", async () => {
    const cache = await sample();
    cache.detections.candidate_threshold = 0.31;

    expect(reviewItems(cache).map((i) => i.id)).toContain("f0008-d01");
  });

  it("breaks equal confidence by the frame's rank", async () => {
    const cache = await sample();
    const a = cache.detections.frames["f0012"]![0]!;
    const b = cache.detections.frames["f0008"]![0]!;
    a.conf = b.conf = 0.5;
    const rankOf = (id: string) => cache.survey.frames.find((f) => f.id === id)!.rank;

    const ids = reviewItems(cache).map((i) => i.id).filter((id) => id !== "f0005-d01");

    expect(rankOf(ids[0]!.slice(0, 5))).toBeLessThan(rankOf(ids[1]!.slice(0, 5)));
  });

  it("gives each item its frame and the crop path", async () => {
    const [first] = reviewItems(await sample());

    expect(first?.frame.id).toBe("f0005");
    expect(first?.detection.crop).toBe("crops/f0005-d01.jpg");
  });

  it("is empty when nothing reaches the threshold", async () => {
    const cache = await sample();
    cache.detections.candidate_threshold = 0.99;

    expect(reviewItems(cache)).toEqual([]);
  });
});

describe("reviewProgress", () => {
  const ids = (list: string[]) => list.map((id) => ({ id }) as never);

  it("counts reviewed items and confirmed people", () => {
    const items = ids(["a", "b", "c"]);

    expect(reviewProgress(items, { a: "person", b: "not_person" })).toEqual({ reviewed: 2, total: 3, persons: 1 });
  });

  it("ignores answers for detections that are not in the queue", () => {
    expect(reviewProgress(ids(["a"]), { z: "person" })).toEqual({ reviewed: 0, total: 1, persons: 0 });
  });

  it("counts an unsure answer as reviewed", () => {
    expect(reviewProgress(ids(["a"]), { a: "unsure" })).toEqual({ reviewed: 1, total: 1, persons: 0 });
  });
});
