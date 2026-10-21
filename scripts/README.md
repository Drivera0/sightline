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
| `av_chain.py`, `trace_excerpt.py` | One real Agentic Vision chain on a val near-miss (OpenCV re-look → Nemotron VL → proposal → scripted approval) through the production agent code, and the printer for any proposal's causal chain from `trace.jsonl`. Evidence page: `docs/architecture/agent.md`. | `runs/av_chain/<mission>/` |
| `eval_verifier.py` | The verifier (`sightline/agent/verify.py`, Nemotron VL on Token Factory) on the detections its rules can change; compares promote/demote rules by F2 and reports accuracy, small-crop accuracy, tokens and latency. Val by default; test only once, after the rule is chosen. Results: `docs/LANE_A_ML.md` §6.8. | `runs/verifier/<split>-<timestamp>.csv`, `.json` |
| `export_onnx.py` | Exports the weights to ONNX with a variable input size (`dynamic=True`, imgsz 1024, opset 17) as `<stem>-dynamic.onnx`, so cv2.dnn pads frames like `YOLO.predict`. | `data/weights/release_v2/yolo11s_tiles_run1_best-dynamic.onnx` |
| `parity_table.py` | OpenCV 5 `cv2.dnn` vs Torch on the same photos at the frozen threshold: scores, box agreement, speed (A-X3). Tunes nothing; reads test once to check agreement. | `runs/parity/<timestamp>.json`, Markdown table |
| `evaluate_model.py` | Chooses `candidate_threshold` on **val** (max F2, tiled inference), then scores the 4 ablation rows on the full **test** set with VOC and SAR-style matching. | `data/work/detect/detector_metrics.json` (contract `DetectorMetrics` + the 4 core `Ablation` rows), `evaluate_details.json` |
| `tune_on_val.py` | Validation-only sweep of SAHI merge settings (overlap 0.1/0.2/0.3 × NMS/NMM/GREEDYNMM × IOU/IOS × match 0.3–0.7), threshold re-chosen by max F2 for each; paired bootstrap (2,000 resamples over val photos, seed 7) against the current default; the secondary high-recall threshold. Never reads test. | `data/work/tune/val_tuning.json` |
| `tta_on_val.py` | Validation-only test of test-time augmentation: 1, 2, 4 or 8 flip/rotation views fused by pooled NMS or weighted box fusion, with seconds per photo and a paired bootstrap against no TTA. | `data/work/tune/val_tta.json` |
| `make_site_holdout.py`, `train_site_holdout.py`, `compare_on_holdout.py` | Site-held-out split from trainval (GOR + RAK out; never touches test), run-2-recipe retrain on it, and a paired-bootstrap comparison of models on the held-out sites. | `data/heridal/yolo_site/`, `data/runs/site_*`, `data/work/tune/holdout_compare.json` |
| `evaluate_no_tiling.py`, `train_whole_photos.py` | Fair no-tiling baselines: whole photos in one pass at native scale (imgsz 4000), and the run 2 recipe trained on whole photos resized to 1920 px; threshold on val, test once. `--write-metrics` adds the rows to `detector_metrics.json` without touching its `detector` block. | `data/work/detect/no_tiling_baselines.json`, `data/runs/whole_s_1920_e80/` |
| `mine_hard_negatives.py` | Tiled inference over training images; cuts a 1024 tile around every false positive (conf ≥ 0.25, IoU < 0.1 to all truth), capped at 2,000, seeded. Writes a YAML that trains on tiles + hard negatives. | `data/heridal/hard_negatives/{images,labels}`, `data/heridal/dataset_hn.yaml` |

Detection on the demo frames is one call, `sightline.ml.run_survey(...)` (see `sightline/ml/survey.py`); D's
`detect` stage wraps it. The library code: `detect.py` (`Detector`: `detect_frame`, `detect_tiled` via SAHI,
`detect_resized`), `evaluate.py` (scoring, threshold choice), `crops.py`, `hard_negatives.py`, `data.py`.
Until lane D lands `sightline/contract.py`, the metrics models come from `sightline/ml/_contract_shim.py`.

