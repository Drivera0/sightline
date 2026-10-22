# web/src/shell: one console, its bar and its addresses

The site is one console. The landing (`#`, which is `#m/demo`) is the console on the demo mission at the
start of its timeline; the story, New search, Try a photo, the results and For judges are moments, views,
rails or sheets of that console, never pages of their own. One mission state (`useMission`), one map
instance (it never unmounts while you stay on a mission), one clock.

| File | What |
|---|---|
| `flow.ts` | The address map: routes, views and every old address redirected (table below). |
| `AppBar.tsx` | The one bar, one row: wordmark (opens About) · mission name, LIVE/DEMO chip, mission clock · view switch (Map · Photos · Review · Trace · Debrief, `aria-pressed`) · one button. Under 1024 px the view switch is a bar along the bottom of the screen. |
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
| `#m/<id>/radio` | the radio desk on its own (phones) |
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
mission time). Views: 1–5, C back to the map. Console: Tab, A, X, W, L. Review: J/K (or the arrows), P, N, U.
`?` lists them.
