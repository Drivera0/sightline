import { describe, expect, it } from "vitest";
import { isTyping } from "./keys";

const make = (html: string): HTMLElement => {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.firstElementChild as HTMLElement;
};

describe("isTyping", () => {
  it.each(["<input />", "<textarea></textarea>", "<select><option>a</option></select>"])(
    "is true for %s",
    (html) => {
      expect(isTyping(make(html))).toBe(true);
    },
  );

  it("is true for an editable element and for a child inside one", () => {
    const editable = make('<div contenteditable="true"><b>text</b></div>');

    expect(isTyping(editable)).toBe(true);
    expect(isTyping(editable.querySelector("b"))).toBe(true);
  });

  it("is false for an element that is explicitly not editable", () => {
    expect(isTyping(make('<div contenteditable="false">x</div>'))).toBe(false);
  });

  it.each(["<button>go</button>", "<div>plain</div>", "<a href='#'>link</a>"])(
    "is false for %s, so shortcut keys still work after a click on it",
    (html) => {
      expect(isTyping(make(html))).toBe(false);
    },
  );

  it("is false for the document body and for no target", () => {
    expect(isTyping(document.body)).toBe(false);
    expect(isTyping(null)).toBe(false);
  });

  it("is false for a target that is not an element, such as window", () => {
    expect(isTyping(window)).toBe(false);
  });
});
