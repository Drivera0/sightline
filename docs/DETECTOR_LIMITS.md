# Detector limits: where Sightline's detector fails

Analysis of the weights-v2 detector (`yolo11s-heridal-tiled`, single-view tiled inference) on the
HERIDAL **test** split: 101 photos, 337 people. Analysis only: nothing here was tuned on the
test set. The threshold, 0.29, is the one recorded in the weights-v2 release
(`detector_metrics.json`, chosen on validation). Since 2026-10-18 the reported detector adds
photo + mirror TTA at threshold 0.32 (test P 0.835 / R 0.858 / AP50 0.872, `scripts/README.md`);
§§1–4 below still describe the single-view model at 0.29.

Every number below is in `data/work/analysis/limits.json` and reproduces with:

```bash
gh release download data-v1  -R Drivera0/sightline -p heridal_test_split.zip   # → data/heridal/yolo_full/test/
gh release download weights-v2 -R Drivera0/sightline -D data/weights/release_v2
uv run python scripts/analysis/detector_errors.py      # GPU if present; caches predictions
```

The label check also needs the raw HERIDAL VOC annotations
(`data/heridal/raw/heridal_keras_retinanet_voc/Annotations`, see `scripts/README.md`).
`tests/ml/test_detector_errors.py` checks that the script counts hits and false alarms exactly
like the official scorer (`sightline.ml.evaluate.score_voc`).

## 1. A label bug that undercounted the detector (fixed 2026-10-18)

Four test photos (`test_MED_0001`, `0002`, `0004`, `0006`) are 4000×2250 JPEGs whose VOC files
say 4000×3000. Our converter trusts the XML size, so their 42 person boxes were squashed to 0.75
of their height and land above the people (draw the labels and the predictions on any of the
four photos and the offset is obvious). The raw VOC coordinates are correct pixel positions. No training or
validation photo is affected (all 1,546 trainval photos are 4000×3000 and agree with their XML),
so the model was trained on correct labels; only the test score is wrong.

Same predictions, same threshold, scored two ways:

| | Published labels | Label-checked (42 boxes read at their true positions) |
|---|---|---|
| Recall | 0.769 | **0.864** |
| Precision | 0.713 | **0.802** |
| AP50 | 0.723 | **0.868** |
| People missed | 78 | 46 |
| False alarms | 104 | 72 |

**Fixed.** `sightline/ml/voc.read_voc` now takes the size from the JPEG header, the converter
reports any XML whose size disagrees (exactly these four), the data-v1 test zip and the weights-v2
`detector_metrics.json` were re-uploaded, and `scripts/evaluate_model.py` re-measured every
ablation row on the corrected labels: 0.802 / 0.864 / 0.868 for the final model, the same as the
label-checked column above. The threshold (0.29, chosen on validation) did not change. The
"Published labels" column is the old, squashed score, kept here for the record.

Everything below uses the label-checked set, so it describes the detector, not the bug.

## 2. Which misses dominate (46 people)

**Site matters more than anything we can measure about the person.** Six of the twelve sites have
no misses at all; two sites hold 28 of the 46 misses:

| Site | People | Missed | Recall |
|---|---|---|---|
| MED | 52 | 16 | 0.69 |
| CAB | 34 | 12 | 0.65 |
| ZRI | 47 | 8 | 0.83 |
| BLI | 46 | 6 | 0.87 |
| CAP, GRO | 40 | 4 | 0.90 |
| BRA, BRK, BRS, MOB, SB, TRS | 118 | 0 | 1.00 |

MED is dark, broken, red-brown rock with dense groups of people; CAB is pale limestone and grass
where people in white or grey match the rocks.

**Size, light and vegetation explain little** (`recall_by_kind.png`):

| Person size (√ box area) | People | Recall |
|---|---|---|
| under 40 px | 34 | 0.88 |
| 40–60 px | 175 | 0.83 |
| 60–90 px | 118 | 0.92 |
| 90 px and up | 10 | 0.70 |

