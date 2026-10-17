# Lane B map base

This folder owns the MapLibre layers below C's heatmap and above the basemap:

1. grid outline
2. frame footprints and selected footprint
3. flight path and direction arrows
4. detection uncertainty circles and labels
5. last-known-point marker and label

`layerIds.ts` reserves Lane B's stable IDs and recognizes Lane C layers through
the documented `heat-` prefix without claiming C's exact IDs. `circle.ts`
provides the required 64-point, metre-scaled detection circles. Basemap source
and layer construction will be added when the offline PMTiles asset and the
team's MapTiler URL are available.
