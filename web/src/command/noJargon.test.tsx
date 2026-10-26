// The console in plain words (usability test 2026-10-25): what a search manager reads never says triage,
// leg, second look, serpentine, re-task or Promoted, and never shows a detection's id (f0336-d01). The
// Trace keeps the engine's words and ids; it is not on these views. Built by lane A.
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapFile } from "../contract";
import { App } from "../App";
import { useStory } from "./story";
import { diskFetch } from "../lib/diskFetch";
import { EMPTY, useMission } from "../lib/mission";
import { BANNED, flightLineNames, formatPod, plainWords } from "./terms";
import { CHECKPOINTS_ALL } from "./missionTime";

const DEMO_GRID = { origin_nw: { lat: 49.374492, lon: -122.951898 }, cell_m: 5, rows: 200, cols: 200 };
/** The demo cache in tests: the repository's sample cache stands in for it (as in ingest.test.tsx). */
const demoFetch = () => {
  const disk = diskFetch();
  return async (input: RequestInfo | URL) => {
    const url = String(input);
    const r = await disk(url.replace("/cache/demo/", "/cache/sample/"));
    if (!url.endsWith("/cache/demo/map.json") || !r.ok) return r;
    const map = (await r.json()) as MapFile;
    const n = DEMO_GRID.rows * DEMO_GRID.cols;
    return new Response(JSON.stringify({ ...map, grid: DEMO_GRID, prior: { p: new Array(n).fill(0.5 / n), outside: 0.5 }, canopy: new Array(n).fill(null) }), { headers: { "content-type": "application/json" } });
  };
};
const settle = () => new Promise((r) => setTimeout(r, 30));

/** Every banned word or id in the text, with a little context. */
function jargon(text: string): string[] {
  return BANNED.flatMap((re) => [...text.matchAll(new RegExp(re.source, `${re.flags.replace("g", "")}g`))].map((m) => text.slice(Math.max(0, m.index! - 40), m.index! + 40)));
}

describe("the console in plain words", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("never shows the engine's jargon or a detection id, at any point of the demo", async () => {
    vi.stubGlobal("fetch", demoFetch());
    useMission.setState({ ...EMPTY, status: "idle" });
    useStory.getState().reset();
    window.history.replaceState(null, "", "#m/demo/map");
    render(<App base={null} />);
    await screen.findByRole("region", { name: "Timeline" });
    for (const t of CHECKPOINTS_ALL) {
      useStory.getState().seek(t);
      await settle();
      // the ids a "details" disclosure keeps (closed) are for whoever asks; the rest is what is read
      const shown = document.body.cloneNode(true) as HTMLElement;
      for (const el of shown.querySelectorAll("details > :not(summary)")) el.remove();
      expect(jargon(shown.textContent ?? ""), `checkpoint ${t}`).toEqual([]);
    }
  });

  it("rewrites the fixtures' lines: flight lines, the AI re-check, POD in %, no ids", () => {
    const legs = flightLineNames([{ id: "L001", drone_id: "D1" }, { id: "L002", drone_id: "D2" }, { id: "L004", drone_id: "D1" }], (id) => `Drone ${id.slice(1)}`);
    expect(plainWords("Drone 1: leg L001 (sector B2) started", { legs })).toBe("Drone 1 · flight line 1 over B2 started");
    expect(plainWords("L004 approved for Drone 1 (re-task: L001 cancelled)", { legs })).toBe("Drone 1 · flight line 2 approved (sent elsewhere: Drone 1 · flight line 1 cancelled)");
    expect(plainWords("second look on f0396-d01: no")).toBe("AI re-check of a near-miss photo: probably not a person");
    expect(plainWords("Sector B4 searched at POD 60%: its probability lowered by that (by the scenario's search manager)")).toBe("Sector B4 searched at POD 60 %: its probability lowered by that (by the search manager)");
    expect(plainWords("no new evidence; 40% under tree cover (drone POD 0.45)")).toBe("no new evidence; 40% under tree cover (drone POD 45 %)");
    expect(plainWords("The scenario's search manager approved agent p004: Assign sector C3 to Team Three")).toBe("The search manager approved the AI's suggestion: Assign sector C3 to Team Three");
    expect(plainWords("Clue c004 (sound: possible whistle) confirmed from radio turn r0007")).toBe("Clue confirmed from the radio call: sound: possible whistle");
    expect(plainWords("C2 · 3.5 %: c001 (hiker at the lot saw…) and c004 (possible whistle) raised it")).toBe("C2 · 3.5 %: “hiker at the lot saw…” and “possible whistle” raised it");
    expect(plainWords("D2 link lost: it flies its approved leg on its own")).toBe("Drone 2 link lost: it flies its approved flight line on its own");
    expect(plainWords("Team Two: a cut on his leg, over.")).toBe("Team Two: a cut on his leg, over."); // a person's leg stays
    expect(formatPod(0.6)).toBe("60 %");
    expect(formatPod(45)).toBe("45 %");
  });
});
