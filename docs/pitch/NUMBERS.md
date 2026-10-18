# Numbers we say out loud, and where each one comes from

Rule: no number goes on a slide, in a script or on Devpost unless it is in this table.
"Live" = `https://sightline-iota-sandy.vercel.app/cache/demo/metrics.json`, built from commit
`3800633` at 2026-10-18 07:00 UTC (`manifest.json`). Checked against the live file on 18 Oct and
confirmed by lane C. If the demo cache is rebuilt, re-check this table.

## Detector (lane A)

Test set: the 101 HERIDAL test photos (337 people), never used for training or for choosing the
threshold. Scoring: VOC, one box per person, IoU ≥ 0.5. Threshold 0.29, chosen on validation photos.

| Say | Value | Source |
|---|---|---|
| Recall | **86.4%** | Live `detector.voc.recall` 0.864 |
| Precision | **80.2%** | Live `detector.voc.precision` 0.802 |
| AP50 | 0.868 | Live `detector.voc.ap50` |
| Recall / precision with SAR-style (looser) matching, as in the AIR paper | 89.6% / 89.8% | Live `detector.sar` |
| Time per full 4000×3000 photo | **0.25 s** (0.251) | Live `detector.seconds_per_image` (RTX 4080 SUPER) |
| Stock model (COCO YOLO11s, photo shrunk to 1024 px) recall | **19.6%** (precision 42.0%) | Live `ablations[0]` |
| Fine-tuned, no tiling, recall | 23.4% | Live `ablations[1]` |
| Fine-tuned + tiling recall (our model) | 86.4% | Live `ablations[2]` |
| + hard negatives (measured, **not kept**: test F2 0.840 vs 0.850) | recall 86.9%, precision 73.8% | Live `ablations[3]`; `scripts/README.md` |

**The label correction — always say it with the number.** Four test photos (`test_MED_0001/2/4/6`)
are 4000×2250 but their label files say 4000×3000, so their 42 person boxes were squashed and sat
above the people. Same predictions, same threshold: published labels 76.9% / 71.3% / 0.723 →
corrected labels **86.4% / 80.2% / 0.868**. Training photos were not affected.
Source: `docs/DETECTOR_LIMITS.md` §1 (lane A, commit `e228036`).
Suggested line: **"86.4% recall, after correcting a label error in 4 test photos."**
Never quote 76.9% / 71.3% any more except as the "before the fix" number.

## Human baseline (published)

| Say | Value | Source |
|---|---|---|
| Time per photo | **33 s** | Pyrrö, Naseri & Jung 2021, arXiv:2111.09406; live `baseline_human` |
| Precision | **59%** | same |
| Recall | **68%** ("a third of people missed") | same |
| 500 photos by hand | **4.6 h** | 500 × 33 s = 16,500 s (derived) |
| Faster per photo than a person | **more than 130×** | 33 s / 0.251 s = 131 (derived) |

Caveat to keep: the 33 s was measured on full 4000×3000 photos. Our 0.25 s is also per full photo,
so that comparison is fair. In the demo, each 1000×750 frame stands for one photo.

## Ranking on the demo survey (lane D)

500 frames from the 101 test photos, 6 of them with a person, simulated flight (block layout, seed 7).

| Say | Value | Source |
|---|---|---|
| All 6 people found within the first … photos reviewed | **7** | Live `ranking.ranked.frames_to_all_hits` |
| First person found at | photo **1**; random order averages **71.6** | Live `ranking.ranked.frames_to_first_hit`, `expected_first_hit_random_order` |
| Time to review until all 6 are found, at 33 s/photo | **under 4 minutes** | 7 × 33 s = 231 s (derived) |

Do **not** compare against "photo 336 in flight order" as if it were a baseline: 336 is this one
flight's order (one layout, one seed), the same reason we quote 71.6 for the first hit. If you use it,
say "in this flight's order (one layout)". The random-order average for the last of 6 people
(about 429) is **not** in `metrics.json`, so don't quote it. (Lane C, 18 Oct.)

## Search map (lane C) — always say "simulated"

30,000 simulated lost hikers (seed 7). Cells are 20 m × 20 m; fewer cells checked is better.
`in_survey` = the 1,536 trials where the person was in ground the drone photographed (overlap ≥ 0.5)
but the photos did not find them.

| Say | Value | Source |
|---|---|---|
| Median cells a ground team checks, inside the surveyed area (demo run) | Sightline **98**, naive ("photographed = cleared") **123**, prior only **137** | Live `search_sim.in_survey.methods[*].median_cells` |
| 90th percentile, same | 216 / 228 / 236 | Live `search_sim.in_survey.methods[*].p90_cells` |
| Robust claim | **at least 10% fewer cells than naive, in every run** (15 runs: 5 canopy-noise levels × 3 seeds, including noise matching our measured canopy error) | `docs/LANE_C_SEARCH.md` "Robustness" (lane C) |
| Over the whole 1 km grid | Sightline 1,197 = naive 1,197; prior only 1,262 | Live `search_sim.methods` |
| How often the drone misses a hiker it flew over | **about half the time** — never an exact % (the two counts use different rules) | Lane C, 18 Oct |
| Survey found the person itself | 5% of all trials | Live `search_sim.found_by_drone_rate` |

Lane C's suggested line: **"In the demo run, Sightline's map needs 98 cells against 123 for a naive
map inside the surveyed area (simulated); across seeds and with our canopy estimate's measured
error it stays at least 10% better, in every run."** 98 vs 123 is seed 7 at default noise, the best
of the three seeds, so always pair it with "at least 10%".

Do not claim a whole-grid win: Sightline ties naive there, because the survey covers only part of
the grid and the prior is a flat placeholder (`map.json` `params.prior_source = "placeholder"`).

## Limits (what it gets wrong)

| Say | Source |
|---|---|
| Misses cluster by site, not by size: two sites hold 28 of the 46 misses; the median missed person is the same size as the median found one | `docs/DETECTOR_LIMITS.md` §2 |
| What it misses: people in groups, clothing that matches pale or dark rock, people sitting or lying down | `DETECTOR_LIMITS.md` §2, "Honest limits" |
| False alarms (72): most look like unlabelled people or a second box on a person; a few bags and shadows | `DETECTOR_LIMITS.md` §3 |
| Threshold trade-off: 0.10 → recall 91.1% at 66.3% precision; 0.50 → 79.2% at 87.3% | `DETECTOR_LIMITS.md` §4 |
| Canopy estimate error: MAE 0.34 | Lane C (`LANE_C_SEARCH.md`) |
| Assumes each photo is an independent look | Lane C |
| Simulated flight path and simulated search evaluation; the 10 m clear radius is assumed | Lane C; app labels |

## The project

| Say | Value | Source |
|---|---|---|
| Automated tests | 886 (649 Python, 237 web) | `pytest --collect-only` and `pnpm test` on `origin/lane-d` `028479e` (17 Oct evening; more were added since) |

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
