# LADD: the frozen detector on a dataset it has never seen

Measured 22 Oct 2026. One run, no tuning: the weights-v2 detector exactly as shipped, the judge path
of `scripts/reproduce_cv2.py`, and the threshold 0.29 chosen on HERIDAL val in sprint 1.

**Result.** On all 1,365 LADD photos (4,733 people) the detector finds about half the people:
VOC precision / recall / AP50 **0.509 / 0.516 / 0.458**, against 0.802 / 0.864 / 0.868 on the HERIDAL test
set and recall 0.825 at the four HERIDAL test sites outside training. HERIDAL test numbers say little
about photos from a different country, season and drone, and this is the size of that gap.

## What LADD is

The Lacmus Drone Dataset comes from the Lacmus project, Russian volunteers working with search and
rescue teams ([ladd-utils](https://github.com/lacmus-foundation/ladd-utils)). It has drone photos of
people placed in the poses lost people are found in, one class ("Pedestrian"), VOC boxes, and three
seasons: summer, spring and winter. The copy scored here has 1,365 photos and 4,733 people; every photo
has at least one person (3.5 on average, up to crowds of more than ten).

How it differs from HERIDAL, which the detector was trained on (Croatian and Bosnian wilderness,
mostly 4000×3000 photos from 40–65 m, people about 60×60 px, `docs/LANE_A_ML.md:41`):

- **Terrain and season.** In the photos I looked at: pine and birch forest, ploughed fields, a
  snow-covered park. By a colour proxy (half or more of the photo bright and unsaturated) 308 of the
  1,365 photos are mostly snow. HERIDAL has no snow scenes.
- **Poses.** LADD's authors chose 24 poses in which lost people are typically found (Dataset Ninja's
  summary), and many LADD people lie on the ground, curled or half under branches.
- **Cameras.** Seven photo sizes from 4000×2250 to 5472×3648 (DJI Mavic and Phantom models). HERIDAL
  is 4000×3000 with a few 4000×2250.
- **Person size is about the same.** The median box short side is 52 px, and recall barely changes
  with size (table below), so scale does not explain the gap.

## Result

`docs/evidence/ladd/20261022T174430Z/ladd.json`, `ladd.md`; breakdown in `breakdown.json` beside them.

| Set | Photos | People | VOC precision | VOC recall | AP50 | SAR-APD P / R |
|---|---|---|---|---|---|---|
| **LADD, all photos (never seen)** | 1,365 | 4,733 | **0.509** | **0.516** | **0.458** | 0.677 / 0.649 |
| HERIDAL test | 101 | 337 | 0.802 | 0.864 | 0.868 | 0.898 / 0.896 |
| HERIDAL test, 4 sites outside training | 32 | 114 | | 0.825 | | |

HERIDAL rows: `docs/report/OPENCV_REPORT.md:294-296`, `docs/DETECTOR_LIMITS.md:117`.

At 0.29 the detector found 2,444 people, missed 2,289 and raised 2,357 false alarms (1.73 per
photo). With a looser match (any box at IoU ≥ 0.1 counts, one per person) recall is 0.609, so about
one miss in ten is a box drawn around the person but not matching the label at IoU 0.5. The other
nine are not seen at all.

Where the misses are (VOC recall at 0.29; `breakdown.json`):

| Split | Recall on LADD | Recall on HERIDAL test |
|---|---|---|
| Person under 40 px (sqrt of box area) | 0.532 (333 people) | 0.88 |
| 40–60 px | 0.535 (1,606) | 0.83 |
| 60–90 px | 0.539 (2,199) | 0.92 |
| 90 px and up | 0.444 (595) | 0.70 |
| Photos mostly snow (proxy) | 0.436 (1,185) | no snow in HERIDAL |
| Other photos | 0.543 (3,548) | |
| 4056×3040 photos (one camera, a winter set) | 0.111 (307) | |
| One person in the photo | 0.639 (446) | |

The 4056×3040 set is winter park and forest, with dark-clothed people lying in snow under bare trees.
The detector puts almost no boxes there. Without snow, recall is still 0.543, so snow accounts for
only part of the gap: green pine forest, dry spring grass, ploughed soil and people lying down are
all outside what the detector learned from HERIDAL.

## What the lower number means

- **This is the honest number for new terrain.** HERIDAL's 0.864 is measured on the dataset the
  model was trained on. The 0.825 at unseen HERIDAL sites is still the same kind of terrain. LADD shows
  that a different country, season and set of poses takes recall down to about half. I do not claim
  0.86 anywhere outside HERIDAL-like terrain.
- **It is not a bug in the evaluation.** The photos go through the same functions that reproduce the
  HERIDAL test numbers exactly (`scripts/reproduce_cv2.py`), the boxes are scored by the same
  `score_voc` / `score_sar`, and the labels were checked by drawing them and the detections on six
  photos (every label sits on a person). The CUDA path gives the same boxes as the CPU path (`docs/report/CV2_CUDA.md`); on a
  5-photo stand-in the two gave identical scores here too.
- **What it changes in the product.** The search map treats a photo with no detection as lowering the
  chance of a person in that cell, not as ruling the cell out, and the detector's recall sets how much
  (`pod = min(pod_cap, recall × (1 − c) × a)`, `docs/LANE_C_SEARCH.md:74`). On terrain like LADD that recall should be about 0.5, not
  0.86, so an empty photo should lower the cell's probability much less. The verifier and the
  operator review step matter more on such terrain.
- **What would fix it.** Training on more varied terrain (LADD's own photos, SARD, winter imagery) and
  then re-scoring on a held-out part. That is retraining and was out of scope here: this run is a
  measurement of the frozen model only.

## How it was run

```bash
# data: the Dataset Ninja copy of LADD (Supervisely format), 8,487,342,080 bytes
mkdir -p data/ladd/archive && curl -L -C - -o data/ladd/archive/ladd-DatasetNinja.tar '<URL>'
# <URL>: the "Download" link on https://datasetninja.com/lacmus-drone-dataset (assets.supervisely.com);
# the host drops long transfers, so repeat the curl until the file is complete
sha256sum data/ladd/archive/ladd-DatasetNinja.tar   # a5776be947843530d0b914f0fb9079ef549463d67b19e064a0abd02a52f1ac0c
mkdir data/ladd/extracted && tar -xf data/ladd/archive/ladd-DatasetNinja.tar -C data/ladd/extracted

# the one run (CPU, as the judge path; add --backend cuda with a CUDA build of OpenCV)
CUDA_VISIBLE_DEVICES= uv run python scripts/analysis/eval_ladd.py --data-root data/ladd/extracted
uv run python scripts/analysis/ladd_breakdown.py runs/ladd/<ts> --data-root data/ladd/extracted
```

- Model `sightline-detector-v2.onnx` from release `model-onnx-v2` (sha256 `095fcc43…`), 1024 px slices
  with 0.2 overlap, merge NMS at IoU 0.5, threshold 0.29 checked against `detector_metrics.json`.
- Run here on the GPU: OpenCV 5.0.0 built with CUDA (`docs/report/CV2_CUDA.md`), FP32, classic engine,
  RTX 4080 SUPER. **Wall time 472 s for the 1,365 photos, 0.35 s per photo.** The CPU path was not
  timed on LADD; it took 4 min 58 s for HERIDAL's 101 photos on the same machine, so expect more than
  an hour for these 1,365 (many are larger than 4000×3000).
- The script appends each photo's boxes to `runs/ladd/<ts>/preds.jsonl` as it goes; `--resume
  runs/ladd/<ts>` continues an interrupted run.
- **Split.** The original release has `ImageSets/Main/test.txt`, and `eval_ladd.py` scores only that
  split when it finds one. The Dataset Ninja copy carries no split (one dataset, `ds0`), so all 1,365
  photos were scored. Nothing was trained on any of them, so every photo is unseen.
- **Where the data came from.** The Mail.ru link in the ladd-utils README
  (`https://cloud.mail.ru/public/2k53/2bJVwYSa7`) answers `not_exists`, and the Kaggle copy
  (`mersico/lacmus-drone-dataset-ladd-v40`) needs a login. Dataset Ninja's copy has the same photo
  and box counts as its published LADD statistics (1,365 / 4,733) and states the GPL-3.0 licence. No
  hash is published for it, so the sha256 above is the one I measured. Its boxes are the LADD VOC
  boxes converted to Supervisely JSON by Dataset Ninja; one photo has EXIF orientation 3 (rotated
  180°), which `cv2.imread` applies; whether the labels follow it was not checked, and one photo of
  1,365 cannot move the scores.

## Licence

LADD is published under GPL-3.0, and its README adds that the licence "applies not only to the
dataset, but also to ALL SOFTWARE products that use it to one degree or another". Sightline did not
train on LADD and ships nothing from it: no photo, label or derived weight is in the repository or a
release. The data sits under the git-ignored `data/` folder on the machine that ran the evaluation,
and the evidence files hold only aggregate scores. Measuring a model on the dataset and reporting
the result is not distribution, so I do not take the clause as reaching Sightline's code. If the
owners read it otherwise, the evidence files can be removed without touching anything else.
