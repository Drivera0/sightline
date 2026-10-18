import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answersOf, useReview } from "./store";

function fresh() {
  localStorage.clear();
  useReview.setState({ surveyId: null, history: [], answers: {}, demoSaved: null });
}

describe("useReview history", () => {
  beforeEach(fresh);

  it("appends answers in order with the time given", () => {
    useReview.getState().answer("f0005-d01", "person", 100);
    useReview.getState().answer("f0012-d01", "not_person", 200);

    expect(useReview.getState().history).toEqual([
      { detectionId: "f0005-d01", answer: "person", at: 100 },
      { detectionId: "f0012-d01", answer: "not_person", at: 200 },
    ]);
  });

  it("derives the latest answer per detection", () => {
    useReview.getState().answer("f0005-d01", "unsure", 1);
    useReview.getState().answer("f0005-d01", "person", 2);

    expect(useReview.getState().answers).toEqual({ "f0005-d01": "person" });
  });

  it("answersOf is the latest answer for each detection in a history", () => {
    expect(
      answersOf([
        { detectionId: "a", answer: "unsure", at: 1 },
        { detectionId: "b", answer: "person", at: 2 },
        { detectionId: "a", answer: "not_person", at: 3 },
      ]),
    ).toEqual({ a: "not_person", b: "person" });
  });

  it("undo removes the last answer and brings back the one before it", () => {
    useReview.getState().answer("f0005-d01", "unsure", 1);
    useReview.getState().answer("f0005-d01", "person", 2);

    useReview.getState().undo();

    expect(useReview.getState().answers).toEqual({ "f0005-d01": "unsure" });
    expect(useReview.getState().history).toHaveLength(1);
  });

  it("undo of the only answer leaves the detection unreviewed", () => {
    useReview.getState().answer("f0005-d01", "person", 1);

    useReview.getState().undo();

    expect(useReview.getState().answers).toEqual({});
  });

  it("undo with nothing to undo does nothing", () => {
    useReview.getState().undo();

    expect(useReview.getState().history).toEqual([]);
  });

  it("reset clears the whole history", () => {
    useReview.getState().answer("f0005-d01", "person", 1);

    useReview.getState().reset();

    expect(useReview.getState()).toMatchObject({ history: [], answers: {} });
  });

  it("a new history array is made on every change, so selectors see the update", () => {
    const before = useReview.getState().history;

    useReview.getState().answer("f0005-d01", "person", 1);

    expect(useReview.getState().history).not.toBe(before);
  });
});

describe("useReview persistence", () => {
  beforeEach(fresh);
  afterEach(() => vi.restoreAllMocks());

  it("saves the history under a key for the survey", () => {
    useReview.getState().bind("sample");

    useReview.getState().answer("f0005-d01", "person", 5);

    expect(JSON.parse(localStorage.getItem("sightline.review.sample") as string)).toEqual([
      { detectionId: "f0005-d01", answer: "person", at: 5 },
    ]);
  });

  it("restores the saved history when the survey is bound again", () => {
    useReview.getState().bind("sample");
    useReview.getState().answer("f0005-d01", "person", 5);
    useReview.setState({ surveyId: null, history: [], answers: {} });

    useReview.getState().bind("sample");

    expect(useReview.getState().answers).toEqual({ "f0005-d01": "person" });
  });

  it("keeps different surveys apart", () => {
    useReview.getState().bind("sample");
    useReview.getState().answer("f0005-d01", "person", 5);

    useReview.getState().bind("seymour-demo");

    expect(useReview.getState().history).toEqual([]);
  });

  it("undo and reset are saved too", () => {
    useReview.getState().bind("sample");
    useReview.getState().answer("f0005-d01", "person", 5);
    useReview.getState().undo();

    expect(JSON.parse(localStorage.getItem("sightline.review.sample") as string)).toEqual([]);
  });

  it("ignores saved data that is not valid JSON", () => {
    localStorage.setItem("sightline.review.sample", "{not json");

    useReview.getState().bind("sample");

    expect(useReview.getState().history).toEqual([]);
  });

  it("ignores saved data with the wrong shape", () => {
    localStorage.setItem("sightline.review.sample", JSON.stringify([{ detectionId: 1, answer: "maybe" }]));

    useReview.getState().bind("sample");

    expect(useReview.getState().history).toEqual([]);
  });

  it("still works when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    useReview.getState().bind("sample");
    useReview.getState().answer("f0005-d01", "person", 5);

    expect(useReview.getState().answers).toEqual({ "f0005-d01": "person" });
  });
});

describe("useReview demo answers (the guided tour)", () => {
  beforeEach(fresh);

  it("shows a demo answer live but never saves it, then restores the reviewer's own history", () => {
    useReview.getState().bind("sample");
    useReview.getState().answer("f0005-d01", "not_person", 5);
    const saved = localStorage.getItem("sightline.review.sample");

    useReview.getState().beginDemo();
    useReview.getState().answer("f0012-d01", "person", 6);
    expect(useReview.getState().answers).toEqual({ "f0005-d01": "not_person", "f0012-d01": "person" });
    expect(localStorage.getItem("sightline.review.sample")).toBe(saved);

    useReview.getState().endDemo();
    expect(useReview.getState().history).toEqual([{ detectionId: "f0005-d01", answer: "not_person", at: 5 }]);
    expect(useReview.getState().demoSaved).toBeNull();
    expect(localStorage.getItem("sightline.review.sample")).toBe(saved);

    // Back to normal: answers are saved again.
    useReview.getState().answer("f0012-d01", "unsure", 7);
    expect(JSON.parse(localStorage.getItem("sightline.review.sample") as string)).toHaveLength(2);
  });

  it("keeps the demo when a screen re-binds the same survey, and drops it for another survey", () => {
    useReview.getState().bind("sample");
    useReview.getState().beginDemo();
    useReview.getState().answer("f0012-d01", "person", 6);

    useReview.getState().bind("sample");
    expect(useReview.getState().answers).toEqual({ "f0012-d01": "person" });

    useReview.getState().bind("seymour-demo");
    expect(useReview.getState().demoSaved).toBeNull();
    expect(useReview.getState().history).toEqual([]);
    expect(localStorage.getItem("sightline.review.sample")).toBeNull();
  });

  it("beginDemo twice keeps the first snapshot; endDemo without a demo does nothing", () => {
    useReview.getState().answer("a", "person", 1);
    useReview.getState().endDemo();
    expect(useReview.getState().history).toHaveLength(1);
    useReview.getState().beginDemo();
    useReview.getState().answer("b", "person", 2);
    useReview.getState().beginDemo();
    useReview.getState().endDemo();
    expect(useReview.getState().history.map((h) => h.detectionId)).toEqual(["a"]);
  });
});
