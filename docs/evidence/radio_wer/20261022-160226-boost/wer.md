# Radio WER: phrase boosting off vs on

2026-10-22 16:02 · 1 recorded voice conditions from /home/driver/sightline/data/radio_wer · `scripts/radio_wer.py --boost`

Boost: NeMo GPU phrase boosting tree, greedy_batch, alpha 1, context score 1. Phrases (22): "niner", "four niner", "point niner", "fife", "tree", "Sightline", "over", "say again", "Say again", "affirmative", "Affirmative", "negative", "Negative", "Team One", "Team Two", "Team Three", "Team Four", "Bravo Three", "Charlie Four", "Alpha", "Delta", "POD".

"Raw" is word level after `protocol.normalize` without its repair of Parakeet's "niner" ("49er", "nine or"); "normalised" is with it, the radio desk's own path. Pooled: word errors / reference words. Time is the transcription call per clip (local: GPU; hosted: network round trip included).

## Summary

| Run | Voice | WER raw | WER normalised | Phrases with no error | Coordinates exact, raw | Coordinates exact, normalised | ms p50 / max |
|---|---|---|---|---|---|---|---|
| local, boost off | dan | 0.080 (13/162) | 0.025 (4/162) | 16/20 | 0/2 | 2/2 | 48 / 115 |
| local, boost on | dan | 0.025 (4/162) | 0.025 (4/162) | 16/20 | 2/2 | 2/2 | 47 / 136 |

## Per phrase (WER raw / normalised, ms)

| Voice | # | Phrase | local, boost off | local, boost on |
|---|---|---|---|---|
| dan | 1 | Sightline, Team Two, say again the sector boundary, over. | 0.11 / 0.11, 86 | 0.11 / 0.11, 45 |
| dan | 2 | Sightline, Team One, radio check, over. | 0.00 / 0.00, 49 | 0.00 / 0.00, 68 |
| dan | 3 | Sightline, Team Three, we are at four niner point three seven four, minus one two two point niner three six, over. | 0.44 / 0.11, 53 | 0.11 / 0.11, 49 |
| dan | 4 | Sightline, Team Four, returning to base, over. | 0.00 / 0.00, 42 | 0.00 / 0.00, 61 |
| dan | 5 | Sightline, Team Two. Found a blue backpack by the creek, our position, over. | 0.08 / 0.08, 45 | 0.08 / 0.08, 45 |
| dan | 6 | Affirmative, over. | 0.00 / 0.00, 42 | 0.00 / 0.00, 43 |
| dan | 7 | Negative, over. | 0.00 / 0.00, 41 | 0.00 / 0.00, 45 |
| dan | 8 | Say again, over. | 0.00 / 0.00, 41 | 0.00 / 0.00, 44 |
| dan | 9 | Sightline, Team One, what are the conditions, over. | 0.00 / 0.00, 115 | 0.00 / 0.00, 47 |
| dan | 10 | Sightline, Team Three, we heard a whistle to the north, over. | 0.00 / 0.00, 78 | 0.00 / 0.00, 47 |
| dan | 11 | Sightline, Team Two, searching sector Bravo Three, over. | 0.00 / 0.00, 91 | 0.00 / 0.00, 47 |
| dan | 12 | Sightline, Team Four, found footprints heading east at four niner point three eight one, minus one two two point niner four zero, over. | 0.55 / 0.00, 48 | 0.00 / 0.00, 51 |
| dan | 13 | Sightline, Team One, how much daylight is left, over. | 0.00 / 0.00, 107 | 0.00 / 0.00, 48 |
| dan | 14 | Sightline, Team Two, we are at the east ridge entry, over. | 0.00 / 0.00, 66 | 0.00 / 0.00, 46 |
| dan | 15 | Sightline, Team Three, found a red jacket on the trail, our position, over. | 0.08 / 0.08, 69 | 0.08 / 0.08, 47 |
| dan | 16 | Copy, Team Four out. | 0.00 / 0.00, 42 | 0.00 / 0.00, 44 |
| dan | 17 | Sightline, Team Two, request a new assignment, over. | 0.00 / 0.00, 43 | 0.00 / 0.00, 48 |
| dan | 18 | Sightline, Team One, we have a sighting near the creek fork, over. | 0.00 / 0.00, 42 | 0.00 / 0.00, 45 |
| dan | 19 | Sightline, Team Three, wind is picking up, over. | 0.00 / 0.00, 39 | 0.00 / 0.00, 48 |
| dan | 20 | Sightline, Team Four, say again my sector, over. | 0.00 / 0.00, 40 | 0.00 / 0.00, 136 |

## Transcripts that differ between runs

**1. Sightline, Team Two, say again the sector boundary, over.** (dan)

- local, boost off (0.11): "Sightline team two say again the sectory boundary over"
- local, boost on (0.11): "Sightline Team Two Say again the sectory boundary over"

**3. Sightline, Team Three, we are at four niner point three seven four, minus one two two point niner three six, over.** (dan)

- local, boost off (0.11): "Sightline team three we're at four niner point three seven four minus one two two point nine or three six over"
- local, boost on (0.11): "Sightline team three we're at four niner point three seven four minus one two two point niner three six over"

**4. Sightline, Team Four, returning to base, over.** (dan)

- local, boost off (0.00): "Sightline team four returning to base over"
- local, boost on (0.00): "Sightline Team Four returning to base over?"

**9. Sightline, Team One, what are the conditions, over.** (dan)

- local, boost off (0.00): "Sightline Team One What are the conditions over?"
- local, boost on (0.00): "Sightline Team One What Are the Conditions Over?"

**12. Sightline, Team Four, found footprints heading east at four niner point three eight one, minus one two two point niner four zero, over.** (dan)

- local, boost off (0.00): "Sightline Team 4 found footprints heading east at 49er.381 minus 122.9er40 over"
- local, boost on (0.00): "Sightline Team Four found footprints heading east at four niner point three eight one minus one two two point niner four zero over"

**14. Sightline, Team Two, we are at the east ridge entry, over.** (dan)

- local, boost off (0.00): "Sightline team two we are at the East Ridge entry over"
- local, boost on (0.00): "Sightline Team Two We are at the East Ridge entry over"

**15. Sightline, Team Three, found a red jacket on the trail, our position, over.** (dan)

- local, boost off (0.08): "Sightline Team 3 Frown a red jacket on the trail Our position over"
- local, boost on (0.08): "Sightline Team Three Frowned a Red Jacket on the Trail Our Position Over"

**17. Sightline, Team Two, request a new assignment, over.** (dan)

- local, boost off (0.00): "Sightline Team Two Request a new assignment over"
- local, boost on (0.00): "Sightline Team Two Request a New Assignment Over?"

**19. Sightline, Team Three, wind is picking up, over.** (dan)

- local, boost off (0.00): "Sightline team three wind is picking up, over"
- local, boost on (0.00): "Sightline Team Three Wind is picking up, over?"

**20. Sightline, Team Four, say again my sector, over.** (dan)

- local, boost off (0.00): "Sightline team four Say Again My Sector Over"
- local, boost on (0.00): "Sightline Team Four Say again My Sector Over"
