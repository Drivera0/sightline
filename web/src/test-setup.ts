import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);
// what the console remembers per browser (the timeline's filter and height, the one-time clue hint) starts
// fresh in every test
afterEach(() => {
  for (const k of ["sightline.timelineFilter", "sightline.timelineHeight", "sightline.clueHint"]) {
    try {
      globalThis.localStorage?.removeItem(k);
    } catch {
      /* no storage */
    }
  }
});
