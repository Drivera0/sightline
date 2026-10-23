# web/src/map: the map

`MapView.tsx` holds the MapLibre map; `base/` draws lane B's layers (the grid, footprints, pins, the last known
point, and the live mission's clues, teams, drones and legs: `base/README.md`); `heat/` draws the probability
surface (`heat/README.md`). `pick.ts` lets another panel ask for a point on the map.

## Bearing clues

A sound a team heard with a bearing (contract 15.7: `origin`, `bearing_deg`, `bearing_spread_deg`, `range_m`)
draws as an arc in the clue amber (`base/clueLayer.ts` `clueArcFeatures`, the `live-heat-clue-arcs` layers in
`heat/LiveHeatMap.tsx`): from where the team stood (the clue's `origin`, else the reporting team's position),
within the bearing ± its spread, `range_m` away ± the clue's `radius_m` (an inner edge of 0 is a wedge from the
team). It is the area the map's own update raises (`sightline/search/live.py` `_clue_cells`). Hovering it says
what was heard, who heard it, and the bearing and range; the pin at the arc's middle keeps its popup, and the
fading ring when the clue lands is the arc too. Tested on the overdue hiker's whistle (`base/clueArc.test.ts`).

## The still map (phones)

Phones and slower devices see a still image of the demo map until the map is wanted (`MapStill.tsx`):
`public/map/demo-t0-390.webp` (a 390 px screen, at 2×) and `public/map/demo-t0-1440.webp` (1024 px and up).
They are rendered from the current fixture, never made by hand:

```sh
cd web
node scripts/map-stills.mjs                              # starts its own Vite server, writes both stills
node scripts/map-stills.mjs --url http://localhost:5173  # or uses a dev server already running
```

The script opens the console at t0 (the call, `#m/demo/map?t=0`) with the legend closed (its pill left out of
the picture: the still's own label sits there) and the dark theme
(`--theme light` for the other), loads the live map (tapping the still on the phone size), waits for it to
settle, screenshots the map's box with Playwright's Chromium and encodes WebP in the same browser. It needs
the demo cache in `public/cache/demo` (`scripts/fetch-caches.sh`) and Chromium for Playwright (`pnpm exec
playwright install chromium`, once). Run it again whenever the demo fixture, the map's look or the console's
layout changes, and commit the two images.
