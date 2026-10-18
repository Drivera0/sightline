# Data prep scripts (lane A)

Everything here runs offline on the GPU desktop. Outputs live under `data/`, which is git-ignored.

## Getting the data

Full HERIDAL (8.3 GB, CC BY 3.0) is only needed on the training machine:

```bash
# Zenodo throttles each connection to ~0.3 MB/s; aria2 with 16 connections gets ~2.5 MB/s.
aria2c --disable-ipv6=true -x 16 -s 16 -o data/heridal/raw/heridal_keras_retinanet_voc.zip \
  "https://zenodo.org/api/records/5662351/files/heridal_keras_retinanet_voc.zip/content"
cd data/heridal/raw && tar -xf heridal_keras_retinanet_voc.zip --exclude '__MACOSX/*'
```

Teammates only need the **test split** (101 images + YOLO labels, 499 MB), published as a GitHub release:

```bash
gh release download data-v1 -R Drivera0/sightline -p heridal_test_split.zip
# unzip into data/heridal/yolo_full/ so you get data/heridal/yolo_full/test/
```

MD5 `ad049654b80bf739e780ffbd9a52972d` (re-uploaded 2026-10-18 with four corrected MED label files; the first upload was
`c5dc48d8bae53cd09b2933e98327e3ab`). Test data only: never train on it, never commit it.

## Scripts

| Script | What it does | Output |
|---|---|---|
| `convert_heridal.py` | VOC XML → YOLO txt using the official `trainval`/`test` lists; val = seeded 10 % of trainval, split by image (`seed=7`). Images are hard-linked, not copied. | `data/heridal/yolo_full/{train,val,test}/{images,labels}`, `convert_report.json` |
| `tile_dataset.py` | Cuts train and val images into 1024 px tiles, 20 % overlap. Keeps a box if ≥ 50 % of it is inside the tile and it's ≥ 8 px a side; since 2026-10-18 a person who fails that rule but is still visible is blacked out in that tile (`--no-mask-partial` restores the old behaviour, which is how the weights-v2 tiles were made). Keeps every tile with a box plus a seeded 25 % of empty tiles. | `data/heridal/yolo_tiles/{train,val}`, `dataset.yaml`, `tile_report.json` |
| `analysis/detector_errors.py` | Error analysis of the final detector on the test split (analysis only, never tuning): misses and false alarms by size, light, vegetation and site, threshold curve, galleries, and a check for test photos whose XML size disagrees with the JPEG. Findings: `docs/DETECTOR_LIMITS.md`. | `data/work/analysis/limits.json`, `docs/figures/limits/` |

Run order: `convert_heridal.py`, then `tile_dataset.py`. Both print a JSON report with the counts.

Expected counts (match the HERIDAL paper): 1,546 trainval images / 2,892 boxes, 101 test images / 337 boxes.
The raw archive also contains 37 JPEGs and 3 XMLs that are in no official list; they are reported and ignored.

Logic lives in `sightline/ml/voc.py` and `sightline/ml/tiling.py`; tests in `tests/ml/`.

## Event-time scripts (GPU)

| Script | What it does | Output |
|---|---|---|
| `evaluate_model.py` | Chooses `candidate_threshold` on **val** (max F2, tiled inference), then scores the 4 ablation rows on the full **test** set with VOC and SAR-style matching. | `data/work/detect/detector_metrics.json` (contract `DetectorMetrics` + `Ablation` rows), `evaluate_details.json` |
| `tune_on_val.py` | Validation-only sweep of SAHI merge settings (overlap 0.1/0.2/0.3 × NMS/NMM/GREEDYNMM × IOU/IOS × match 0.3–0.7), threshold re-chosen by max F2 for each; paired bootstrap (2,000 resamples over val photos, seed 7) against the current default; the secondary high-recall threshold. Never reads test. | `data/work/tune/val_tuning.json` |
| `tta_on_val.py` | Validation-only test of test-time augmentation: 1, 2, 4 or 8 flip/rotation views fused by pooled NMS or weighted box fusion, with seconds per photo and a paired bootstrap against no TTA. | `data/work/tune/val_tta.json` |
| `mine_hard_negatives.py` | Tiled inference over training images; cuts a 1024 tile around every false positive (conf ≥ 0.25, IoU < 0.1 to all truth), capped at 2,000, seeded. Writes a YAML that trains on tiles + hard negatives. | `data/heridal/hard_negatives/{images,labels}`, `data/heridal/dataset_hn.yaml` |

Detection on the demo frames is one call, `sightline.ml.run_survey(...)` (see `sightline/ml/survey.py`); D's
`detect` stage wraps it. The library code: `detect.py` (`Detector`: `detect_frame`, `detect_tiled` via SAHI,
`detect_resized`), `evaluate.py` (scoring, threshold choice), `crops.py`, `hard_negatives.py`, `data.py`.
Until lane D lands `sightline/contract.py`, the metrics models come from `sightline/ml/_contract_shim.py`.

## Results (released as `weights-v2`; `detector_metrics.json` re-measured 2026-10-18 on the corrected test labels)

