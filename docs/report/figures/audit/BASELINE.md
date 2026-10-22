# Web audit: baseline (main at cba05ae)

The built site (`VITE_CACHE_DIR=demo pnpm build`, the demo cache and the ONNX model in `public/` as on Vercel),
served statically from `web/dist` on a local port with gzip and HTTP ranges (as Vercel serves it).

- **Lighthouse 12.8.2** (Node API), Chrome 155 headless, software WebGL (SwiftShader). Performance,
  accessibility, best practices and SEO. Desktop: 1440×900, DPR 1, Lighthouse's desktop throttling (40 ms RTT,
  10 Mbps, no CPU slowdown). Phone: 390×844, DPR 3, Lighthouse's default mobile throttling (slow 4G, 4× CPU).
  Simulated throttling. **Median of 3 runs** per page and form.
- **axe-core 4.14** (`@axe-core/playwright` 4.14.0, Playwright 1.64), tags wcag2a/aa, wcag21a/aa, wcag22aa and
  best-practice, 3 s after load, same viewports.
- Pages: `#m/demo?t=0`, `#m/demo?t=2`, `#m/demo?t=5`, `#m/demo/trace`, `#about`, `#new`.

| Page | Form | Perf | A11y | BP | SEO | FCP ms | LCP ms | TBT ms | CLS | axe violations |
|---|---|---|---|---|---|---|---|---|---|---|
| `#m/demo?t=0` | desktop | 83 | 100 | 96 | 90 | 708 | 972 | 363 | 0.005 | none |
| `#m/demo?t=2` | desktop | 80 | 100 | 96 | 91 | 706 | 1104 | 397 | 0.006 | none |
| `#m/demo?t=5` | desktop | 62 | 100 | 96 | 90 | 766 | 989 | 408 | 0.365 | none |
| `#m/demo/trace` | desktop | 69 | 96 | 96 | 91 | 726 | 971 | 529 | 0.162 | none |
| `#about` | desktop | 69 | 100 | 96 | 90 | 767 | 1096 | 955 | 0.005 | none |
| `#new` | desktop | 99 | 100 | 100 | 90 | 702 | 863 | 0 | 0 | none |
| `#m/demo?t=0` | phone | 45 | 100 | 96 | 90 | 3767 | 4984 | 1839 | 0.049 | none |
| `#m/demo?t=2` | phone | 42 | 100 | 96 | 91 | 3765 | 5929 | 2266 | 0 | none |
| `#m/demo?t=5` | phone | 21 | 100 | 96 | 90 | 3914 | 5202 | 2106 | 0.613 | none |
| `#m/demo/trace` | phone | 43 | 100 | 93 | 91 | 3768 | 4977 | 2397 | 0.081 | none |
| `#about` | phone | 41 | 100 | 96 | 90 | 3921 | 5563 | 2604 | 0 | none |
| `#new` | phone | 79 | 100 | 100 | 90 | 3677 | 3902 | 124 | 0 | none |

Machine-readable: `baseline-scores.json` (same rows, with each page's axe results).

## What the audit found

**Performance**

- One 1.57 MB first bundle (448 KB gzip): MapLibre, the Trace view, the radio desk, About, the Debrief and its
  charts and Try a photo's panel all loaded before anything painted. Lighthouse: ~230 KB of it unused on every page.
- The map (MapLibre start-up, WebGL context, shaders, the canvas-drawn SIM chip) ran in the same tasks as the
  console's first render with data: the panels' text (the LCP element, the conditions line) waited for it.
  On the phone the LCP's "render delay" was 4.4–5.4 s.
- Layout shift: the console painted empty, then filled in as the demo fixtures, the recorded conditions lookup and
  the clue log arrived (t=5 desktop 0.365, phone 0.613; Trace 0.162). On a phone the landing painted before the
  pitch bar was set, then pushed the console down.
- `applyStep` copied the 500-step heat log with `Float64Array.from` (the iterator path): ~100 ms per replay.
- The ONNX model was already lazy (only on Try a photo); the demo cache JSONs were fetched in parallel at start.
- Review crops (15 at t=2) loaded eagerly though most are below the fold.

**Best practices / SEO**

- A console error on every console page: the live map's label layers had no `text-font`, so MapLibre asked for
  its default glyph stack (`Open Sans Regular,Arial Unicode MS Regular`), which the site does not serve: a 404,
  and the POA, team, clue and drone labels were missing.
- No `<meta name="description">`; the tab title was only "Sightline".
- Phone Trace view: 55 % of the text under 12 px (the 11 px caption scale) — BP 93.

**Accessibility** (axe found no violations; these come from axe's "incomplete" list, Lighthouse and checks of our own)

- axe could not judge colour contrast on 21–35 elements per page (the body's radial gradient). Our own check
  (each text element's colour, ancestor opacity and composited backgrounds against `--bg` and the gradient's
  brightest point) found every enabled text at ≥ 4.5:1 — `--text-2` 7.9:1, `--text-3` 5.9:1 on `--bg`; only the
  disabled export chips (exempt) and MapLibre's default attribution on `#new` (4.35:1, 3.29:1) were under.
- `aria-label` on 21 generic `<div>`s (prohibited: a label on an element with no role).
- Touch targets under 24 px: the scrubber's checkpoints on a phone (18×17), the task rows' action chips (22 px tall,
  Lighthouse `target-size` on Trace).
- Focus: the About sheet is `aria-modal` but Tab walked out of it into the console behind. The coach marks take
  focus on Next and keep Back/Exit in visual order; the view switch is one `nav` per layout (the other is
  `display:none`). No icon button without a name was found.
- Landmarks: one banner, one navigation, one main per page (checked with Playwright's role engine).
- Reduced motion: the story clock, the heat tween and the fleet glide already honoured it; "Pick on map" scrolled
  smoothly regardless.