## Results (released as `weights-v2`; `detector_metrics.json` re-measured 2026-10-18 on the corrected test labels)

Final model: **run 2**, yolo11s, 80 epochs on 1024 px tiles from the 890 *annotated* training photos only
(the Zenodo copy has ~560 train/val photos with empty annotation stubs, some showing unlabelled people).
Threshold **0.29**, chosen on annotated **val** photos by max F2, single-view tiled inference. Full 101-image HERIDAL
test set, VOC scoring (greedy one-to-one, IoU ≥ 0.5); precision/recall at the threshold, AP50 over all confidences.

| Row | Threshold (val) | Precision | Recall | AP50 | F2 | SAR P / R | s / image |
|---|---|---|---|---|---|---|---|
| Stock model, no tiling (COCO yolo11s, photo shrunk to 1024) | 0.06 | 0.420 | 0.196 | 0.142 | 0.219 | 0.752 / 0.252 | 0.06 |
| Fine-tuned on tiles, run on shrunk photos (run 2 weights, photo shrunk to 1024; was "Fine-tuned, no tiling") | 0.05 | 0.380 | 0.234 | 0.144 | 0.254 | 0.745 / 0.442 | 0.06 |
| Stock model, full-resolution photo (COCO yolo11s, imgsz 4000, no slicing) | 0.06 | 0.678 | 0.181 | 0.165 | 0.212 | 0.844 / 0.193 | 0.14 |
| Fine-tuned on tiles, full-resolution photo (run 2 weights, imgsz 4000, no slicing) | 0.13 | 0.723 | **0.905** | **0.887** | **0.862** | 0.874 / 0.920 | 0.14 |
| Trained and run on whole photos (run 2 recipe on whole photos at 1920 px, 80 epochs) | 0.30 | 0.727 | 0.804 | 0.776 | 0.787 | 0.845 / 0.887 | 0.08 |
| Fine-tuned + tiling (the reported model) | 0.29 | **0.802** | 0.864 | 0.868 | 0.850 | 0.898 / 0.896 | 0.25 |
| + hard negatives (484 mined tiles, 20-epoch fine-tune) | 0.15 | 0.738 | 0.869 | 0.851 | 0.840 | 0.884 / 0.917 | 0.24 |

Every threshold was chosen on the annotated val photos by max F2 with that row's own inference; test was scored
once. The three middle rows were added on 2026-10-18 (`scripts/evaluate_no_tiling.py`,
`data/work/detect/no_tiling_baselines.json`) after a reviewer pointed out that the old "Fine-tuned, no tiling" row was
a strawman. Seconds come from each row's own evaluation run and wander with machine load: timed back to back on the
same 101 test photos (`data/work/detect/inference_cost.json`), tiled inference took 0.38 s per photo at 0.28 GB of
GPU memory, the 4000 px single pass 0.14 s at 5.7 GB, and the 1920 px whole-photo model 0.08 s at 0.7 GB.

**Mirror TTA (tried, not the reported model).** Photo + mirror, weighted box fusion, threshold 0.32, all chosen on val
(`docs/LANE_A_ML.md` §6.3a). Scored once on test: precision 0.835, recall 0.858, AP50 0.872, F2 0.853, 0.50 s, within
noise of the single view (F2 0.850). With it the tiled rows read 0.835 / 0.858 / 0.872 and the hard-negative row
0.771 / 0.887 / 0.879 (`data/work/detect/detector_metrics.run2-tta.json`). Not used: the demo frames were detected
single-view and there was no time to rebuild the demo; that call was made after the test score was seen, so both are
reported. Its secondary high-recall threshold (val recall ≥ 0.90 → **0.16**): test precision 0.727, recall 0.893.
"Found the person" recall, counting a loose box (IoU ≥ 0.1, one box per person): 0.881 for the single view at 0.29,
0.881 for TTA at 0.32, 0.920 at 0.16 (`data/work/detect/operating_points.json`).

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
`python scripts/evaluate_model.py --weights data/runs/tiles_s_v2/weights/best.pt --hn-weights data/runs/tiles_s_v2_hn/weights/best.pt --final tiled --model-name yolo11s-heridal-tiled-run2` (single view is the `detect_tiled` default; the TTA run passed `tta=("id", "hflip")`).
Run 1 (trained on all 1,391 train photos, incl. the unannotated ones) scored 0.681 / 0.754 / 0.711 at threshold 0.21 (`weights-v1`).
Human baseline (Pyrrö et al. 2021): precision 0.59, recall 0.68, 33 s per photo.
SAR-style loose matching (approx. AIR, the scoring of the human baseline) for the final model: precision 0.898, recall 0.896.
`metrics.detector.recall` for lane C's POD: **0.864**. Demo survey (500 frames, seed 7, threshold 0.29; `detect_frame` has no TTA): 15 review-queue crops, all 6
frames with a person in the queue, first hit ranked 1 vs 73 in flight order (71.6 expected at random).

