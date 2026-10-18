import { describe, expect, it } from "vitest";
import { flownFrames } from "./features";

describe("flownFrames", () => {
  const steps = [{ frame_id: "f1" }, { frame_id: "f2" }, { frame_id: "f3" }];

  it("lists the frames of the first stepIndex steps", () => {
    expect([...(flownFrames(steps, 2) ?? [])]).toEqual(["f1", "f2"]);
    expect([...(flownFrames(steps, 0) ?? [])]).toEqual([]);
  });

  it("is null (every frame) once the whole flight is applied", () => {
    expect(flownFrames(steps, 3)).toBeNull();
  });
});
