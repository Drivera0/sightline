# Numbers we say out loud, and where each one comes from

Rule: no number goes on a slide, in a script or on Devpost unless it is in this table.
"Live" = `https://sightline-iota-sandy.vercel.app/cache/demo/metrics.json`, built from commit
`2b3a85f` at 2026-10-18 10:08 UTC (`manifest.json`). Checked against the live file and the Results
page on 18 Oct. If the demo cache is rebuilt, re-check this table.

**Headline rule (matches the site and README):** compare with people using the human study's own
scoring (SAR-APD): **90% recall vs 68%**. Everywhere else (ablations, threshold, search map) use
strict VOC: **86.4%**.

## Detector (lane A)

Test set: the 101 HERIDAL test photos (337 people), never used for training or for choosing the
threshold. Scoring: VOC, one box per person, IoU ≥ 0.5. Threshold 0.29, chosen on validation photos.

| Say | Value | Source |
|---|---|---|
| **Headline vs people** — recall / precision, SAR-APD scoring (the human study's own rule) | **90%** (89.6%) / **89.8%** vs people 68% / 59% | Live `detector.sar`; Results page "Recall 90%"; README table |
| Recall, strict VOC (one box per person, IoU ≥ 0.5) | **86.4%** | Live `detector.voc.recall` 0.864 |
| Precision, strict VOC | **80.2%** | Live `detector.voc.precision` 0.802 |
| AP50 | 0.868 | Live `detector.voc.ap50` |
| Time per full 4000×3000 photo | **0.25 s** (0.251) | Live `detector.seconds_per_image` (RTX 4080 SUPER) |

Ablations (strict VOC, test set; live `ablations`, in this order):

| Variant | Recall | Precision |
|---|---|---|
| Stock model, photo shrunk | **19.6%** | 42.0% |
| Fine-tuned on tiles, run on shrunk photos | 23.4% | 38.0% |
| Stock model, full-resolution photo | 18.1% | 67.8% |
| Fine-tuned on tiles, one full-resolution pass (not used: about 20× the GPU memory) | 90.5% | 72.3% |
| Trained and run on whole photos (1920 px) | 80.4% | 72.7% |
| **Fine-tuned + tiling (the model in use)** | **86.4%** | **80.2%** |
| + hard negatives (**not kept**: test F2 0.840 vs 0.850) | 86.9% | 73.8% |

Lesson the site draws: native resolution is what pays off; tiling is the way that fits a small GPU.

**Disclosure — say it if asked about overfitting** (README "Disclosure"): the threshold and every
inference setting were chosen on validation, but two earlier choices were made with test scores in
view (keeping training run 2 over run 1; dropping hard negatives). So the test numbers are
**slightly optimistic**. Every later choice was made on validation only.

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
say "in this flight's order (one layout)", as the Results page does. The Results page now also shows
the random-order expected value for the last of 6 people: **about 429** (10–90%: 342–492), computed
exactly on the page. It is not in `metrics.json`; quote it only as "a random order needs about 429",
pointing at the Results page.

## Search map (lane C) — always say "simulated"

30,000 simulated lost hikers (seed 7). The map now uses **5 m × 5 m cells** (40,000 cells over
1 km²; it was 20 m until 18 Oct, so every older number is void). Fewer cells checked is better.
`in_survey` = the 1,341 trials where the person was in ground the drone photographed (overlap ≥ 0.5)
but the photos did not find them.

| Say | Value | Source |
|---|---|---|
| Median cells a ground team checks, inside the surveyed area (demo run) | Sightline **1,213**, naive ("photographed = cleared") **1,743**, prior only 2,038 → **30% fewer** | Live `search_sim.in_survey.methods[*].median_cells`; Results page |
| Same, as ground area | **about 3.0 ha vs 4.4 ha** (1,213 / 1,743 × 25 m²) | Results page (derived) |
| 90th percentile, same | 2,940 / 3,348 / 3,560 | Live `search_sim.in_survey.methods[*].p90_cells` |
| Robust claim | Beats naive in **all 15 runs** (3 seeds × 5 canopy-noise levels). With noise matching our canopy estimate's measured error (σ 0.43): **19–23% fewer cells** on every seed (1,395 vs 1,810 · 1,407 vs 1,775 · 1,516 vs 1,879). Even at the highest noise tried (0.55): 17–21% fewer. | `docs/LANE_C_SEARCH.md` "Robustness", 5 m table (`origin/main`) |
| Over the whole 1 km grid | Sightline 19,103 = naive 19,103; prior only 20,224 (a tie) | Live `search_sim.methods` |
| How often the drone misses a hiker it flew over | **about half the time** — never an exact %. ⚠ Lane C gave this on the 20 m map; **ask Harvir to confirm it still holds at 5 m** before saying it. | Lane C, 18 Oct |
| Survey found the person itself | 5% of all trials (0.051) | Live `search_sim.found_by_drone_rate` |

Suggested line: **"In the demo run, inside the area the drone photographed, Sightline's map has the
ground team check 30% fewer cells than a naive map: about 3 hectares instead of 4.4 (simulated).
With our canopy estimate's measured error it is still about a fifth fewer, on every seed."**
30% is seed 7 at default noise, the best of the three seeds, so always pair it with the "about a
fifth" line. Limit lane C states: the noise is random while the classifier's real errors are
systematic (it misses pale and autumn trees), so even 19–23% is somewhat optimistic.

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
| Person size | **about 70 px wide** in a full 4000×3000 photo (about 0.04% of it); about 65 px in a 1000 px demo frame | README "How the detector works"; Results page; home page |
| Data | HERIDAL, Božić-Štulić, Marušić & Gotovac 2019; VOC copy by Pyrrö 2021, CC BY 3.0 | `README.md` |

Check before stage: the three problem facts come from the original deck's research; re-open the
DroneXL / CBC articles once and confirm the wording.