**What the no-tiling rows show (fair comparison, 2026-10-18).** The old "Fine-tuned, no tiling" row fed run 2 weights,
trained on full-resolution 1024 px tiles where a person is about 50 px tall, a whole photo shrunk to 1024 px, where
the person is about 13 px. The model still finds many of them but draws boxes about twice too big, so they fail
IoU 0.5 (checked with run 1 weights before the label fix: median predicted box height on test 115 px fine-tuned vs
73 px stock vs 52 px true; people found with a sloppy box, IoU 0.1 to 0.5: 70 fine-tuned vs 34 stock). That row
shows a scale mismatch, not the value of tiling, so it is now named "Fine-tuned on tiles, run on shrunk photos".
Two fair baselines were added:

- **Same weights, whole photo at native scale, no slicing** (`Detector(..., imgsz=4000)`, letterboxed to 4000x3008,
  one forward pass). It is as good as tiling and faster. On val it was slightly better: F2 0.863 vs 0.831 for
  tiled, ΔF2 +0.032, 95 % CI [+0.0005, +0.064] (paired bootstrap, 2,000 resamples, seed 7,
  `scripts/analysis/no_tiling_val_bootstrap.py`, `data/work/tune/no_tiling_val.json`), which just clears the §6.3a
  adoption rule. On test: recall 0.905 vs 0.864, AP50 0.887 vs 0.868, F2 0.862 vs 0.850, precision 0.723 vs 0.802
  (its val threshold, 0.13, is low). The cost is GPU memory: 5.7 GB against 0.28 GB for 1024 px slices, so it needs a
  desktop GPU, and memory grows with photo size, where slicing does not.
- **A model trained on whole photos** (`scripts/train_whole_photos.py`): the run 2 recipe and the same 890 annotated
  photos, each resized to 1920 px (a person is about 24 px), trained and run at 1920. With run 2's early-stopping rule
  (patience 15) it stopped at epoch 35 with val F2 0.683; trained the full 80 epochs, like run 2, it reached val F2
  0.777 (ΔF2 vs tiled −0.054, CI [−0.081, −0.029]) and test P 0.727 / R 0.804 / AP50 0.776. The 80-epoch model was
  chosen on val. 0.9 h of training on the 4080 SUPER (run 2: 1.6 h) with batch 3 (AutoBatch runs out of memory at 1920 px).

So the honest claim is narrower than "tiling makes fine-tuning pay off". **What pays off is training at native
resolution** (1024 px tiles from full-size photos): the same budget spent on shrunk whole photos loses about 0.06
recall and 0.09 AP50 on test. **At inference, slicing is one way to keep native scale, not the only one**: one pass
over the full 4000 px photo did as well or better here, at about a third of the time and twenty times the GPU
memory. The reported model and the demo are unchanged (single-view tiled, threshold 0.29); switching to full-resolution
inference is lane A's call. Its test score has been seen, so if it is adopted, say so.

**Rows that weren't run are omitted, never zero-filled.** `write_detector_metrics` refuses an all-zero row, and the metrics screen shows any missing or all-zero row as "Not yet measured". Trained and evaluated 2026-10-17 on an RTX 4080 SUPER.

## OpenCV 5 parity (A-X3, 2026-10-20)

