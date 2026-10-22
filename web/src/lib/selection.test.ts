import { beforeEach, describe, expect, it } from "vitest";
import { frameIdOf, useSelection } from "./selection";

describe("useSelection", () => {
  beforeEach(() => useSelection.getState().clear());

  it("starts with nothing selected", () => {
    expect(useSelection.getState()).toMatchObject({ selectedDetectionId: null, selectedFrameId: null });
  });

  it("selecting a detection also selects its frame", () => {
    useSelection.getState().selectDetection("f0042-d01");

    expect(useSelection.getState()).toMatchObject({
      selectedDetectionId: "f0042-d01",
      selectedFrameId: "f0042",
    });
  });

  it("selecting a frame clears a detection from another frame", () => {
    useSelection.getState().selectDetection("f0042-d01");

    useSelection.getState().selectFrame("f0007");

    expect(useSelection.getState()).toMatchObject({ selectedDetectionId: null, selectedFrameId: "f0007" });
  });

  it("selecting the frame of the current detection keeps the detection", () => {
    useSelection.getState().selectDetection("f0042-d02");

    useSelection.getState().selectFrame("f0042");

    expect(useSelection.getState().selectedDetectionId).toBe("f0042-d02");
  });

  it("selectDetection(null) clears both", () => {
    useSelection.getState().selectDetection("f0042-d01");

    useSelection.getState().selectDetection(null);

    expect(useSelection.getState()).toMatchObject({ selectedDetectionId: null, selectedFrameId: null });
  });

  it("frameIdOf reads the frame out of a detection id and rejects other shapes", () => {
    expect(frameIdOf("f0500-d12")).toBe("f0500");
    expect(() => frameIdOf("detection-1")).toThrow(/detection id/);
  });

  it("selects one team, drone or clue at a time, and clear() drops them (D-M2)", () => {
    const s = useSelection.getState();
    s.selectTeam("T2");
    expect(useSelection.getState().selectedTeamId).toBe("T2");
    s.selectClue("c003");
    expect(useSelection.getState()).toMatchObject({ selectedTeamId: null, selectedClueId: "c003" });
    s.selectDrone("D1");
    expect(useSelection.getState()).toMatchObject({ selectedClueId: null, selectedDroneId: "D1" });
    s.clear();
    expect(useSelection.getState()).toMatchObject({ selectedDroneId: null, selectedTeamId: null, selectedClueId: null });
  });
});
