// LANE_E §9 test 6 (front door) and test 1 (no "clear" except the allowlisted negation).
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { routeFromHash } from "../shell/flow";
import { CLEAR_ALLOWLIST, FOOTER, HERO, HOW_IT_WORKS, PRINCIPLES, ROADMAP, WHO_ITS_FOR } from "./copy";
import { FrontDoor } from "./FrontDoor";

describe("FrontDoor", () => {
  it("is the default route", () => {
    expect(routeFromHash("")).toEqual({ kind: "front" });
    expect(routeFromHash("#")).toEqual({ kind: "front" });
    expect(routeFromHash("#survey")).toEqual({ kind: "demo" });
  });

  it("renders all the copy, says how photos get in and when it runs, and its buttons work", async () => {
    const onStartNew = vi.fn();
    const onWatchDemo = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<FrontDoor onStartNew={onStartNew} onWatchDemo={onWatchDemo} />);
    const text = document.body.textContent ?? "";
    for (const s of [HERO.tagline, HERO.body, HERO.honesty, ...HOW_IT_WORKS.flatMap((x) => [x.title, x.body]), ...WHO_ITS_FOR.flatMap((x) => [x.title, x.body]), ...PRINCIPLES.flatMap((x) => [x.title, x.body]), ...ROADMAP, FOOTER.data]) {
      expect(text).toContain(s);
    }
    expect(text).toMatch(/straight from the SD card/); // how photos get in, after landing
    expect(text).toMatch(/during the flight/); // or live
    await userEvent.click(screen.getByRole("button", { name: HERO.start }));
    await userEvent.click(screen.getByRole("button", { name: HERO.demo }));
    expect(onStartNew).toHaveBeenCalledOnce();
    expect(onWatchDemo).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled(); // works offline
    expect(screen.getAllByRole("img")).toHaveLength(4); // the four line drawings, inline
  });

  it('says "clear" only in the allowlisted negation', () => {
    render(<FrontDoor onStartNew={() => {}} onWatchDemo={() => {}} />);
    let text = document.body.textContent ?? "";
    for (const ok of CLEAR_ALLOWLIST) text = text.replaceAll(ok, "");
    expect(text).not.toMatch(/\bclear(ed)?\b/i);
  });
});
