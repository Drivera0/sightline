import { beforeAll, describe, expect, it } from "vitest";
import type { CacheBundle } from "../contract";
import { loadCache } from "../lib/cache";
import { diskFetch } from "../lib/diskFetch";
import { introCopy, wallColumns } from "./SurveyIntro";

let cache: CacheBundle;
beforeAll(async () => {
  cache = await loadCache("sample", diskFetch());
});

describe("introCopy", () => {
  it("says the photos are sections of real HERIDAL photos from Croatia and only the path is simulated", () => {
    const copy = introCopy(cache);
    expect(copy.headline).toBe("20 photos from a simulated drone search over Mount Seymour");
    // sample frames are 1000×750: 16 per 4000×3000 photo
    expect(copy.provenance).toBe(
      "HERIDAL search-and-rescue photos from Croatia, each a 1000×750 section of a 4000×3000 original (16 per original). Only the flight path over Mount Seymour, North Vancouver is simulated.",
    );
    expect(copy.body).toMatch(/Somewhere in them are a few people/);
  });

  it("on a survey at recorded positions where every photo has a person, says so instead", () => {
    const c = structuredClone(cache);
    c.survey.simulated_path = false;
    c.survey.area.name = "HERIDAL SB site (real EXIF positions)";
    c.manifest.n_frames = 10;
    c.metrics.ranking.n_frames = 10;
    c.metrics.ranking.n_positive = 10;
    const copy = introCopy(c);
    expect(copy.headline).toBe("10 photos from HERIDAL SB site, at their recorded positions");
    expect(copy.provenance).toMatch(/placed at their recorded EXIF positions\.$/);
    expect(copy.body).toMatch(/^Every photo in this survey contains a person/);
    expect(copy.body).not.toMatch(/a few people/);
    // No "Start: rank" next to "nothing to rank": the action goes to the pins.
    expect(copy.nothingToRank).toBe(true);
    expect(copy.action).toBe("See the pins at real positions");
  });

  it("keeps the rank action when there is something to rank", () => {
    expect(introCopy(cache).nothingToRank).toBe(false);
    expect(introCopy(cache).action).toBe("Start: rank 20 photos");
  });

  it("does not call full-size photos sections", () => {
    const c = structuredClone(cache);
    for (const f of c.survey.frames) {
      f.width_px = 4000;
      f.height_px = 3000;
    }
    expect(introCopy(c).headline).toMatch(/^20 photos/);
    expect(introCopy(c).provenance).not.toMatch(/sections/);
  });
});

describe("wallColumns", () => {
  it("fills every column even when the survey has only a few photos", () => {
    const c = structuredClone(cache);
    c.survey.frames = c.survey.frames.slice(0, 4);
    const columns = wallColumns(c);
    expect(columns).toHaveLength(6);
    for (const column of columns) expect(column).toHaveLength(9);
    // Neighbouring columns do not start on the same photo.
    expect(columns[0]![0]!.frame.id).not.toBe(columns[1]![0]!.frame.id);
  });

  it("uses each photo once when there are enough", () => {
    const c = structuredClone(cache);
    const base = c.survey.frames[0]!;
    c.survey.frames = Array.from({ length: 60 }, (_, i) => ({ ...base, id: `g${i}`, flight_index: i }));
    const ids = wallColumns(c).flat().map((t) => t.frame.id);
    expect(ids).toHaveLength(54);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