`parity_table.py` runs the same weights-v2 detector two ways on the same photos, tiled as in the pipeline: Torch
(Ultralytics + SAHI, `detect.py`) and OpenCV 5 `cv2.dnn` on the ONNX export (`detect_cv.py`, opencv-python 5.0.0.93).
Threshold **0.29, frozen** (chosen on val in sprint 1; nothing re-chosen). Annotated val photos and the full test set;
**test was read once, only to check the two backends agree**, and no setting was changed after seeing it.

```bash
uv run --extra ml python scripts/parity_table.py      # ~45 min: cv2.dnn runs on the CPU
```

| Split | Backend | Device | VOC P / R / AP50 | SAR P / R | s per 4000×3000 photo | s per demo frame (1000×750) |
|---|---|---|---|---|---|---|
| val (95) | Torch | RTX 4080 SUPER | 0.735 / 0.859 / 0.861 | 0.887 / 0.922 | 0.33 | — |
| val (95) | cv2.dnn | Ryzen 9 9950X CPU, 32 threads | 0.735 / 0.859 / 0.861 | 0.887 / 0.922 | 10.19 | — |
| test (101) | Torch | RTX 4080 SUPER | **0.802 / 0.864 / 0.868** | **0.898 / 0.896** | 0.30 | 0.011 |
| test (101) | cv2.dnn | Ryzen 9 9950X CPU, 32 threads | **0.802 / 0.864 / 0.868** | **0.898 / 0.896** | 9.98 | 0.512 |

Box agreement (each photo's boxes matched one-to-one between backends, highest IoU first):

| Split | Boxes | Torch / cv2 | Matched at IoU ≥ 0.95 | Max conf diff on a match |
|---|---|---|---|---|
| val | all saved (conf ≥ 0.05) | 646 / 646 | 99.8 % | 0.0015 |
| val | at or above 0.29 | 389 / 389 | 100 % | 0.0015 |
| test | all saved (conf ≥ 0.05) | 539 / 538 | 99.8 % of Torch's | 0.0013 |
| test | at or above 0.29 | 363 / 363 | 100 % | 0.0009 |

Every score is identical to three decimals, and the test row reproduces the published Torch numbers exactly
(acceptance: AP50 within ±0.005 and ≥ 99 % box agreement). The only differences are low-confidence boxes
below the threshold: one extra Torch box on test and a 0.2 % share on val that move slightly (IoU < 0.95).
Speed is not a like-for-like comparison: the pip OpenCV wheels have no CUDA, so cv2.dnn runs on the CPU
(about 0.5 s per 1024 px slice, 20 slices per full photo); demo frames are one slice each.
Run: `runs/parity/20261020-163532.json` (local).

**Demo frames (W2: demo cache re-detected on the cv2 path).** A 1000×750 frame is one slice smaller than the model
input. `YOLO.predict` pads it only to a multiple of 32 (1024×768); the fixed-size ONNX export needs the full
1024×1024 square, so cv2.dnn saw 128 px grey bands top and bottom and boxes near those edges changed (13 vs 12
candidate frames, 11 shared, on the 500-frame demo cache). `export_onnx.py` writes a variable-size export
(`<stem>-dynamic.onnx`, same weights, `dynamic=True`), `CvDetector` detects that it accepts non-square input and
pads like `YOLO.predict`, and `make_detector` prefers it. With it, `run_survey` on the cv2 path reproduces the
published `demo-cache` detections exactly: the same 36 boxes to the pixel, the same confidences to 3 decimals,
the same 14 crops. Full 1024 px slices are unchanged (5 val photos: 100 % of boxes at IoU ≥ 0.95).
The browser copy (`web/src/detect/tiling.ts`) still pads to the square, so in-browser results on non-square
photos can differ slightly from Torch near the top and bottom edges.

## Training (timing run, then run 1)

```bash
yolo detect train model=yolo11s.pt data=data/heridal/yolo_tiles/dataset.yaml imgsz=1024 \
  epochs=<n> batch=-1 patience=15 seed=7 single_cls=True degrees=180 flipud=0.5 fliplr=0.5 \
  close_mosaic=10 project=data/runs name=tiles_s
```

Start long runs in a terminal on the desktop's own session, not over SSH.
