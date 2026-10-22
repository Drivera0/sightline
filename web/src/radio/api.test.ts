import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkUrl, getOutbound, postTurn, skip, transmit } from "./api";

const API = { base: "http://radio.test", missionId: "demo0001" };

afterEach(() => vi.unstubAllGlobals());

function captureFetch() {
  const calls: { url: string; body: FormData }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as FormData });
      return new Response(JSON.stringify({ id: "r0001", audio_chunks: [] }), { status: 200 });
    }),
  );
  return calls;
}

describe("radio api", () => {
  it("text and audio turns post the same multipart shape (LANE_E §9 test 7)", async () => {
    const calls = captureFetch();
    await postTurn(API, { text: "Sightline, Team Two, over." }, "T2");
    await postTurn(API, { audio: new Blob(["x"], { type: "audio/webm" }) }, "T2");
    expect(calls.map((c) => c.url)).toEqual([
      "http://radio.test/missions/demo0001/radio/turn",
      "http://radio.test/missions/demo0001/radio/turn",
    ]);
    expect(calls[0]!.body.get("text")).toBe("Sightline, Team Two, over.");
    expect(calls[0]!.body.get("callsign_hint")).toBe("T2");
    expect(calls[1]!.body.get("audio")).toBeInstanceOf(Blob);
    expect(calls[1]!.body.get("mime")).toBe("audio/webm");
    expect(calls[1]!.body.get("callsign_hint")).toBe("T2");
  });

  it("errors carry the API's detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "send either audio or text" }), { status: 422 })));
    await expect(postTurn(API, { text: "" })).rejects.toThrow("send either audio or text");
  });

  it("chunk paths resolve against the API base", () => {
    expect(chunkUrl(API, "/missions/m/radio/audio/r0001-0.wav")).toBe("http://radio.test/missions/m/radio/audio/r0001-0.wav");
  });

  it("writes carry the write token, reads don't", async () => {
    const headers: (HeadersInit | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        headers.push(init?.headers);
        return new Response(JSON.stringify([]), { status: 200 });
      }),
    );
    const api = { ...API, token: "t0k" };
    await postTurn(api, { text: "Sightline, Team Two, over." });
    await transmit(api, "p1");
    await skip(api, "p1");
    await getOutbound(api);
    await postTurn({ ...API, token: null }, { text: "Sightline, Team Two, over." });
    const bearer = { Authorization: "Bearer t0k" };
    expect(headers).toEqual([bearer, bearer, bearer, undefined, {}]);
  });
});
