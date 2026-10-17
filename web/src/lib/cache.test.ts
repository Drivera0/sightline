import { beforeEach, describe, expect, it } from "vitest";
import { CacheLoadError, loadCache, useCache } from "./cache";
import { diskFetch } from "./diskFetch";

const notFound = () => new Response("nope", { status: 404 });

describe("loadCache", () => {
  it("loads the five contract files of the sample cache", async () => {
    const cache = await loadCache("sample", diskFetch());

    expect(cache.survey.frames).toHaveLength(20);
    expect(cache.manifest.survey_id).toBe("sample");
    expect(cache.detections.frames["f0005"]?.[0]?.conf).toBeCloseTo(0.874);
    expect(cache.map.grid.rows * cache.map.grid.cols).toBe(2500);
    expect(cache.metrics.baseline_human.seconds_per_image).toBe(33);
  });

  it("requests files from /cache/<dir>/", async () => {
    const seen: string[] = [];
    const fetchSpy: typeof fetch = async (input, init) => {
      seen.push(String(input));
      return diskFetch()(input, init);
    };

    await loadCache("sample", fetchSpy);

    expect(seen.sort()).toEqual(
      ["manifest", "survey", "detections", "map", "metrics"].map((n) => `/cache/sample/${n}.json`).sort(),
    );
  });

  it("names the missing file and folder when a request fails", async () => {
    const fetchMissing = diskFetch({ "/cache/sample/map.json": notFound });

    await expect(loadCache("sample", fetchMissing)).rejects.toThrow(
      /map\.json.*404.*\/cache\/sample\//,
    );
  });

  it("reports a folder that does not exist", async () => {
    await expect(loadCache("demo", diskFetch())).rejects.toBeInstanceOf(CacheLoadError);
  });

  it("rejects a file that is not JSON", async () => {
    const fetchBroken = diskFetch({ "/cache/sample/survey.json": () => new Response("<html>") });

    await expect(loadCache("sample", fetchBroken)).rejects.toThrow(/survey\.json.*not valid JSON/);
  });

  it("rejects a contract version the app does not understand", async () => {
    const fetchNew = diskFetch({
      "/cache/sample/metrics.json": () => new Response(JSON.stringify({ contract_version: "2.0" })),
    });

    await expect(loadCache("sample", fetchNew)).rejects.toThrow(/metrics\.json.*contract_version/);
  });

  it("reports a network failure with the file name", async () => {
    const offline: typeof fetch = async () => {
      throw new TypeError("Failed to fetch");
    };

    await expect(loadCache("sample", offline)).rejects.toThrow(/manifest\.json.*Failed to fetch/);
  });
});

describe("useCache", () => {
  beforeEach(() => useCache.getState().reset());

  it("starts idle", () => {
    expect(useCache.getState()).toMatchObject({ status: "idle", data: null, error: null });
  });

  it("goes loading, then ready with the data", async () => {
    const pending = useCache.getState().load("sample", diskFetch());
    expect(useCache.getState().status).toBe("loading");

    await pending;

    const state = useCache.getState();
    expect(state.status).toBe("ready");
    expect(state.data?.survey.frames).toHaveLength(20);
    expect(state.error).toBeNull();
  });

  it("goes to error with a readable message", async () => {
    await useCache.getState().load("demo", diskFetch());

    const state = useCache.getState();
    expect(state.status).toBe("error");
    expect(state.error).toMatch(/manifest\.json/);
    expect(state.data).toBeNull();
  });

  it("ignores a slower, older load when a newer one has started", async () => {
    const slow: typeof fetch = (input, init) =>
      new Promise((resolve) => setTimeout(() => resolve(diskFetch()(input, init)), 30));
    const first = useCache.getState().load("sample", slow);
    const second = useCache.getState().load("demo", diskFetch());

    await Promise.all([first, second]);

    expect(useCache.getState().status).toBe("error");
  });
});

describe("useCache folder", () => {
  beforeEach(() => useCache.getState().reset());

  it("remembers which folder it loaded, for building image URLs", async () => {
    await useCache.getState().load("sample", diskFetch());

    expect(useCache.getState().dir).toBe("sample");
  });

  it("forgets the folder on reset", async () => {
    await useCache.getState().load("sample", diskFetch());

    useCache.getState().reset();

    expect(useCache.getState().dir).toBeNull();
  });
});
