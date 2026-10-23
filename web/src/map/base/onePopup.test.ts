// One popup at a time (V3 §2, the c001/c002 overlap): opening a pin's popup closes the one before and the
// sector popover; it opens anchored to the pin; a popup closed by its own × is forgotten.
import { describe, expect, it, vi } from "vitest";
import { OnePopup, type PopupLike } from "./onePopup";

function fakes() {
  const open: Fake[] = [];
  class Fake implements PopupLike {
    at: [number, number] | null = null;
    text = "";
    closers: (() => void)[] = [];
    setLngLat(at: [number, number]) {
      this.at = at;
      return this;
    }
    setDOMContent(el: Node) {
      this.text = el.textContent ?? "";
      return this;
    }
    addTo() {
      open.push(this);
      return this;
    }
    remove() {
      const i = open.indexOf(this);
      if (i >= 0) open.splice(i, 1);
      this.closers.forEach((fn) => fn());
      return this;
    }
    on(_: "close", fn: () => void) {
      this.closers.push(fn);
      return this;
    }
  }
  return { open, make: () => new Fake() };
}

describe("OnePopup", () => {
  it("never shows two popups: the second pin's closes the first", () => {
    const f = fakes();
    const closeSector = vi.fn();
    const one = new OnePopup(f.make, {}, closeSector);
    one.open("clue:c001", [-122.944, 49.37], "c001 object: jacket");
    one.open("clue:c002", [-122.9441, 49.3701], "c002 track: boot print");
    expect(f.open).toHaveLength(1);
    expect(f.open[0]).toMatchObject({ at: [-122.9441, 49.3701], text: "c002 track: boot print" });
    expect(one.key).toBe("clue:c002");
    expect(closeSector).toHaveBeenCalledTimes(2); // and the sector popover goes each time
  });

  it("forgets a popup closed by its own close button, and close() closes it", () => {
    const f = fakes();
    const one = new OnePopup(f.make, {});
    one.open("clue:c001", [0, 0], "x");
    (f.open[0] as unknown as PopupLike).remove();
    expect(one.isOpen).toBe(false);
    expect(one.key).toBeNull();
    one.open("clue:c003", [0, 0], "y");
    one.close();
    expect(f.open).toHaveLength(0);
  });
});
