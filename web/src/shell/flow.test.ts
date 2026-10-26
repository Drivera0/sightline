import { describe, expect, it } from "vitest";
import { DEMO, DEMO_CONSOLE_HASH, DEMO_END_HASH, guideHash, HOME, REDIRECTS, redirectFromHash, routeFromHash, scenarioHash, viewHash, VIEWS } from "./flow";

describe("routes: one console", () => {
  it("opens the home page at the root and on an unknown address; the console is at #m/demo", () => {
    expect(redirectFromHash("")).toBeNull();
    expect(redirectFromHash("#")).toBeNull();
    expect(routeFromHash("")).toEqual({ kind: "home" });
    expect(routeFromHash(HOME)).toEqual({ kind: "home" });
    expect(routeFromHash("#nowhere")).toEqual({ kind: "home" });
    expect(routeFromHash(DEMO)).toEqual({ kind: "mission", id: "demo", view: null, t: null, open: {} });
  });

  it("opens a scenario with its guided simulation on, or just the console", () => {
    expect(scenarioHash("missing-child")).toBe("#m/demo?s=missing-child&guide=1");
    expect(routeFromHash(scenarioHash("missing-child"))).toEqual({ kind: "mission", id: "demo", view: null, t: null, open: { guide: true }, seed: "missing-child" });
    expect(scenarioHash("dementia", false)).toBe("#m/demo/map?s=dementia");
    expect(routeFromHash(scenarioHash("dementia", false))).toEqual({ kind: "mission", id: "demo", view: "map", t: null, open: { free: true }, seed: "dementia" });
    // free play is only the plain console address (a seed at most); checkpoints and opened panels keep their old meaning
    expect(routeFromHash(DEMO_CONSOLE_HASH)).toEqual({ kind: "mission", id: "demo", view: "map", t: null, open: { free: true } });
    expect(routeFromHash(DEMO_END_HASH)).toEqual({ kind: "mission", id: "demo", view: "map", t: 6, open: {} });
    expect(routeFromHash("#m/demo/map?t=0")).toMatchObject({ open: {} });
    expect(routeFromHash("#m/demo/map?needs")).toMatchObject({ open: { needs: true } });
    expect(routeFromHash("#m/demo/map/conditions")).toMatchObject({ open: { conditions: true } });
    expect(routeFromHash("#m/demo/photos")).toMatchObject({ open: {} });
    expect(routeFromHash("#m/0a1b2c3d/map")).toMatchObject({ open: {} }); // a live mission is never free play
    for (const h of ["#m/demo/map?t=0", "#m/demo/map?needs", "#m/demo/map/conditions", "#m/demo/photos", "#m/0a1b2c3d/map", "#m/demo", "#m/demo?guide=1"])
      expect((routeFromHash(h) as { open: object }).open).not.toHaveProperty("free");
    expect(routeFromHash("#m/0a1b2c3d/map?guide=1")).toEqual({ kind: "mission", id: "0a1b2c3d", view: "map", t: null, open: {} }); // only the demo has a guide
  });

  it("reads a checkpoint of the story and a view of a mission", () => {
    expect(routeFromHash("#m/demo?t=3")).toEqual({ kind: "mission", id: "demo", view: null, t: 3, open: {} });
    expect(routeFromHash("#m/demo/photos?t=2")).toEqual({ kind: "mission", id: "demo", view: "photos", t: 2, open: {} });
    expect(routeFromHash("#m/0a1b2c3d/debrief")).toEqual({ kind: "mission", id: "0a1b2c3d", view: "debrief", t: null, open: {} });
    expect(routeFromHash("#m/0a1b2c3d/map?t=2")).toMatchObject({ t: null }); // a live mission has no story clock
    expect(routeFromHash("#m/demo?t=9")).toMatchObject({ t: null });
    expect(routeFromHash("#m/0a1b2c3d/radio")).toMatchObject({ view: "map", open: { radio: true } }); // the talk bar
  });

  it("knows New search, About (a section of the home page now) and a sector's card", () => {
    expect(routeFromHash("#new")).toEqual({ kind: "new" });
    expect(routeFromHash("#about")).toEqual({ kind: "home", section: "about" });
    expect(redirectFromHash("#about")).toBeNull(); // the address stays: a bookmark lands on the same section
    expect(routeFromHash("#")).toEqual({ kind: "home" });
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
      "#results": "#m/demo?t=6",
      "#operate": DEMO_CONSOLE_HASH,
      "#command": DEMO_CONSOLE_HASH,
      "#judges": "#m/demo?t=6&judges",
      "#m/demo?t=5&judges": "#m/demo?t=6&judges",
      "#try": "#m/demo/photos?try",
    });
    expect(redirectFromHash("#m/demo/command")).toBe("#m/demo/map");
    expect(redirectFromHash("#m/demo/command/conditions")).toBe("#m/demo/map/conditions");
    expect(redirectFromHash("#m/0a1b2c3d/approvals")).toBe("#m/0a1b2c3d/map");
    expect(redirectFromHash("#m/0a1b2c3d/feed")).toBe("#m/0a1b2c3d/trace?log");
    // the review folds into Needs you, the radio desk into the timeline's talk bar: both land on the console
    expect(redirectFromHash("#m/0a1b2c3d/review")).toBe("#m/0a1b2c3d/map?needs");
    expect(redirectFromHash("#m/demo/radio?t=2")).toBe("#m/demo/map?needs&t=2".replace("needs", "radio"));
    expect(routeFromHash("#m/0a1b2c3d/review")).toMatchObject({ view: "map", open: { needs: true } });
    expect(routeFromHash("#m/demo/radio")).toMatchObject({ view: "map", open: { radio: true } });
    expect(routeFromHash("#m/demo?s=missing-child")).toMatchObject({ seed: "missing-child" });
    // the guided search on the default scenario or a named one
    expect(routeFromHash(guideHash("dementia"))).toMatchObject({ seed: "dementia", open: { guide: true } });
    expect(routeFromHash(guideHash())).toMatchObject({ id: "demo", open: { guide: true } });
    expect(redirectFromHash("#m/demo/map")).toBeNull();
    for (const [from, to] of Object.entries(REDIRECTS)) expect(routeFromHash(from)).toEqual(routeFromHash(to));
  });

  it("writes a view's address, with the demo's clock when it isn't now", () => {
    expect(viewHash("demo", "photos", 1)).toBe("#m/demo/photos?t=1");
    expect(viewHash("demo", "map")).toBe("#m/demo/map");
    expect(viewHash("0a1b2c3d", "trace", 2)).toBe("#m/0a1b2c3d/trace");
    expect(VIEWS.map((v) => v.label)).toEqual(["Map", "Photos", "Trace", "Debrief"]);
  });
});
