import { describe, expect, it } from "vitest";
import {
  architectureName,
  boxValuesPerLocation,
  detectorSpec as spec,
  formatMillions,
  formatShape,
  gridLocations,
  inputsOf,
  pyramidLevels,
  stageOf,
} from "./detectorSpec";

describe("detectorSpec.json (exported from the weights-v2 file)", () => {
  it("describes the release weights", () => {
    expect(spec.weights_sha256).toBe("cba1f7230294570c2928e0345141f3fb98895aa03f1819fe0b588490915698a5");
    expect(spec.total_params).toBe(9_428_179);
    expect(spec.n_layers).toBe(24);
    expect(spec.layers).toHaveLength(spec.n_layers);
    expect(spec.nc).toBe(1);
    expect(spec.strides).toEqual([8, 16, 32]);
    expect(spec.imgsz).toBe(1024);
    expect(spec.detect_from).toEqual([16, 19, 22]);
  });

  it("has layer parameters that add up to the total", () => {
    expect(spec.layers.reduce((n, l) => n + l.params, 0)).toBe(spec.total_params);
  });

  it("has the expected shapes at a 1024 px input", () => {
    const shape = (i: number) => spec.layers[i]?.out_shape;
    expect(shape(0)).toEqual([32, 512, 512]);
    expect(shape(9)).toEqual([512, 32, 32]);
    expect(spec.layers[9]?.type).toBe("SPPF");
    expect(spec.layers[10]?.type).toBe("C2PSA");
    expect(shape(12)).toEqual([768, 64, 64]);
    expect(shape(16)).toEqual([128, 128, 128]);
    expect(shape(19)).toEqual([256, 64, 64]);
    expect(shape(22)).toEqual([512, 32, 32]);
  });
});

describe("derived numbers", () => {
  it("counts 21,504 grid locations per 1024 px pass, matching the Detect output", () => {
    expect(gridLocations(1024, [8, 16, 32])).toBe(128 ** 2 + 64 ** 2 + 32 ** 2);
    expect(gridLocations(spec.imgsz, spec.strides)).toBe(21_504);
    expect(spec.layers[23]?.out_shape[1]).toBe(21_504);
  });

  it("predicts 4 box values per location besides the class score", () => {
    expect(boxValuesPerLocation(spec)).toBe(4);
  });

  it("resolves -1 to the previous layer and keeps concat sources", () => {
    expect(inputsOf({ index: 5, from: -1 })).toEqual([4]);
    expect(inputsOf({ index: 12, from: [-1, 6] })).toEqual([11, 6]);
    expect(inputsOf({ index: 0, from: -1 })).toEqual([-1]);
    expect(inputsOf(spec.layers[23]!)).toEqual([16, 19, 22]);
  });

  it("splits the layers into backbone (0–10), neck (11–22) and head (23)", () => {
    const stages = spec.layers.map((l) => stageOf(l, spec));
    expect(stages.filter((s) => s === "backbone")).toHaveLength(11);
    expect(stages.filter((s) => s === "neck")).toHaveLength(12);
    expect(stages[23]).toBe("head");
  });

  it("names the three pyramid levels with their strides", () => {
    expect(pyramidLevels(spec).map((l) => [l.name, l.layer.index, l.stride, formatShape(l.layer.out_shape)])).toEqual([
      ["P3", 16, 8, "128²×128"],
      ["P4", 19, 16, "64²×256"],
      ["P5", 22, 32, "32²×512"],
    ]);
  });

  it("formats shapes, parameter counts and the model name", () => {
    expect(formatShape([256, 128, 128])).toBe("128²×256");
    expect(formatShape([256, 48, 64])).toBe("48×64×256");
    expect(formatMillions(spec.total_params)).toBe("9.43 M");
    expect(architectureName(spec)).toBe("YOLO11s");
  });
});
