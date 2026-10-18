# 60-second demo script (draft)

For the live demo and the backup video. About 140 spoken words.
**Click steps are placeholders**: Dan is redesigning the UI flow and will send the final steps.
Run it from the live site or from a local `pnpm build && pnpm preview` with Wi-Fi off.

| Time | Screen | Do | Say |
|---|---|---|---|
| 0–8 s | Header | `[CLICK: open the survey]` | "Five hundred drone photos over Mount Seymour. By hand, that's over four and a half hours." |
| 8–22 s | Review | `[CLICK: first crop]` → press **P** | "Sightline already read every photo, a quarter of a second each, and put the likeliest first. That one's a person." |
| 22–30 s | Review → Map | press **M** | "It's pinned on the map, with its ten-metre uncertainty circle — that part is simulated, and the app says so." |
| 30–38 s | Review | `[CLICK: a false alarm]` → press **N** | "This one's a false alarm. Saying so updates the map live." |
| 38–50 s | Map | `[DRAG: step slider through the flight]` | "Open ground the drone saw fades. Forest it couldn't see into stays bright. That's where the team goes next." |
| 50–60 s | Metrics | `[CLICK: Metrics tab]` | "Our detector against the published human baseline, and where every number comes from." |

## Facts the narration relies on
- 500 photos, 4.6 h by hand, 0.25 s per photo, 10 m simulated radius: `NUMBERS.md`.
- The "fades / stays bright" line only works if lane C's heat-layer fix lands (task 1 in the new
  split). Check the map tells that story before recording; if not, say "the map keeps the forest
  the camera couldn't see into at the top of the list" while showing Search Next.

## Before recording the backup video
- [ ] Final click steps from Dan pasted into the table above.
- [ ] Run it three times with a timer; the person must be confirmed before the scrub.
- [ ] Record screen + voice at 1440×900; keep the "Simulated flight path" badge visible.