Final model: **run 2**, yolo11s, 80 epochs on 1024 px tiles from the 890 *annotated* training photos only
(the Zenodo copy has ~560 train/val photos with empty annotation stubs, some showing unlabelled people).
Threshold **0.29**, chosen on annotated **val** photos by max F2. Full 101-image HERIDAL test set, VOC scoring
(greedy one-to-one, IoU ≥ 0.5); precision/recall at the threshold, AP50 over all confidences.

| Row | Precision | Recall | AP50 | s / image |
|---|---|---|---|---|
| Stock model, no tiling (COCO yolo11s, resized to 1024) | 0.420 | 0.196 | 0.142 | 0.06 |
| Fine-tuned, no tiling (run 2 weights, resized to 1024) | 0.380 | 0.234 | 0.144 | 0.06 |
| Fine-tuned + tiling | **0.802** | **0.864** | **0.868** | 0.25 |
| + hard negatives (484 mined tiles, 20-epoch fine-tune) | 0.738 | 0.869 | 0.851 | 0.24 |

The hard-negative model was measured but not kept: test F2 0.840 vs 0.850 for run 2.

**Disclosure: two earlier model choices looked at test scores.** Keeping run 2 over run 1, and dropping the
hard-negative model (test F2 0.840 vs 0.850), were both decided with test-set numbers in view, which the rules
forbid; the thresholds were always chosen on val. A retroactive check on the annotated val photos (single-view tiled inference, each model at its own max-F2
threshold, paired bootstrap, 2,000 resamples, seed 7; `scripts/analysis/retro_val_check.py`, `data/work/tune/retro_val.json`) shows val could not have
made either call: run 2 vs run 1 val F2 0.831 vs 0.829 (ΔF2 +0.002, 95 % CI [−0.028, +0.031]); hard negatives vs
run 2 val F2 0.841 vs 0.831 (ΔF2 +0.010, 95 % CI [−0.011, +0.031], so val leaned slightly towards the model we
dropped). Run 2 still has its own reason, independent of any score: it drops ~500 photos with empty annotation stubs,
some showing unlabelled people. Still, the test score of the kept model is slightly optimistic. Since 2026-10-18 every
choice is made on val with a paired bootstrap (`tune_on_val.py`, `tta_on_val.py`) and test is scored once at the end.

**Label fix, 2026-10-18.** Four MED test photos are 4000x2250 JPEGs whose VOC files say 4000x3000; the converter
trusted the XML and squashed their 42 boxes to 0.75 of their height. `read_voc` now takes the size from the JPEG.
No training or validation label changed, so the weights and the threshold are the same; only the test score moved
(it was 0.713 / 0.769 / 0.723). See `docs/DETECTOR_LIMITS.md`. Reproduce with
`python scripts/evaluate_model.py --weights data/runs/tiles_s_v2/weights/best.pt --hn-weights data/runs/tiles_s_v2_hn/weights/best.pt --final tiled --model-name yolo11s-heridal-tiled-run2`.
Run 1 (trained on all 1,391 train photos, incl. the unannotated ones) scored 0.681 / 0.754 / 0.711 at threshold 0.21 (`weights-v1`).
Human baseline (Pyrrö et al. 2021): precision 0.59, recall 0.68, 33 s per photo.
SAR-style loose matching (approx. AIR) for the final model: precision 0.898, recall 0.896.
`metrics.detector.recall` for lane C's POD: **0.864**. Demo survey (500 frames, seed 7): 15 review-queue crops, all 6
frames with a person in the queue, first hit ranked 1 vs 73 in flight order (71.6 expected at random).

**Why "Fine-tuned, no tiling" scores below the stock model:** trained only on full-resolution 1024 px tiles, where a person is about 50 px tall, the fine-tuned model still finds people in a whole photo shrunk to 1024 px (a person becomes about 13 px) but draws boxes about twice too big, so they fail the IoU 0.5 test; tiling is what makes fine-tuning pay off.
(Checked with run 1 weights, before the label fix: both rows use the same 1024 px input, the same F2 threshold rule and the same scoring. The fine-tuned weights are run 1 `best.pt`, MD5 2f38d69c… Median predicted box height on test: 115 px fine-tuned vs 73 px stock vs 52 px true. People found with a sloppy box, IoU 0.1–0.5: 70 fine-tuned vs 34 stock.)

**Rows that weren't run are omitted, never zero-filled.** `write_detector_metrics` refuses an all-zero row, and the metrics screen shows any missing or all-zero row as "Not yet measured". Trained and evaluated 2026-10-17 on an RTX 4080 SUPER.

## Training (timing run, then run 1)

```bash
yolo detect train model=yolo11s.pt data=data/heridal/yolo_tiles/dataset.yaml imgsz=1024 \
  epochs=<n> batch=-1 patience=15 seed=7 single_cls=True degrees=180 flipud=0.5 fliplr=0.5 \
  close_mosaic=10 project=data/runs name=tiles_s
```

Start long runs in a terminal on the desktop's own session, not over SSH.
