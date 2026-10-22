// LANE_D §6 test 10 / LANE_E §9 test 1: no UI string says an area is "clear" or "cleared". Every visible
// use of the words (clear, clears, cleared, clearing) in web/src (string literals and JSX text; comments and code names don't count) must
// be on this reviewed list; a new one fails until someone reads it and adds it here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ALLOWED: readonly string[] = [
  "Sightline never marks an area clear.", // front door, Principle 1 (a negation)
  "Review cleared", // the reviewer's saved answers were reset, not an area
  "Clear the answers saved in this browser for this survey", // same: a button's tooltip
  "as cleared: send a ground team to check.", // "… not counted as cleared: …"
  "unsearched, not cleared.", // a negation
  "never marks ground as cleared.", // a negation
];

const ROOT = join(__dirname);
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "__fixtures__" ? [] : files(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

/** The visible text in a source file: string literals and JSX text, without comments. */
export function visibleText(src: string): string[] {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const out: string[] = [];
  for (const m of noComments.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\\n]|\\.)*)`/g)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  for (const m of noComments.matchAll(/>([^<>{}]+)</g)) {
    const t = m[1]!.trim(); // JSX text between tags (not a comparison like `a > b … c < d`)
    if (!/[=;()[\]&|]/.test(t)) out.push(t);
  }
  for (const line of noComments.split("\n")) {
    const t = line.trim(); // JSX text on its own line (no code characters)
    if (t && !/[=;(){}<>[\]]/.test(t) && !/[,;]$/.test(t) && !/^(import|export|const|let|return|type|interface)\b/.test(t)) out.push(t);
  }
  return out;
}

describe("no UI string says clear", () => {
  it("every visible 'clear'/'clears'/'cleared'/'clearing' in web/src is a reviewed one", () => {
    const found: string[] = [];
    for (const f of files(ROOT)) {
      for (const text of visibleText(readFileSync(f, "utf8"))) {
        if (/\bclear(s|ed|ing)?\b/i.test(text) && !ALLOWED.some((a) => text.includes(a))) found.push(`${f.slice(ROOT.length + 1)}: ${text}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("finds every allowed phrase (the scan sees UI text, and the list isn't stale)", () => {
    const all = files(ROOT).flatMap((f) => visibleText(readFileSync(f, "utf8")));
    for (const a of ALLOWED) expect(all.some((t) => t.includes(a)), a).toBe(true);
  });

  it("would catch one", () => {
    expect(visibleText('const s = "Sector B3 cleared";').some((t) => /\bcleared\b/.test(t))).toBe(true);
    expect(visibleText('const s = "Not a person clears that ground.";').some((t) => /\bclear(s|ed|ing)?\b/i.test(t))).toBe(true);
    expect(visibleText('const s = "Clearing sector B3";').some((t) => /\bclear(s|ed|ing)?\b/i.test(t))).toBe(true);
    expect(visibleText("// the search area is clear\nconst x = 1;").some((t) => /\bclear\b/.test(t))).toBe(false);
  });
});
