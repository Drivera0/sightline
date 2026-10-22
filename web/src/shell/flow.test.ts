import { describe, expect, it } from "vitest";
import { DEMO, DEMO_CONSOLE_HASH, REDIRECTS, redirectFromHash, routeFromHash, viewHash, VIEWS } from "./flow";

describe("routes: one console", () => {
  it("lands on the demo mission's console (the story's t0)", () => {
    expect(redirectFromHash("")).toBe(DEMO);
    expect(redirectFromHash("#")).toBe(DEMO);
    expect(routeFromHash("")).toEqual({ kind: "mission", id: "demo", view: null, t: null, open: {} });
  });

  it("reads a checkpoint of the story and a view of a mission", () => {
    expect(routeFromHash("#m/demo?t=3")).toEqual({ kind: "mission", id: "demo", view: null, t: 3, open: {} });
    expect(routeFromHash("#m/demo/review?t=2")).toEqual({ kind: "mission", id: "demo", view: "review", t: 2, open: {} });
    expect(routeFromHash("#m/0a1b2c3d/debrief")).toEqual({ kind: "mission", id: "0a1b2c3d", view: "debrief", t: null, open: {} });
    expect(routeFromHash("#m/0a1b2c3d/map?t=2")).toMatchObject({ t: null }); // a live mission has no story clock
    expect(routeFromHash("#m/demo?t=9")).toMatchObject({ t: null });
    expect(routeFromHash("#m/0a1b2c3d/radio")).toMatchObject({ view: "radio" }); // phones
  });

  it("knows New search, About and a sector's card", () => {
    expect(routeFromHash("#new")).toEqual({ kind: "new" });
    expect(routeFromHash("#about")).toEqual({ kind: "about" });
    expect(routeFromHash("#m/0a1b2c3d/card/B3")).toEqual({ kind: "card", id: "0a1b2c3d", sector: "B3" });
  });

  it("opens the Conditions panel, the event log, For judges and Try a photo from the address", () => {
    expect(routeFromHash("#m/demo/map/conditions")).toMatchObject({ open: { conditions: true } });
    expect(routeFromHash("#m/demo/trace?log")).toMatchObject({ open: { log: true } });
    expect(routeFromHash("#m/demo/debrief?judges")).toMatchObject({ open: { judges: true } });
    expect(routeFromHash("#m/demo/photos?try")).toMatchObject({ open: { try: true } });
  });

  it("keeps every old address as a redirect to its place in the console", () => {
    expect(REDIRECTS).toMatchObject({
      "#survey": "#m/demo?t=1",
      "#rank": "#m/demo?t=1",
      "#review": "#m/demo?t=2",
      "#search": "#m/demo?t=3",
      "#searchnext": "#m/demo?t=3",
      "#results": "#m/demo?t=5",
      "#operate": DEMO_CONSOLE_HASH,
      "#command": DEMO_CONSOLE_HASH,
      "#judges": "#m/demo?t=5&judges",
      "#try": "#m/demo/photos?try",
    });
    expect(redirectFromHash("#m/demo/command")).toBe("#m/demo/map");
    expect(redirectFromHash("#m/demo/command/conditions")).toBe("#m/demo/map/conditions");
    expect(redirectFromHash("#m/0a1b2c3d/approvals")).toBe("#m/0a1b2c3d/map");
    expect(redirectFromHash("#m/0a1b2c3d/feed")).toBe("#m/0a1b2c3d/trace?log");
    expect(redirectFromHash("#m/demo/map")).toBeNull();
    for (const [from, to] of Object.entries(REDIRECTS)) expect(routeFromHash(from)).toEqual(routeFromHash(to));
  });

  it("writes a view's address, with the demo's clock when it isn't now", () => {
    expect(viewHash("demo", "photos", 1)).toBe("#m/demo/photos?t=1");
    expect(viewHash("demo", "map")).toBe("#m/demo/map");
    expect(viewHash("0a1b2c3d", "review", 2)).toBe("#m/0a1b2c3d/review");
    expect(VIEWS.map((v) => v.label)).toEqual(["Map", "Photos", "Review", "Trace", "Debrief"]);
  });
});
