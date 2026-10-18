# Numbers we say out loud, and where each one comes from

Rule: no number goes on a slide, in a script or on Devpost unless it is in this table.
"Live" = `https://sightline-iota-sandy.vercel.app/cache/demo/metrics.json`, built from commit
`e034c74` at 2026-10-18 03:20 UTC (`manifest.json`). If the demo cache is rebuilt, re-check this table.

## Detector (lane A)

Test set: the 101 HERIDAL test photos (337 people), never used for training or for choosing the
threshold. Scoring: VOC, one box per person, IoU ≥ 0.5. Threshold 0.29, chosen on validation photos.

| Say | Value | Source |
|---|---|---|
| Recall | **76.9%** | Live `detector.voc.recall` 0.769; `scripts/README.md` |
| Precision | **71.3%** | Live `detector.voc.precision` 0.713 |
| AP50 | 72.3% | Live `detector.voc.ap50` 0.723 |
| Recall / precision with SAR-style (looser) matching, as in the AIR paper | 80.7% / 81.0% | Live `detector.sar` |
| Time per full 4000×3000 photo | **0.25 s** (0.245) | Live `detector.seconds_per_image` (RTX 4080 SUPER) |
| Stock model (COCO YOLO11s, photo shrunk to 1024 px) recall | **19.6%** | Live `ablations[0]` |
| Fine-tuned, no tiling, recall | 20.5% | Live `ablations[1]` |
| Fine-tuned + tiling recall (our model) | 76.9% | Live `ablations[2]` |
| + hard negatives recall (measured, not kept: F2 0.740 vs 0.757) | 76.6% | Live `ablations[3]`; `scripts/README.md` |

## Human baseline (published)

| Say | Value | Source |
|---|---|---|
| Time per photo | **33 s** | Pyrrö, Naseri & Jung 2021, arXiv:2111.09406; live `baseline_human` |
| Precision | **59%** | same |
| Recall | **68%** ("a third of people missed") | same |
| 500 photos by hand | **4.6 h** | 500 × 33 s = 16,500 s (derived) |
| Faster per photo than a person | **more than 130×** | 33 s / 0.245 s = 135 (derived) |

Caveat to keep: the 33 s was measured on full 4000×3000 photos. Our 0.25 s is also per full photo,
so that comparison is fair. In the demo, each 1000×750 frame stands for one photo.

## Ranking on the demo survey (lane D)

500 frames from the 101 test photos, 6 of them with a person, simulated flight order (seed 7).

| Say | Value | Source |
|---|---|---|
| All 6 people found within the first … photos reviewed | **15** ranked vs **462** in flight order | Live `ranking.ranked/flight_order.frames_to_all_hits` |
| Time to review until all 6 are found, at 33 s/photo | **8 min** vs **4.2 h** | 15 × 33 s; 462 × 33 s (derived) |
| First person found at | photo **1** ranked (random order: **71.6** on average) | Live `ranking.ranked.frames_to_first_hit`, `expected_first_hit_random_order` |
| Review-queue items (detections at or above 0.29) | 15 | `scripts/README.md` (demo survey) |

Do **not** say "rank 1 vs 73 in flight order": that was an older survey. On the live survey the first
person happens to be photo 2 in flight order, so the strong claim is "all 6 within 15 vs 462".

## Search map (lane C) — always say "simulated"

30,000 simulated lost hikers (seed 7). Cells are 20 m × 20 m; fewer cells checked is better.
`in_survey` = the 2,080 trials where the person was in ground the drone photographed but the
photos did not find them.

| Say | Value | Source |
|---|---|---|
| Median cells a ground team checks, inside the surveyed area | Sightline **102**, naive ("photographed = cleared") **122**, prior only **154** | Live `search_sim.in_survey.methods[*].median_cells` |
| 90th percentile, same | 245 / 253 / 270 | Live `search_sim.in_survey.methods[*].p90_cells` |
| Over the whole 1 km grid | Sightline 1,204 = naive 1,204; prior only 1,263 | Live `search_sim.methods` |
| Survey found the person itself | 4.5% of trials | Live `search_sim.found_by_drone_rate` |

Do not claim a whole-grid win: Sightline ties naive there, because the survey covers only part of
the grid and the prior is a flat placeholder (`map.json` `params.prior_source = "placeholder"`).

## The project

| Say | Value | Source |
|---|---|---|
| Automated tests | 886 (649 Python, 237 web) | `pytest --collect-only` and `pnpm test` on the code at `origin/lane-d` `028479e` |

## The problem (context)

| Say | Value | Source |
|---|---|---|
| North Shore Rescue | 100+ people rescued a year, Canada's busiest volunteer SAR team | DroneXL, 22 Apr 2025 (dronexl.co/2025/04/22/drones-ai-thermal-transform-search-and-rescue); deck slide 2 |
| Mount Seymour | a hypothermic hiker found 2 km away on the drone's last battery | DroneXL / CBC 2025; deck slide 2 |
| 13 h | ground search when the subject heard the drone but was not spotted | DroneXL / CBC 2025; deck slide 2 |
| Person size | about 60 px wide, about 0.03% of a 12-MP photo | deck slide 3 (HERIDAL) |
| Data | HERIDAL, Božić-Štulić, Marušić & Gotovac 2019; VOC copy by Pyrrö 2021, CC BY 3.0 | `README.md` |

Check before stage: the three problem facts come from the original deck's research; re-open the
DroneXL / CBC articles once and confirm the wording.
