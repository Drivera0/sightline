# Radio WER: phrase boosting off vs on

2026-10-22 16:05 · hosted Parakeet (build.nvidia.com, Riva gRPC, verbatim transcripts), 1 recorded voice conditions from /home/driver/sightline/data/radio_wer · `scripts/radio_wer.py --boost`

Boost: Riva word boosting (`speech_contexts`), score 1. Phrases (22): "niner", "four niner", "point niner", "fife", "tree", "Sightline", "over", "say again", "Say again", "affirmative", "Affirmative", "negative", "Negative", "Team One", "Team Two", "Team Three", "Team Four", "Bravo Three", "Charlie Four", "Alpha", "Delta", "POD".

"Raw" is word level after `protocol.normalize` without its repair of Parakeet's "niner" ("49er", "nine or"); "normalised" is with it, the radio desk's own path. Pooled: word errors / reference words. Time is the transcription call per clip (local: GPU; hosted: network round trip included).

## Summary

| Run | Voice | WER raw | WER normalised | Phrases with no error | Coordinates exact, raw | Coordinates exact, normalised | ms p50 / max |
|---|---|---|---|---|---|---|---|
| hosted, boost off | dan | 0.043 (7/162) | 0.025 (4/162) | 16/20 | 1/2 | 2/2 | 288 / 14260 |
| hosted, boost on | dan | 0.031 (5/162) | 0.031 (5/162) | 16/20 | 2/2 | 2/2 | 298 / 14395 |

## Per phrase (WER raw / normalised, ms)

| Voice | # | Phrase | hosted, boost off | hosted, boost on |
|---|---|---|---|---|
| dan | 1 | Sightline, Team Two, say again the sector boundary, over. | 0.11 / 0.11, 14260 | 0.11 / 0.11, 14395 |
| dan | 2 | Sightline, Team One, radio check, over. | 0.00 / 0.00, 340 | 0.00 / 0.00, 341 |
| dan | 3 | Sightline, Team Three, we are at four niner point three seven four, minus one two two point niner three six, over. | 0.11 / 0.11, 611 | 0.11 / 0.11, 630 |
| dan | 4 | Sightline, Team Four, returning to base, over. | 0.00 / 0.00, 306 | 0.00 / 0.00, 307 |
| dan | 5 | Sightline, Team Two. Found a blue backpack by the creek, our position, over. | 0.08 / 0.08, 310 | 0.08 / 0.08, 333 |
| dan | 6 | Affirmative, over. | 0.00 / 0.00, 255 | 0.00 / 0.00, 254 |
| dan | 7 | Negative, over. | 0.00 / 0.00, 247 | 0.00 / 0.00, 257 |
| dan | 8 | Say again, over. | 0.00 / 0.00, 247 | 0.00 / 0.00, 258 |
| dan | 9 | Sightline, Team One, what are the conditions, over. | 0.00 / 0.00, 280 | 0.00 / 0.00, 291 |
| dan | 10 | Sightline, Team Three, we heard a whistle to the north, over. | 0.00 / 0.00, 291 | 0.00 / 0.00, 298 |
| dan | 11 | Sightline, Team Two, searching sector Bravo Three, over. | 0.00 / 0.00, 288 | 0.00 / 0.00, 299 |
| dan | 12 | Sightline, Team Four, found footprints heading east at four niner point three eight one, minus one two two point niner four zero, over. | 0.27 / 0.00, 372 | 0.00 / 0.00, 374 |
| dan | 13 | Sightline, Team One, how much daylight is left, over. | 0.00 / 0.00, 288 | 0.00 / 0.00, 284 |
| dan | 14 | Sightline, Team Two, we are at the east ridge entry, over. | 0.00 / 0.00, 287 | 0.00 / 0.00, 289 |
| dan | 15 | Sightline, Team Three, found a red jacket on the trail, our position, over. | 0.08 / 0.08, 298 | 0.15 / 0.15, 300 |
| dan | 16 | Copy, Team Four out. | 0.00 / 0.00, 258 | 0.00 / 0.00, 265 |
| dan | 17 | Sightline, Team Two, request a new assignment, over. | 0.00 / 0.00, 278 | 0.00 / 0.00, 290 |
| dan | 18 | Sightline, Team One, we have a sighting near the creek fork, over. | 0.00 / 0.00, 298 | 0.00 / 0.00, 301 |
| dan | 19 | Sightline, Team Three, wind is picking up, over. | 0.00 / 0.00, 277 | 0.00 / 0.00, 285 |
| dan | 20 | Sightline, Team Four, say again my sector, over. | 0.00 / 0.00, 280 | 0.00 / 0.00, 290 |

## Transcripts that differ between runs

**1. Sightline, Team Two, say again the sector boundary, over.** (dan)

- hosted, boost off (0.11): "Sightline team two say again the sectory boundary over"
- hosted, boost on (0.11): "Sightline Team Two Say again the sectory boundary over"

**3. Sightline, Team Three, we are at four niner point three seven four, minus one two two point niner three six, over.** (dan)

- hosted, boost off (0.11): "Sightline team three we're at four niner point three seven four minus one two two point niner three six over"
- hosted, boost on (0.11): "Sightline Team Three We're at four niner point three seven four minus one two two point niner three six over"

**4. Sightline, Team Four, returning to base, over.** (dan)

- hosted, boost off (0.00): "Sightline team four returning to base over?"
- hosted, boost on (0.00): "Sightline Team Four returning to base over?"

**5. Sightline, Team Two. Found a blue backpack by the creek, our position, over.** (dan)

- hosted, boost off (0.08): "Sightline team two found a blue backpack by the creek, are position over?"
- hosted, boost on (0.08): "Sightline Team Two found a blue backpack by the creek, are position over?"

**9. Sightline, Team One, what are the conditions, over.** (dan)

- hosted, boost off (0.00): "Sightline Team One What are the conditions over?"
- hosted, boost on (0.00): "Sightline Team One What Are the Conditions Over?"

**12. Sightline, Team Four, found footprints heading east at four niner point three eight one, minus one two two point niner four zero, over.** (dan)

- hosted, boost off (0.00): "Sightline Team Four found footprints heading east at four niner point three eight one minus one two two point nine or four zero over"
- hosted, boost on (0.00): "Sightline Team Four found footprints heading east at four niner point three eight one minus one two two point niner four zero over"

**15. Sightline, Team Three, found a red jacket on the trail, our position, over.** (dan)

- hosted, boost off (0.08): "Sightline Team 3 Frown a red jacket on the trail Our position over"
- hosted, boost on (0.15): "Sightline Team Three Frowned a Red Jacket on the Trail Are Position Over"

**17. Sightline, Team Two, request a new assignment, over.** (dan)

- hosted, boost off (0.00): "Sightline Team 2 request a new assignment over"
- hosted, boost on (0.00): "Sightline Team Two Request a New Assignment Over"

**19. Sightline, Team Three, wind is picking up, over.** (dan)

- hosted, boost off (0.00): "Sightline team three wind is picking up, over"
- hosted, boost on (0.00): "Sightline Team Three Wind is picking up, over?"

**20. Sightline, Team Four, say again my sector, over.** (dan)

- hosted, boost off (0.00): "Sightline team four Say Again My Sector Over"
- hosted, boost on (0.00): "Sightline Team Four Say again My Sector Over"
