import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { CacheBundle } from "../contract";
import { CacheContext, loadCache, useBundle, useCache } from "./cache";
import { diskFetch } from "./diskFetch";

function SurveyId() {
  return <p>{useBundle().survey.survey_id}</p>;
}

describe("useBundle", () => {
  let bundle: CacheBundle;

  beforeEach(async () => {
    useCache.getState().reset();
    bundle = await loadCache("sample", diskFetch());
  });

  it("returns the cache given by a CacheContext provider, with nothing in the store", () => {
    render(
      <CacheContext.Provider value={bundle}>
        <SurveyId />
      </CacheContext.Provider>,
    );

    expect(screen.getByText("sample")).toBeInTheDocument();
  });

  it("prefers the provider over the store", async () => {
    await useCache.getState().load("sample", diskFetch());
    const other = structuredClone(bundle);
    other.survey.survey_id = "from-provider";

    render(
      <CacheContext.Provider value={other}>
        <SurveyId />
      </CacheContext.Provider>,
    );

    expect(screen.getByText("from-provider")).toBeInTheDocument();
  });

  it("falls back to the loaded store when there is no provider", async () => {
    await useCache.getState().load("sample", diskFetch());

    render(<SurveyId />);

    expect(screen.getByText("sample")).toBeInTheDocument();
  });

  it("still throws a clear error when there is neither a provider nor a loaded store", () => {
    const quiet = () => {};
    const original = console.error;
    console.error = quiet; // React logs the thrown render error
    try {
      expect(() => render(<SurveyId />)).toThrow(/before the cache finished loading/);
    } finally {
      console.error = original;
    }
  });
});
