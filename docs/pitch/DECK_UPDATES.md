# Deck updates: from the idea deck to the judge deck

The current deck (`Sightline — Team Pitch.pdf`, 17 slides, 16 Oct) was written to pitch the idea to
the team. The PDF can't be edited here; apply these changes in the source file (Figma / Keynote /
Slides). Numbers and sources: `NUMBERS.md`. Proposed order for the 3-minute pitch is at the end.

| # | Slide | Change |
|---|---|---|
| 1 | Title | Kicker "HACKATHON IDEA · TEAM PITCH" → **"BCS HACKS 2026"**. Footer "Working name · Dan" → **"Daniel · Jason · Harvir · Grace"**. Keep the photo credit. |
| 2 | The problem | Keep. Re-check the three facts against DroneXL / CBC before stage. |
| 3 | The haystack | Keep. **Use it as the opener** (full-screen, circles hidden until the next click). |
| 4 | The bottleneck | Keep (33 s, 59%, 68%, 4.6 h are correct). |
| 5 | What we build | Title → **"What we built"**. Keep the three cards. |
| 6 | What a searcher sees | Replace the mockup with a **real screenshot of the review queue** from the live site. Delete the footnote "Mockup … the ranking order is illustrative". |
| 7 | The 60-second demo | Replace the illustrated photo with a real screenshot. Steps: use `DEMO_60S.md` once Dan sends the final clicks. Change "Press Rank. The person lands near the top." → **"All six people are in the first 7 of 500 photos."** |
| 8 | How it works | Keep. Correct: the detector runs single-pass on demo frames and tiled (SAHI) on full photos; site is React + MapLibre on Vercel; FastAPI upload endpoint exists (optional). |
| 9 | Is it just CV? | **Replace the AIR numbers with ours.** "4.5% → 86%" → **"19.6% → 86.4%"**; captions: "recall, stock YOLO11s" → "recall, tiled + fine-tuned (precision 80.2%)". Footer → "101 HERIDAL test photos never used in training, IoU ≥ 0.5, after correcting a label error in 4 test photos. Source: metrics.json." Delete "Our YOLO numbers will be our own." Ablations card: "Stock 19.6% · Fine-tuned 23.4% · + Tiling 86.4% · + Hard negatives 86.9% at lower precision (not kept)". |
| new | **Us vs. humans** (add after 9) | Two columns: **Sightline 86.4% recall · 80.2% precision · 0.25 s/photo** vs **People 68% · 59% · 33 s/photo**. Footer: "Human baseline: Pyrrö, Naseri & Jung 2021. Ours: 101 test photos, after correcting a label error in 4 of them." |
| new | **Ranking** (add after the new slide) | Big number: **"7 of 500"** — "photos reviewed before all 6 people are found". Small: "First person at photo 1 (random order: 71.6 on average). Under 4 minutes at 33 s a photo." Don't show "photo 336 in flight order" as a baseline; it is one flight's layout. |
| 10 | Hard negatives | Text "That, plus tiling, is where the accuracy comes from" is **no longer true**. Replace the right paragraph with: "We mined false-alarm tiles and retrained. On the test set it didn't help (F2 0.840 vs 0.850: recall 86.9% but precision fell to 73.8%), so we kept the model without it." Keep the "which of these are people?" crops. |
| 11 | Where to look next | Replace the illustration with a **real screenshot of the heat map** (after lane C's heat-layer fix lands). Footer "An illustration, not our model" → "Simulated search evaluation, 30,000 trials." Add: **"Inside the surveyed area: 98 cells vs 123 for a naive map (demo run). At least 10% better on every seed, with our canopy estimate's measured error. Simulated."** Small: "Even when the drone flies over a hiker, the photos miss them about half the time (simulated)." |
| 12 | FlyBy at HackGT | Move to the Q&A backup (it's an answer, not a pitch slide). If kept: row "Detection — Not described" → "Sightings — simulated". |
| 13 | Why it can win | **Remove** (it's about how judges score; not for judges). |
| 14 | How we split it | Fix the lanes: **A Daniel — detector · B Jason — geo, map layers · C Harvir — search map · D Grace — pipeline, app, pitch**. Keep "one shared contract". |
| 15 | 36-hour plan | **Remove**, or replace with "What we shipped in 24 hours" (one line per lane). |
| 16 | Honest risks | Title → **"Honest limits"**. Rows: misses groups, rock-coloured clothing, people sitting or lying; canopy estimate error (MAE 0.34); each photo treated as an independent look; simulated flight path; simulated search eval; 10 m radius assumed; Croatian scrub, daylight; flat placeholder prior; small test set (101 photos). Drop "Photos may lack GPS metadata" (74 of 101 have GPS; see lane B's task). |
| 17 | Next steps (internal) | Replace with **"What's next"**: real prior from SAR statistics · measured pin error from photo GPS · BC and thermal imagery · a pilot with a real team. End on the close line from `PITCH_3MIN.md`. |

## Proposed order for the 3-minute pitch
3 (opener) → 2 → 4 → 5 → **live demo** → 9 → *Us vs. humans* → *Ranking* → 11 → 16 → 17.
Keep 1 on screen while people sit down. Hold 10, 12, 14 as backup slides for questions.
