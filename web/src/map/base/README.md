# Lane B map base

This folder owns the MapLibre layers below C's heatmap and above the basemap:

1. grid outline
2. frame footprints and selected footprint
3. flight path and direction arrows
4. detection uncertainty circles and labels
5. last-known-point marker and label

`layerIds.ts` reserves Lane B's stable IDs and recognizes Lane C layers through
the documented `heat-` prefix without claiming C's exact IDs. `circle.ts`
provides the required 64-point, metre-scaled detection circles.

`basemap.ts` chooses MapTiler Satellite V4 when `VITE_MAPTILER_KEY` is set and
the browser is online. Otherwise it builds a theme-token-based vector style
from `public/basemap/northshore.pmtiles`. The local style includes explicit
Protomaps/OpenStreetMap attribution and a bundled Noto Sans glyph range for map
labels. `MapView` exposes the active mode in a corner toggle and switches to the
offline archive if connectivity is lost.

The grid outline is derived from `map.json`'s frozen `Grid` contract: its
`origin_nw`, row/column count and `cell_m` determine the four corners. Flight
direction uses metre-sized line chevrons every five ordered frames, avoiding
sprites and extra symbol glyphs offline. The LKP point and its text label share
one GeoJSON source. Lane B installs its layers in the documented order; a later
Lane C heat layer should be inserted before `grid-outline` so it remains below
all Lane B overlays. The initial camera fits this complete grid; selecting a
review item then flies into its individual detection.
