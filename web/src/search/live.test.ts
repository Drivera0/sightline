// C-H1: the TS live map agrees with Python's LiveMap.apply on the shared vectors (1e-9).
import { describe, expect, it } from "vitest";
import type { MapBase, MapUpdate } from "../contract";
import vectors from "./__fixtures__/update_vectors.json";
import { applyReweight, CHECKPOINT_EVERY, LiveHeat, lookedAt, replayLive } from "./live";

interface LiveCase {
  name: string;
  base: MapBase;
  updates: MapUpdate[];
  after: { p: number[]; outside: number }[];
}
const cases = (vectors as unknown as { live_cases: LiveCase[] }).live_cases;

function close(a: { p: ArrayLike<number>; outside: number }, b: { p: number[]; outside: number }) {
  let worst = Math.abs(a.outside - b.outside);
  for (let i = 0; i < b.p.length; i++) worst = Math.max(worst, Math.abs((a.p[i] as number) - (b.p[i] as number)));
  expect(worst).toBeLessThan(1e-9);
}

describe("replayLive matches LiveMap.apply", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_, c) => {
    expect(new Set(c.updates.map((u) => u.kind))).toEqual(new Set(["step", "reweight"]));
    c.after.forEach((want, k) => close(replayLive(c.base, c.updates, k + 1), want));
  });
});

describe("LiveHeat", () => {
  const c = cases[0] as LiveCase;

  it("applies new updates as they arrive and agrees with a full replay", () => {
    const heat = new LiveHeat(c.base);
    for (let k = 1; k <= c.updates.length; k += 7) close(heat.sync(c.updates.slice(0, k)), c.after[k - 1]!);
    close(heat.sync(c.updates), c.after.at(-1)!);
    expect(heat.seq).toBe(c.updates.length);
  });

  it("restarts from the nearest checkpoint when the log is replaced", () => {
    const heat = new LiveHeat(c.base);
    heat.sync(c.updates);
    const edited = c.updates.map((u) => (u.seq === CHECKPOINT_EVERY + 2 ? { ...u, cells: [] as [number, number][] } : u));
    const want = replayLive(c.base, edited);
    close(heat.sync(edited), { p: [...want.p], outside: want.outside });
    const fresh = new LiveHeat(c.base);
    close(fresh.sync(c.updates.slice(0, 3)), c.after[2]!);
    close(fresh.sync([]), { p: [...c.base.prior.p], outside: c.base.prior.outside }); // a new, empty log
  });

  it("rejects a factor outside (0, 20] and marks looked-at cells", () => {
    expect(() => applyReweight({ p: new Float64Array([0.5, 0.5]), outside: 0 }, [[0, 21]])).toThrow();
    const looked = lookedAt(c.base, c.updates);
    const stepped = new Set(c.updates.filter((u) => u.kind === "step").flatMap((u) => u.cells.map(([i]) => i)));
    expect([...looked].reduce((a, b) => a + b, 0)).toBe(stepped.size);
  });
});
