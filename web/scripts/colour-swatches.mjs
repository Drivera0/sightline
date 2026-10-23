// Usage: node scripts/colour-swatches.mjs > swatches.html   (from web/)
// The colour system as one page: every token in both themes with its contrast on the panel colour.
// Screenshotted to docs/report/figures/v3/colour-system.webp (shell/README.md "Colour").
import { readFileSync } from "node:fs";
import { parse, ratio, tokens } from "./contrast.mjs";

const css = readFileSync(new URL("../src/shell/theme.css", import.meta.url), "utf8");
const dark = tokens(css, ":root");
const light = { ...dark, ...tokens(css, ':root[data-theme="light"]') };

const ROWS = [
  ["text", "Text"], ["text-2", "Secondary text"], ["text-3", "Captions"],
  ["accent", "Brand: the primary action, the story"],
  ["team", "Ground teams"], ["drone", "Drones"], ["clue", "Clues"], ["proposal", "The agent's proposals"],
  ["found", "The find"], ["alert", "Alerts, overdue"], ["caution", "Caution"],
  ["searched", "Searched ground (fill)"],
];
const RAMP = ["prob-1", "prob-2", "prob-3", "prob-4", "prob-5"];

function column(name, t) {
  const panel = parse(t["surface-solid"]);
  const cells = ROWS.map(([k, label]) => {
    const fill = k === "searched";
    const r = fill ? "fill" : `${ratio(parse(t[k]), panel).toFixed(1)}:1`;
    return `<tr><td><span class="sw" style="background:${t[k]}"></span></td><td style="color:${fill ? t.text : t[k]}">${label}</td><td class="m">--${k}</td><td class="m">${t[k]}</td><td class="m r">${r}</td></tr>`;
  }).join("");
  const ramp = RAMP.map((k) => `<span style="background:${t[k]}" title="--${k} ${t[k]}"></span>`).join("");
  return `<section style="background:${t.bg};color:${t.text}"><h2>${name}</h2>
  <div class="panel" style="background:${t["surface-solid"]};border-color:${t.border}">
  <table><thead><tr style="color:${t["text-3"]}"><th></th><th>Means</th><th>Token</th><th>Value</th><th class="r">On panel</th></tr></thead><tbody>${cells}</tbody></table>
  <p style="color:${t["text-2"]}">Probability, low → high (--prob-1 … --prob-5)</p><div class="ramp">${ramp}</div>
  <p><span class="btn" style="background:${t.accent};color:${t["on-accent"]}">Primary action</span></p></div></section>`;
}

console.log(`<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:Geist;src:url(../node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2)}
@font-face{font-family:GeistMono;src:url(../node_modules/@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2)}
body{margin:0;display:grid;grid-template-columns:1fr 1fr;font:14px/20px Geist,sans-serif;font-variant-numeric:tabular-nums}
section{padding:28px}h2{margin:0 0 14px;font-size:18px;font-weight:500}
.panel{border:1px solid;border-radius:16px;padding:16px}
table{border-collapse:collapse;width:100%}td,th{padding:5px 8px;text-align:left;font-weight:400}th{font-size:12px}
.m{font-family:GeistMono,monospace;font-size:12px;opacity:.85}.r{text-align:right}
.sw{display:inline-block;width:22px;height:22px;border-radius:6px;vertical-align:middle;box-shadow:inset 0 0 0 1px rgba(128,128,128,.35)}
.ramp{display:flex;height:22px;border-radius:6px;overflow:hidden}.ramp span{flex:1}
.btn{display:inline-block;border-radius:999px;padding:8px 16px;font-weight:500}
</style>${column("Dark (default)", dark)}${column("Light", light)}`);
