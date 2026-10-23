// The colour tokens' text contrast, both themes (WCAG 2.x relative luminance). Read by
// check-contrast.mjs (the command line) and contrast.test.ts (the tests). Every text token must be at
// least 4.5:1 on each background a text sits on: the page (--bg), an opaque panel (--surface-solid), a
// hovered or selected row (--surface-strong over --surface-solid) and its own status pill (10% of itself
// over --bg, theme.css .sl-pill). Fills (--searched, the probability ramp) are not text and are not checked.
import { readFileSync } from "node:fs";

/** Text tokens: each is read as text somewhere. */
export const TEXT_TOKENS = ["text", "text-2", "text-3", "accent", "accent-soft", "ok", "warn", "caution", "alert", "team", "drone", "clue", "proposal", "found"];
/** Tokens that are drawn as pills (their own colour on a 10% tint of itself). */
const PILL_TOKENS = ["text-2", "text-3", "accent", "ok", "caution", "alert", "team", "drone", "clue", "proposal", "found"];

/** The tokens of one block (`:root {` or `:root[data-theme="light"] {`) of theme.css. */
export function tokens(css, selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(start, css.indexOf("}", start));
  const out = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

/** "#rrggbb" or "rgba(r, g, b, a)" → [r, g, b, a] (0..255, alpha 0..1). */
export function parse(c) {
  const hex = /^#([0-9a-f]{6})$/i.exec(c);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1);
  const rgba = /^rgba?\(([^)]+)\)$/.exec(c);
  if (rgba) {
    const [r, g, b, a = "1"] = rgba[1].split(",").map((x) => x.trim());
    return [Number(r), Number(g), Number(b), Number(a)];
  }
  throw new Error(`not a colour: ${c}`);
}

/** `top` over `under` (opaque). */
export function over(top, under) {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1);
}

const lin = (v) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export function ratio(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Every (text, background) pair of one theme, with its ratio. */
export function pairs(t) {
  const bg = parse(t.bg);
  const panel = parse(t["surface-solid"]);
  const backs = { bg, "surface-solid": panel, "surface-strong": over(parse(t["surface-strong"]), panel) };
  const rows = [];
  for (const name of TEXT_TOKENS) {
    const fg = parse(t[name]);
    for (const [back, c] of Object.entries(backs)) rows.push({ text: name, on: back, ratio: ratio(fg, c) });
    if (PILL_TOKENS.includes(name)) rows.push({ text: name, on: "its pill", ratio: ratio(fg, over([...fg.slice(0, 3), 0.1], bg)) });
  }
  rows.push({ text: "on-accent", on: "accent", ratio: ratio(parse(t["on-accent"]), parse(t.accent)) });
  return rows;
}

/** Both themes from theme.css: { dark: rows, light: rows }. The light block only overrides colours. */
export function themes(path) {
  const css = readFileSync(path, "utf8");
  const dark = tokens(css, ":root");
  const light = { ...dark, ...tokens(css, ':root[data-theme="light"]') };
  return { dark: pairs(dark), light: pairs(light) };
}
