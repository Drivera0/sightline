# 05 · Frontend (shared by everyone)

> **Who:** all four. D builds the shell early (hours 0–10); everyone builds their own screen in hours 18–26.
> **Read first:** `00_OVERVIEW.md`, `01_CONTRACT.md`. Your lane file's §9 has your screen's details.

---

## 1. Rules for a shared frontend

1. **One look.** D owns the shell, theme tokens and shared components, and has final say on visual consistency. Use the tokens; never hard-code colours or font sizes.
2. **Your screen shows your data.** A: metrics. B: map base. C: heatmap + search panel. D: review queue. You debug what you built.
3. **Read-only cache.** The web app never writes to the cache. All interaction state lives in Zustand stores (§4).
4. **Types come from `src/contract.ts`** (generated). No `any` for cache data.
5. **The full click path (§7) must work by hour 26,** with Wi-Fi off. After that, polish only.

---

## 2. Stack

| Concern | Choice |
|---|---|
| Build | Vite + React + TypeScript (strict) |
| Styling | Tailwind CSS with the tokens in §5 as CSS variables |
| State | Zustand (one store per concern, §4) |
| Map | MapLibre GL JS; `pmtiles` for the offline basemap |
| Tests | Vitest (C's update mirror, loaders, store logic) |
| Data | Static JSON + JPEG from `public/cache/${VITE_CACHE_DIR}/` |
| Fonts | Geist, Geist Mono (+ Caveat for annotations only), **self-hosted** in `public/fonts/` so they work offline |

---

## 3. Folder ownership

```
web/src/
  contract.ts            # generated (D) — never hand-edit
  lib/                   # D: cache loader, selection store, shared hooks
  shell/                 # D: layout, header, tabs, theme, shared components
  review/                # D: review queue screen + review store
  map/MapView.tsx        # B: map instance, MapProvider, useMap()
  map/base/              # B: basemap switch, footprints, path, pins, LKP
  map/heat/              # C: heat layer, step slider, search-next panel
  search/                # C: update.ts (mirror), store.ts, __fixtures__/
  metrics/               # A: the Debrief's results (ResultsSummary) and their details (MetricsView)
  detect/                # Try your own photo: in-browser detector
```

---

## 4. State and how screens talk to each other

| Store | Owner | Holds | Used by |
|---|---|---|---|
| `useCache` (`lib/cache.ts`) | D | The five loaded JSON files, loading/error | everyone |
| `useSelection` (`lib/selection.ts`) | D | `selectedDetectionId`, `selectedFrameId` | queue ↔ map |
| `useReview` (`review/store.ts`) | D | **ordered answer history** (the single source of truth for review state), derived answers per detection, undo, reset; persisted | queue, map pins, `useSearch` |
| `useSearch` (`search/store.ts`) | C | `stepIndex` + map state derived from steps and `useReview`'s history; `found` | heat layer, panel, metrics |

Events:

- **Answer in the queue** → `useReview` appends to its history → `useSearch` recomputes (replay steps, then each "not a person" answer in order) → the heat layer recolours; B's pin style changes from `useReview`. Undo or reset edits the history, and the map follows automatically.
- **Select in the queue** → `useSelection` → B's map flies to the pin and highlights the footprint.
- **Click a pin** → `useSelection` → the queue jumps to that crop.
- **"Person" answer** → `useSearch.found = true` → "Person confirmed" banner and highlighted pin. The slider and later answers keep working, because the demo scrubs the map after the first confirmation.

---

## 5. The look (matches the pitch deck)

The tokens live in `web/src/shell/theme.css` and are exposed to Tailwind there (`bg-surface`, `text-text-2`, `rounded-lg`, `text-small`, ...). This block mirrors them; if the two disagree, `theme.css` wins and this section is stale.

```css
:root {
  --bg: #0A0B0D;              /* app background */
  --surface: rgba(255,255,255,0.05);   /* glass panels */
  --surface-strong: rgba(255,255,255,0.08);
  --border: rgba(255,255,255,0.12);
  --text: #F2F2F0;
  --text-2: #A1A1AA;          /* secondary */
  --text-3: #8A8A93;          /* captions, sources */
  --accent: #FF7A1A;          /* the one accent: selection, attention, the middle of the heat ramp */
  --accent-soft: #FFB27A;
  --ok: #7EE2A0;              /* "Person": confirmed pins and chips */
  --warn: #FFC48F;            /* "Unsure" */
  --radius-lg: 16px;          /* panels */
  --radius-md: 10px;          /* inner elements: crops, frames */
  --radius-sm: 10px;          /* inner elements: rows, inputs; 999px only for buttons and chips */
  --font: 'Geist Variable', system-ui, sans-serif;
  --mono: 'Geist Mono Variable', ui-monospace, monospace;
  --hand: 'Caveat Variable', cursive;  /* annotations only */
}
```

- **Panels:** `--surface` background, 1px `--border`, `backdrop-filter: blur(16px)` over the map, `--radius-lg` (16 px). Inner elements use `--radius-sm` / `--radius-md` (10 px). Buttons and chips are pills.
- **Type scale** (Tailwind `text-*`, size / line height in px):

  | Token | Size / line | Use |
  |---|---|---|
  | `caption` | 11 / 16 | footers, credits |
  | `label` | 11 / 16 | uppercase mono labels, letter-spacing `tracking-label` (0.08em) |
  | `small` | 13 / 20 | secondary text, notes, sources |
  | `body` | 15 / 24 | default text, tables |
  | `lead` | 17 / 26 | intro paragraphs |
  | `title` | 20 / 28 | card and section titles |
  | `headline` | 28 / 34 | screen headlines on phones |
  | `display` | 40 / 44 | big numbers, screen headlines from `sm` |

  Numbers in `--mono` with tabular figures. Never set a font size outside these tokens.
- **One accent.** Orange means "attention / selected", and it is the middle stop of the heat ramp. Status always pairs colour with a word ("Person", "Not a person", "Unsure"); never colour alone.
- **Map pins** (`map/base/pinImages.ts`): Person = a green (`--ok`) disc with a dark check, the strongest mark on the map and never the heat's orange or red; Unsure = an open amber (`--warn`) ring with "?"; Not a person = a small grey cross; not answered yet = a small neutral dot.
- **Heat ramp** (`map/heat/raster.ts`): ColorBrewer YlOrRd without its palest class, with the theme accent replacing the orange stop, drawn in 7 classes from pale yellow (less likely) to deep red (more likely); lightness falls monotonically along it. Ground not photographed yet is veiled with `--bg`; photographed ground awaiting review is a neutral grey tone. This is the one place colours outside the tokens are allowed, and the legend must say what the colours are relative to.
- **Caveat** (handwriting font) only for one-off annotations, like the deck. Never for data.
- **Honesty badges** (shared `<Badge kind="simulated">`): "Simulated flight path", "Simulated evaluation", "Placeholder prior", "10 m position uncertainty".

Shared components D provides in `shell/`: `Panel`, `Stat` (big number + label + source), `Badge`, `KeyHint`, `Tabs`, `EmptyState`.

---

## 6. The five steps (BCS hackathon; details in each lane file §9)

> **Now (PR #171):** the site is one console, not a guided flow. `#` opens the demo mission's console at t0; **Follow the search** runs it through the checkpoints `#m/demo?t=1..6` (Photos land, Confirm, Where next, Run, The find, Debrief), and the views are Map · Photos · Trace · Debrief (the review is in Needs You, the radio in the timeline's talk bar). The old step hashes (`#survey`, `#rank`, `#review`, `#search`, `#results`) redirect to those checkpoints. Addresses: `web/src/shell/flow.ts` and `web/src/shell/README.md`. The table below is the BCS plan, kept as history.

At BCS the app was one guided flow with a step bar and the step in the URL hash; the hackathon plan's three tabs became these steps.

| Step | Built by | What's on it |
|---|---|---|
| **Survey** | D | The photos the drone brought back, the place and the simulated flight path |
| **Rank** | D (+ A's detector) | The detector scoring every photo, the ranked queue |
| **Review** | D (+ B's map) | Ranked crops, P/N/U keys, full frame, mini-map with pins |
| **Search next** | B (base) + C (heat) | Basemap, footprints, path, pins, heat map, step replay, sectors list, legend |
| **Results** | A (+ D's ranking, C's simulation) | The ranking race, recall / time / cells cards, why resolution matters, known limits, then the details (detector vs. human, state of the art, ablations, ranking table, search simulation) as collapsed sections |

"Try your own photo" (`web/src/detect/`) runs the detector in the browser on an uploaded photo.

---

## 7. The demo click path (BCS; rehearse exactly this)

> **Now:** the click path is the console's story: `#`, then **Follow the search** (3 min), the Trace view, Conditions (W), the Debrief and the About sheet. The table below is the BCS hackathon's.

| Time | Screen | Action | Say |
|---|---|---|---|
| 0–10 s | Header | — | "500 drone photos over Mount Seymour. At 33 seconds each, that's over four hours." |
| 10–25 s | Review | Top crops are people; press `P` on #1 | "The likeliest crops come first. That one's a person." |
| 25–35 s | Review → Map | Press `M`; the pin is confirmed | "It's pinned, with its position uncertainty." |
| 35–45 s | Review | Press `N` on a backpack; switch to Map | "A false alarm. Marking it updates the map live." |
| 45–55 s | Map | Drag the step slider through the flight | "Open ground the drone saw turns pale. Forest it can't see into stays dark red. That's where the team goes next." |
| 55–60 s | Results | Open the step | "Here's the detector against the human baseline, and every number's source." |

The person is confirmed before the scrub, so the "found" state must not freeze the slider (see `LANE_C_SEARCH.md` §3.5). Rehearse exactly this order.

---

## 8. Definition of done (hour 26)

- [ ] `VITE_CACHE_DIR=demo pnpm build && pnpm preview` runs the whole click path with **Wi-Fi off** (offline basemap, self-hosted fonts).
- [ ] No console errors. Loading and error states for missing cache files.
- [ ] Keyboard-only demo works; `?` shows the shortcuts.
- [ ] Every number on screen traces to `metrics.json` or a cited source; every simulated thing has its badge.
- [ ] Works at 1440×900 (judging laptop) and on a 1080p projector.
- [ ] `pnpm test` passes (including C's update vectors).

---

## 9. For Claude (instructions when working under `web/`)

- Stay in your lane's folders (§3). Shared changes to `shell/` or `lib/` go through D.
- Use the CSS variables in §5 via the Tailwind theme in `shell/theme.css`; no new colours (the heat ramp in §5 is the one exception).
- Import cache types from `src/contract.ts`; never redefine them.
- Map work goes through B's `useMap()`; don't create a second MapLibre instance.
- Use C's `update.ts` for any probability change; never reimplement the update.
- Before finishing: `pnpm test && pnpm build`, then run the click path in §7 against `cache/sample`.
