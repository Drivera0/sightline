// Usage: node scripts/check-contrast.mjs   (from web/)
// Prints every text token's contrast on its backgrounds in both themes and exits 1 when one is under
// 4.5:1 (WCAG AA, normal text). The pairs are in contrast.mjs.
import { themes } from "./contrast.mjs";

const MIN = 4.5;
const all = themes(new URL("../src/shell/theme.css", import.meta.url));
let bad = 0;
for (const [theme, rows] of Object.entries(all)) {
  console.log(`\n${theme}`);
  for (const r of rows) {
    const ok = r.ratio >= MIN;
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${r.text.padEnd(12)} on ${r.on.padEnd(15)} ${r.ratio.toFixed(2)}:1`);
  }
}
if (bad) {
  console.error(`\n${bad} pair(s) under ${MIN}:1`);
  process.exit(1);
}
console.log(`\nevery text token is at least ${MIN}:1 in both themes`);
