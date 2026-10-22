# Radio WER: Parakeet TDT 0.6B v2 on the 20 radio phrases

2026-10-22 10:10 · 1 recorded voice conditions from /home/driver/sightline/data/radio_wer · `scripts/radio_wer.py`

Word level, after `protocol.normalize` on both sides (number words = digits, "Team Two" = "Team 2", "Sight line" = "Sightline"): the radio desk's own normalisation. Pooled: word errors / reference words.

**Overall WER 0.025** (20 clips, 162 reference words).

## Per voice

| Voice | Phrases | Words | WER | Coordinates exactly right |
|---|---|---|---|---|
| dan | 20 | 162 | 0.025 | 2/2 |

## Per phrase

| # | Phrase | dan | All |
|---|---|---|---|
| 1 | Sightline, Team Two, say again the sector boundary, over. | 0.11 | 0.11 |
| 2 | Sightline, Team One, radio check, over. | 0.00 | 0.00 |
| 3 | Sightline, Team Three, we are at four niner point three seven four, minus one two two point niner three six, over. | 0.11 | 0.11 |
| 4 | Sightline, Team Four, returning to base, over. | 0.00 | 0.00 |
| 5 | Sightline, Team Two. Found a blue backpack by the creek, our position, over. | 0.08 | 0.08 |
| 6 | Affirmative, over. | 0.00 | 0.00 |
| 7 | Negative, over. | 0.00 | 0.00 |
| 8 | Say again, over. | 0.00 | 0.00 |
| 9 | Sightline, Team One, what are the conditions, over. | 0.00 | 0.00 |
| 10 | Sightline, Team Three, we heard a whistle to the north, over. | 0.00 | 0.00 |
| 11 | Sightline, Team Two, searching sector Bravo Three, over. | 0.00 | 0.00 |
| 12 | Sightline, Team Four, found footprints heading east at four niner point three eight one, minus one two two point niner four zero, over. | 0.00 | 0.00 |
| 13 | Sightline, Team One, how much daylight is left, over. | 0.00 | 0.00 |
| 14 | Sightline, Team Two, we are at the east ridge entry, over. | 0.00 | 0.00 |
| 15 | Sightline, Team Three, found a red jacket on the trail, our position, over. | 0.08 | 0.08 |
| 16 | Copy, Team Four out. | 0.00 | 0.00 |
| 17 | Sightline, Team Two, request a new assignment, over. | 0.00 | 0.00 |
| 18 | Sightline, Team One, we have a sighting near the creek fork, over. | 0.00 | 0.00 |
| 19 | Sightline, Team Three, wind is picking up, over. | 0.00 | 0.00 |
| 20 | Sightline, Team Four, say again my sector, over. | 0.00 | 0.00 |

## The 5 worst phrases

**1. Sightline, Team Two, say again the sector boundary, over.** (WER 0.11)

- dan (0.11): "Sightline team two say again the sectory boundary over" → `sightline team 2 say again the sectory boundary over`
- reference, normalised: `sightline team 2 say again the sector boundary over`

**3. Sightline, Team Three, we are at four niner point three seven four, minus one two two point niner three six, over.** (WER 0.11)

- dan (0.11): "Sightline team three we're at four niner point three seven four minus one two two point nine or three six over" → `sightline team 3 we re at 49.374 -122.936 over`
- reference, normalised: `sightline team 3 we are at 49.374 -122.936 over`

**5. Sightline, Team Two. Found a blue backpack by the creek, our position, over.** (WER 0.08)

- dan (0.08): "Sightline team two found a blue backpack by the creek, are position over?" → `sightline team 2 found a blue backpack by the creek are position over`
- reference, normalised: `sightline team 2 found a blue backpack by the creek our position over`

**15. Sightline, Team Three, found a red jacket on the trail, our position, over.** (WER 0.08)

- dan (0.08): "Sightline Team 3 Frown a red jacket on the trail Our position over" → `sightline team 3 frown a red jacket on the trail our position over`
- reference, normalised: `sightline team 3 found a red jacket on the trail our position over`

**2. Sightline, Team One, radio check, over.** (WER 0.00)

- dan (0.00): "Sightline Team One Radio Check Over" → `sightline team 1 radio check over`
- reference, normalised: `sightline team 1 radio check over`
