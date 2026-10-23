import { describe, expect, it } from "vitest";
import { atBaseText, layoutPointLabels, leaderEnd, leaderStart, LABEL_RINGS_PX, type PointLabelInput, teamsAtBase } from "./pointLabels";

const view = { left: 0, top: 0, right: 800, bottom: 540 };
const overlap = (a: { left: number; top: number; right: number; bottom: number }, b: typeof a) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

describe("the live map's point labels", () => {
  // the console's centre at t4: the find, the last known point, three clues, a team and a drone within 60 px
  const labels: PointLabelInput[] = [
    { id: "clue:c002", kind: "clue", text: "c002 track", at: { x: 360, y: 280 } },
    { id: "team:T3", kind: "team", text: "T3", at: { x: 420, y: 300 } },
    { id: "found", kind: "found", text: "Found by Team One in C2", at: { x: 400, y: 260 }, size: 12, required: true },
    { id: "lkp", kind: "lkp", text: "Last known point", at: { x: 390, y: 290 }, required: true },
    { id: "clue:c003", kind: "clue", text: "c003 object", at: { x: 410, y: 320 } },
    { id: "drone:D2", kind: "drone", text: "D2 88%", at: { x: 380, y: 330 }, size: 11.5 },
  ];
  const icons = labels.map((l) => l.at);

  it("never puts a label over another label or over another mark", () => {
    const placed = layoutPointLabels(labels, icons, view);
    const boxes = [...placed.values()];
    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) expect(overlap(a.box, b.box), `${a.id} / ${b.id}`).toBe(false);
      const own = labels.find((l) => l.id === a.id)!.at;
      for (const p of icons.filter((p) => p !== own)) {
        expect(overlap(a.box, { left: p.x - 10, top: p.y - 10, right: p.x + 10, bottom: p.y + 10 }), `${a.id} over a mark`).toBe(false);
      }
    }
  });

  it("places in priority order: the find first, next to its mark; the last known point always shows", () => {
    const placed = layoutPointLabels(labels, icons, view);
    expect(placed.get("found")?.displaced).toBe(false);
    expect(placed.get("found")?.anchor).toBe("left"); // its first choice: to the right of the mark
    expect(placed.has("lkp")).toBe(true);
    // with no room at all, a clue is left out but the last known point still shows
    const tight = { left: 380, top: 280, right: 400, bottom: 300 };
    const crowded = layoutPointLabels(labels.filter((l) => l.kind === "lkp" || l.kind === "clue"), icons, tight);
    expect(crowded.has("lkp")).toBe(true);
    expect(crowded.has("clue:c002")).toBe(false);
  });

  it("moves a crowded label to the outer ring and says so (the map draws a leader line)", () => {
    // marks all round the first ring of a clue: its label has to go further out
    const at = { x: 400, y: 270 };
    const ring = LABEL_RINGS_PX[0] + 6;
    const around = [-1, 0, 1].flatMap((dx) => [-1, 0, 1].map((dy) => ({ x: at.x + dx * ring, y: at.y + dy * ring }))).filter((p) => p.x !== at.x || p.y !== at.y);
    const placed = layoutPointLabels([{ id: "c", kind: "clue", text: "c1 object", at }], [at, ...around], view);
    const p = placed.get("c");
    expect(p?.displaced).toBe(true);
    const end = leaderEnd(at, p!.box);
    const start = leaderStart(at, end);
    expect(Math.hypot(start.x - at.x, start.y - at.y)).toBeCloseTo(12);
    expect(Math.hypot(end.x - at.x, end.y - at.y)).toBeGreaterThan(12);
  });

  it("keeps labels off the panels over the map", () => {
    const legend = { left: 0, top: 0, right: 500, bottom: 300 };
    const placed = layoutPointLabels([{ id: "lkp", kind: "lkp", text: "Last known point", at: { x: 480, y: 280 } }], [], view, [legend]);
    expect(overlap(placed.get("lkp")!.box, legend)).toBe(false);
  });

  it("stacks the teams waiting at base camp into one chip", () => {
    const camp = { lat: 49.373, lon: -122.949 };
    const teams = [
      { id: "T2", lat: 49.373, lon: -122.949 },
      { id: "T1", lat: 49.37301, lon: -122.94902 },
      { id: "T4", lat: 49.365, lon: -122.94 },
    ];
    const at = teamsAtBase(teams, camp);
    expect(at).toEqual(["T2", "T1"]);
    expect(atBaseText(["T2", "T1", "T10", "T3"])).toBe("T1 T2 T3 T10 at base");
    expect(teamsAtBase(teams, null)).toEqual([]);
  });
});