The median missed person is 55.7 px, the same as the median found person. Shade (surroundings
darker than 0.75 of the photo's median brightness) gives recall 0.84 against 0.87 in sun;
"in vegetation" (at least 35 % green pixels in the box) gives 0.90 against 0.85 on open ground.
Both are **proxies**: HERIDAL has no occlusion or lighting tags (every box is `truncated=0,
difficult=0`).

**What the misses look like** (`gallery_missed.jpg`, our reading of the 40 smallest misses, not
a measured count):

- people standing close together, where one box covers the group and the neighbour is missed;
- clothing that matches the ground: white or grey on limestone (CAB), dark on dark rock (MED);
- people sitting on benches or beside objects, or lying down;
- a few labelled boxes where we can see no person at this resolution.

## 3. False alarms (72 at threshold 0.29)

Median confidence of a false alarm is 0.51. By site: ZRI 17, BLI 13, BRS 9, SB 8, MED 7, the
rest 4 or fewer. By size, most are 40–60 px (30) or under 40 px (23).

In `gallery_false_alarms.jpg` (the 40 most confident), **most look like real people to us**:
people missing from the annotations, or a second box on a person who is labelled. A handful are
bags, backpacks, dark objects on paths, or shadows. So precision is probably understated too; we
have not relabelled anything beyond the size bug, so we report 0.802 and no higher.

## 4. Threshold

`threshold_curve.png`: recall and precision from 0.05 to 0.95, label-checked (solid) and
published (dotted), with 0.29 marked. Lowering the threshold to 0.10 would raise label-checked
recall to 0.911 at precision 0.663; raising it to 0.50 drops recall to 0.792 at precision 0.873.
For search and rescue a miss costs more than a false alarm a person dismisses in seconds, which
is why the validation set chose an F2-optimal threshold.

## 5. Validation and test come from different sites

Our validation split is a seeded 10 % of the HERIDAL trainval photos, split by photo, so its 13
sites (BLA, BRA, BRK, BRS, CAP, GOR, JAS, MED, RAK, SB, TRS, VRD, ZRI) are exactly the training
sites. The official test split has four sites that appear in neither training nor validation:
**BLI, CAB, GRO and MOB, 32 of the 101 test photos and 114 of the 337 people**. So every
threshold and setting is chosen on terrain the model has trained on, then scored partly on
terrain it has never seen. Validation numbers are therefore an optimistic guide to new sites:
on the test photos, recall is 0.883 on the 223 people at trained sites and 0.825 on the 114
people at the four new sites (single-view model, threshold 0.29); with the TTA adopted on
2026-10-18 it is 0.879 and 0.816 (threshold 0.32). The final model's val F2 is 0.857 and its
test F2 0.853; the gap is small overall, but the new sites alone are clearly harder.

A site-held-out validation split (whole sites kept out of training) would fix this, but it
needs a retrain without those sites. `scripts/make_site_holdout.py` builds one (GOR and RAK held
out: 186 photos, 331 people, neither site in test); the retrain on it was started on 2026-10-18
but not finished (see `docs/LANE_A_ML.md` §6.3a), so weights-v2 is still validated on its
original, site-shared split.

## Honest limits: one page for the deck

1. **`threshold_curve.png`**: the trade-off and where we sit. Recall 0.864 / precision 0.802
   (the dotted line is the old score on the squashed labels, 0.769 / 0.713).
2. **`gallery_missed.jpg`**: what it misses. Groups, camouflage against pale or dark rock, people
   on benches or lying down. Size alone is not the problem.
3. **`gallery_false_alarms.jpg`**: what it flags wrongly. Mostly unlabelled people and second
   boxes; a few bags and shadows. A reviewer clears these in seconds, which is why Sightline
   ranks for review instead of deciding.

Also in `docs/figures/limits/`: `recall_by_kind.png` (size, light, vegetation) and
`misses_by_site.png`.

Photos: HERIDAL (Božić-Štulić, Marušić & Gotovac, 2019), VOC copy by Pyrrö (2021), CC BY 3.0.
