import { describe, expect, it, vi } from "vitest";

import { ApiError, apiToken, authHeaders, createMission, getState, uploadPhotos, type Api } from "./api";

function recorder(status = 200, body: unknown = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  });
  return { calls, fetch: f as unknown as typeof fetch };
}

const lkp = { lat: 49.375, lon: -122.9375 };

describe("write token", () => {
  it("reads VITE_API_TOKEN, blank means none", () => {
    expect(apiToken({ VITE_API_TOKEN: " t0k " })).toBe("t0k");
    expect(apiToken({ VITE_API_TOKEN: "  " })).toBeNull();
    expect(apiToken({})).toBeNull();
  });

  it("goes on writes only", () => {
    const api: Api = { base: "", token: "t0k" };
    expect(authHeaders(api, "POST")).toEqual({ Authorization: "Bearer t0k" });
    expect(authHeaders(api, "PATCH")).toEqual({ Authorization: "Bearer t0k" });
    expect(authHeaders(api, "GET")).toEqual({});
    expect(authHeaders({ base: "", token: null }, "POST")).toEqual({});
  });

  it("is sent with JSON writes and uploads, not with reads", async () => {
    const r = recorder();
    const api: Api = { base: "https://api.test", fetch: r.fetch, token: "t0k" };
    await createMission(api, { name: "Seymour", area_name: "Mount Seymour", lkp });
    await getState(api, "m1");
    await uploadPhotos(api, "m1", [new File(["x"], "a.jpg")]);
    expect(r.calls.map((c) => c.init.headers)).toEqual([
      { Authorization: "Bearer t0k", "Content-Type": "application/json" },
      undefined,
      { Authorization: "Bearer t0k" },
    ]);
  });

  it("without a token, requests are as before", async () => {
    const r = recorder();
    const api: Api = { base: "", fetch: r.fetch, token: null };
    await createMission(api, { name: "Seymour", area_name: "Mount Seymour", lkp });
    expect(r.calls.map((c) => c.init.headers)).toEqual([{ "Content-Type": "application/json" }]);
  });

  it("a 401 surfaces the API's plain message", async () => {
    const r = recorder(401, { detail: "wrong API token" });
    const api: Api = { base: "", fetch: r.fetch, token: "bad" };
    await expect(createMission(api, { name: "S", area_name: "A", lkp })).rejects.toEqual(
      new ApiError(401, "wrong API token"),
    );
  });
});
