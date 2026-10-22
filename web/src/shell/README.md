# web/src/shell: one console, its bar and its addresses

The site is one console. The landing (`#`, which is `#m/demo`) is the console on the demo mission at the
start of its timeline; the story, New search, Try a photo, the results and For judges are moments, views,
rails or sheets of that console, never pages of their own. One mission state (`useMission`), one map
instance (it never unmounts while you stay on a mission), one clock.

| File | What |
|---|---|
| `flow.ts` | The address map: routes, views and every old address redirected (table below). |
| `AppBar.tsx` | The one bar, one row: wordmark (opens About) · mission name, LIVE/DEMO chip, mission clock · view switch (Map · Photos · Review · Trace · Debrief · Radio, `aria-pressed`) · one button. Under 1024 px the view switch is a bar along the bottom of the screen. |
| `Sheet.tsx` | A sheet over the console (About): slides in, Esc or the dim closes it, focus goes back. |
| `components.tsx` | The visual system from #159: `Button` (one orange primary per screen), `Panel` (opaque), `PageHeader`, `Page`, `Stat`, `Badge`, `StatusPill`, `ModeChip`, `KeyHint`, `EmptyState`. |
| `Logo.tsx` | `Brand`: the logo and the name, a link to `#about`. |
| `ShortcutOverlay.tsx`, `shortcuts.ts` | `?`: the story's keys, the views, the console's and the review's. |
| `theme.css` | Tokens, type scale, the status pill, motion (sheets and coach marks 200–300 ms; none under reduced motion). |

## Addresses

| Address | Opens |
|---|---|
| `#`, `` | `#m/demo`: the landing (t0, the pitch bar) |
| `#m/demo?t=0..5` | the story at a checkpoint, its coach mark on |
| `#m/<id>/map` · `photos` · `review` · `trace` · `debrief` | a view of a mission; on the demo `?t=0..3` sets the mission clock (none: the end of the timeline) |
| `#m/<id>/radio` | the Radio view: the radio desk |
| `#m/<id>/map/conditions` · `trace?log` · `debrief?judges` · `photos?try` | the Conditions panel, the event log, For judges, Try a photo open |
| `#m/<id>/card/<sector>` | a sector's printable assignment card (live missions) |
| `#new` | the empty console: start a search or load the demo mission |
| `#about` | the About sheet over the console last on screen |

Old addresses, kept so links in the docs, the Devposts and the video still land somewhere sensible:

| Old | Now |
|---|---|
| `#survey`, `#rank` | `#m/demo?t=1` (photos land) |
| `#review` | `#m/demo?t=2` (confirm) |
| `#search`, `#searchnext` | `#m/demo?t=3` (where next) |
| `#results` | `#m/demo?t=5` (the debrief) |
| `#operate`, `#command` | `#m/demo/map` |
| `#judges` | `#m/demo?t=5&judges` (the debrief, For judges open) |
| `#try` | `#m/demo/photos?try` |
| `#m/<id>/command[/conditions]`, `#m/<id>/approvals` | `#m/<id>/map[/conditions]` |
| `#m/<id>/feed` | `#m/<id>/trace?log` |

## Keys

Story: → next, ← back, Space pauses the mission clock, Esc leaves the story (the console stays at that
mission time). Views: 1–6 (6 is Radio), C back to the map. Console: Tab, A, X, W, L. Review: J/K (or the arrows), P, N, U.
`?` lists them.

## Type and spacing

One text family for everything: **Geist Sans** (variable, self-hosted through `@fontsource-variable/geist`,
no CDN at runtime), with tabular numerals on for the whole page (`font-feature-settings: "tnum"`), so clocks,
counts and percentages line up. **Geist Mono** only for ids and coordinates (`f0396-d01`, `p003`, `c004`,
`49.37121, -122.94379`) and for code (the watch command, the trace's JSON). No uppercase tracked labels:
section labels are sentence case, 12 px, medium weight (`Label`).

| Step | Size / line | For |
|---|---|---|
| `caption` | 12 / 16 | meta lines, chips, timestamps, table headers (the smallest size anywhere) |
| `small` | 13 / 20 | the console's working size: cards, rows, buttons |
| `body` | 15 / 22 | reading text: a proposal's reason, the debrief, sheets |
| `title` | 18 / 24 | panel and sheet titles |
| `headline` | 24 / 30 | page headings, big numbers |

`label`, `lead` and `display` are the same steps under older names (label = caption, lead = title, display =
headline). Spacing is the 4 px grid (Tailwind's `1` = 4 px): 4 inside a control, 8 between controls, 12 inside
a card, 16 between panels. Every panel header is `--panel-head` (40 px) tall (`.sl-panel-head`), and numbers in
tables are right-aligned (`.sl-num`).
