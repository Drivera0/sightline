# Lane A · ML: the person detector

> **Owner:** Dan · **Folders:** `sightline/ml/`, `scripts/` (data prep), `tests/ml/`, `web/src/metrics/`
> **Read first:** `00_OVERVIEW.md`, `01_CONTRACT.md` (§7 `detections.json`, §9 `metrics.json`)

---

## 1. Mission

Build a detector that finds 60-pixel people in drone photos, prove how good it is on the HERIDAL test set, and run it over the 500 demo frames. Everything else in Sightline (ranking, pins, the search map) starts from your detections, and your recall number feeds C's search map.

### Definition of done

- [ ] A fine-tuned YOLO model trained on **tiled** HERIDAL training images, plus a hard-negative fine-tune.
- [ ] `metrics.detector` and all four `metrics.ablations` rows computed on the **full 101-image test set**, with the same scoring for every row.
- [ ] `candidate_threshold` chosen on the **validation** set (never the test set).
- [ ] Raw detections for all 500 demo frames, saved as the intermediate file D's pipeline reads (§6.4), plus a 256×256 crop per detection.
- [ ] The metrics screen in the web app (§9).

---

## 2. Inputs and outputs

| Direction | What | Format |
|---|---|---|
| In | HERIDAL (Zenodo, VOC format, CC BY 3.0) | JPEG images + VOC XML boxes |
| In | Demo frames (from D, around hour 8) | `data/survey/frames/f0001.jpg` … 1000×750 |
| Out | Detector functions | `sightline/ml/` (signatures in §5) |
| Out | Detections on demo frames | `data/work/detect/detections_raw.json` (§6.4) |
| Out | Crops | `data/work/detect/crops/<frame_id>-dNN.jpg` |
| Out | Detect config | `data/work/detect/config.json`: weights path, model name, `candidate_threshold` |
| Out | Metrics | `data/work/detect/detector_metrics.json`: contract `DetectorMetrics` + the `Ablation` rows (§6.3 step 2), written on the desktop (§6.3 step 7) |
| Out | Shared test split for teammates | `data/heridal/test/` zipped to the team drive (before the event) |

You don't write cache files. Detection and evaluation need the GPU and the full dataset, so you run them on the desktop and write the files under `data/work/detect/`. D's pipeline reads those files and writes the cache. Share `data/work/detect/` on the team drive after each run.

---

## 3. Background you need

**The data.** HERIDAL: 1,647 photos of Croatian and Bosnian wilderness from 40–65 m, mostly 4000×3000 (a few 4000×2250), 3,229 labelled people. Official split: **1,546 train (2,892 people), 101 test (337 people)**. Every image contains at least one person. People average about **60×60 px**, about 0.03% of the image. Single class: person.

**Why tiling.** Resizing a 4000×3000 image to the model's input (640 px by default, 1024 for us) shrinks a 60 px person to 10–15 px, and the detector misses them. So train and infer on **1024×1024 tiles at native resolution**. The SAHI library does sliced inference and merges boxes back. In a quick test, a stock COCO YOLO11m found 2 of about 12 people on 5 test photos without tiling and 4 with tiling: tiling helps, but fine-tuning is what makes it work. **Measured later (2026-10-18, §6.3):** what matters is native resolution, not slicing as such. Training on 1024 px tiles beats training on whole photos shrunk to 1920 px (test AP50 0.868 vs 0.776), but the tile-trained weights run on the *whole* photo at native scale in one pass (imgsz 4000, no slicing) do as well as tiled inference (test AP50 0.887 vs 0.868), in about a third of the time and with about 20× the GPU memory (5.7 GB vs 0.28 GB).

**What the published work got** (AIR, RetinaNet, Pyrrö et al. 2021): untuned baseline 4.5% recall; full method about 90% precision / 86% recall (VOC scoring). We don't need to beat AIR. **We need to beat the human baseline (59% P / 68% R) and report honestly.**

**Hard negatives.** Bags, white objects, rocks and stumps fire as people. Collect your model's false positives on training images and train on those tiles with no labels, so it learns they're background.

---

## 4. Before the event (setup and data prep only)

Data prep code is allowed before the event, app code isn't. All of this is data prep.

- [ ] **Download** `heridal_keras_retinanet_voc.zip` (8.3 GB) from https://zenodo.org/records/5662351 to the desktop. Unzip to `data/heridal/raw/`. Inspect the structure and confirm the counts: 1,546 / 101 images, 2,892 / 337 boxes. If counts differ, write down why before going further.
- [ ] **`scripts/convert_heridal.py`:** VOC XML → YOLO txt (`0 cx cy w h`, normalised). Output `data/heridal/yolo_full/{train,val,test}/{images,labels}`. Val = 10% of train, seeded (`seed=7`), split **by image**.
- [ ] **`scripts/tile_dataset.py`:** cut train and val images into 1024×1024 tiles, 20% overlap (§6.1). Output `data/heridal/yolo_tiles/{train,val}` + `dataset.yaml`.
- [ ] **Timing run:** train `yolo11s.pt` for 2 epochs on the tiles. Write down seconds per epoch. Use it to set the real epoch count so run 1 finishes in about 4 hours.
- [ ] **Remote access** (details in §12): Tailscale on the desktop and the MacBook, Windows OpenSSH Server with key login, remote desktop for starting long runs. Test everything from a phone hotspot.
- [ ] **Backup GPU:** upload `yolo_tiles` to Google Drive or Kaggle so a Colab/Kaggle notebook can train if the desktop is unreachable.
- [ ] **Share the test split** (101 images + labels, about 500 MB) with B, C and D. They need it for frames, canopy tuning and real-pose tests.

---

## 5. Code to build (signatures)

```python
# sightline/ml/types.py
@dataclass(frozen=True)
class Box:            # pixels, x2 > x1, y2 > y1
    x1: int; y1: int; x2: int; y2: int

@dataclass(frozen=True)
class LabeledImage:
    path: Path
    width: int
    height: int
    boxes: list[Box]

@dataclass(frozen=True)
class RawDetection:   # what D's pipeline consumes
    box: Box
    conf: float

# sightline/ml/data.py
def load_split(split: Literal["train", "val", "test"]) -> list[LabeledImage]
    """Reads data/heridal/yolo_full/<split>. Used by D's survey builder (test split) and by eval."""

# sightline/ml/detect.py
class Detector:
    def __init__(self, weights: Path, device: str = "cuda:0", imgsz: int = 1024) -> None: ...
    def detect_frame(self, image: Path, conf: float = 0.05) -> list[RawDetection]:
        """One pass at native size. For demo frames (1000×750), which fit in one 1024 tile."""
    def detect_tiled(self, image: Path, conf: float = 0.05,
                     slice_px: int = 1024, overlap: float = 0.2) -> list[RawDetection]:
        """SAHI sliced inference for full 4000×3000 images."""
    def detect_resized(self, image: Path, conf: float = 0.05) -> list[RawDetection]:
        """Whole 4000×3000 image resized to imgsz (1024) in one pass, so a 60 px person becomes ~15 px.
        Only for the two shrunk-photo ablation rows; the metrics screen labels them 'whole photo shrunk to 1024 px'.
        Detector(..., imgsz=4000) runs the whole photo at native scale instead (§6.3, fair baseline)."""

# sightline/ml/crops.py
def make_crop(image: Path, box: Box, out: Path, window_px: int = 128, out_px: int = 256) -> None:
    """128×128 window centred on the box centre (padded with black at edges), upscaled to 256×256, JPEG q90."""

# sightline/ml/evaluate.py  (contract models: VocScores{precision, recall, ap50},
#                            SarScores{precision, recall, ap}, DetectorMetrics, Ablation)
def score_voc(preds: dict[str, list[RawDetection]], truth: dict[str, list[Box]], threshold: float) -> VocScores
def score_sar(preds: dict[str, list[RawDetection]], truth: dict[str, list[Box]], threshold: float) -> SarScores
def choose_threshold(detector: Detector, val: list[LabeledImage]) -> float
def evaluate(detector: Detector, images: list[LabeledImage], mode: Literal["tiled", "resized"],
             threshold: float) -> tuple[VocScores, SarScores, float]   # (voc, sar, seconds_per_image)
def write_detector_metrics(detector: DetectorMetrics, ablations: list[Ablation],
                           out: Path = Path("data/work/detect/detector_metrics.json")) -> None

# sightline/ml/survey.py: the ONE entry point D's `detect` stage calls
def run_survey(frames_dir: Path, weights: Path, out_dir: Path, candidate_threshold: float,
               model_name: str, save_threshold: float = 0.05) -> None:
    """detect_frame on every frame → out_dir/detections_raw.json; make_crop for every detection with
    conf ≥ candidate_threshold → out_dir/crops/; writes out_dir/config.json
    {"weights": ..., "model": ..., "candidate_threshold": ..., "save_threshold": ...}."""

# sightline/ml/hard_negatives.py
def mine(detector: Detector, train: list[LabeledImage], conf: float = 0.25,
         max_tiles: int = 2000, seed: int = 7) -> list[Path]   # writes extra tiles + empty label files
```

`sightline/ml/__init__.py` exports `Detector`, `RawDetection`, `Box`, `LabeledImage`, `load_split`, `make_crop`, `run_survey`. `Box`, `RawDetection` and `LabeledImage` are plain frozen dataclasses (in-process arguments); everything that ends up in the cache uses contract models.

---

## 6. Step by step

### 6.1 Tiling (data prep, before the event)

- Tile 1024×1024, overlap 0.2 → stride 819. Last tile in each row/column snaps to the image edge. 4000×3000 gives 5×4 = 20 tiles per image.
- Box → tile: clip the box to the tile; keep it if **≥ 50%** of its original area is inside; drop slivers under 8 px on a side.
- Keep **every tile with at least one box**, plus a random **25% of empty tiles** (seeded) as background. YOLO treats an image with an empty label file as background.
- Write `dataset.yaml`: one class `person`, paths to tile folders.

### 6.2 Training run 1 (start in hour 0)

Starting values. Adjust from the timing run.

```bash
yolo detect train model=yolo11s.pt data=data/heridal/yolo_tiles/dataset.yaml \
  imgsz=1024 epochs=<from timing run> batch=-1 patience=15 seed=7 single_cls=True \
  degrees=180 flipud=0.5 fliplr=0.5 close_mosaic=10 project=data/runs name=tiles_s
```

- Nadir photos have no "up", so full rotation and vertical flips are valid augmentations.
- Start it in a terminal on the desktop's own session (via remote desktop, §12), not over SSH, so a dropped connection doesn't kill it. Check `results.csv` for tile-level val mAP50 every hour or two over SSH.
- If time allows after run 1, try `yolo11m.pt`. Keep whichever scores better on **val**.

### 6.3 Evaluate (hour 3–10, while D builds frames)

1. `choose_threshold` on **val**, on full images with tiled inference. Pick the threshold that maximises **F2** (recall weighted twice precision; missing a person costs more than a false alarm). This is `candidate_threshold`.
2. Run the four ablation variants on the **test** set, same threshold rule per variant:
   | Row name (exact) | Weights | Inference |
   |---|---|---|
   | Stock model, no tiling | `yolo11s.pt` (COCO, class person only) | `detect_resized` |
   | Fine-tuned, no tiling | your best tiled-trained weights | `detect_resized` |
   | Fine-tuned + tiling | your best tiled-trained weights | `detect_tiled` |
   | + hard negatives | after §6.5 | `detect_tiled` |

   Since 2026-10-18 the second row is named **"Fine-tuned on tiles, run on shrunk photos"** (old files say "Fine-tuned, no tiling"; `LEGACY_ABLATION_RENAMES`): tile-trained weights on a photo shrunk to 1024 px see people at a quarter of their training scale, so the row shows a scale mismatch, not the value of tiling. Three fair no-tiling rows sit between it and "Fine-tuned + tiling" (`scripts/evaluate_no_tiling.py`, same threshold rule and scoring; full table and conclusion in `scripts/README.md`):

   | Row name (exact) | Weights | Inference | Val thr | Test P / R / AP50 | s / photo, GPU memory |
   |---|---|---|---|---|---|
   | Stock model, full-resolution photo | `yolo11s.pt` | whole photo at imgsz 4000, one pass | 0.06 | 0.678 / 0.181 / 0.165 | 0.14 s, 5.7 GB |
   | Fine-tuned on tiles, full-resolution photo | run 2 | whole photo at imgsz 4000, one pass | 0.13 | 0.723 / 0.905 / 0.887 | 0.14 s, 5.7 GB |
   | Trained and run on whole photos | run 2 recipe on the same 890 photos resized to 1920 px, 80 epochs (`scripts/train_whole_photos.py`) | whole photo at imgsz 1920 | 0.30 | 0.727 / 0.804 / 0.776 | 0.08 s, 0.7 GB |

   For comparison, tiled run 2: threshold 0.29, 0.802 / 0.864 / 0.868, 0.25 to 0.38 s and 0.28 GB. On val the full-resolution single pass beat tiling by ΔF2 +0.032 (95 % CI [+0.0005, +0.064]); the whole-photo model lost by ΔF2 −0.054 (CI [−0.081, −0.029]). The reported model is unchanged; adopting full-resolution inference is open (its test score has now been seen).
3. **VOC scoring:** greedy one-to-one matching in descending confidence, IoU ≥ 0.5. Precision and recall at the threshold; AP50 = all-point interpolated area under the PR curve over all confidences.
4. **SAR scoring** (the loose scheme from the AIR paper, our implementation): a prediction is correct if its IoU with any true box is ≥ 0.0025, and one prediction may cover several people. Precision = correct predictions / all predictions; recall = true boxes matched by at least one prediction. Label it "SAR-style (approx. AIR)" in the UI.
5. `seconds_per_image` = mean wall time of `detect_tiled` on the test images, on the 4080 SUPER.
6. `metrics.detector.recall` = the VOC recall of the final model. **Tell C the number as soon as you have it**, because it's their POD input.
7. `write_detector_metrics` → `data/work/detect/detector_metrics.json`: the contract `DetectorMetrics` (with `threshold` = `candidate_threshold`) and the 4 `Ablation` rows. D's `map` stage reads `recall` from it (0.80 placeholder if the file doesn't exist yet), and the `metrics` stage copies the rest into `metrics.json`. Re-write it whenever the model changes.

### 6.3a Tuning on val only (2026-10-18)

Every setting below was chosen on the 95 annotated val photos (333 people). A change is adopted only if a paired bootstrap over val photos (2,000 resamples, seed 7) puts the 95 % interval of ΔF2 above zero; otherwise the current setting stays. Test is scored once, at the end, with whatever was chosen.

- **SAHI merge** (`scripts/tune_on_val.py`, `data/work/tune/val_tuning.json`): 90 settings (overlap 0.1/0.2/0.3 × NMS/NMM/GREEDYNMM × IOU/IOS × match 0.3–0.7), threshold re-chosen by max F2 for each. Current default (overlap 0.2, NMS, IOU 0.5): val F2 0.831 at threshold 0.29. Best: overlap 0.1, NMS, IOU 0.5, val F2 0.846; ΔF2 +0.015, 95 % CI [−0.007, +0.038]. Not clearly better, so the default stays.
- **Test-time augmentation** (`scripts/tta_on_val.py`, `data/work/tune/val_tta.json`): each val photo in 1, 2, 4 or 8 flip/rotation views, each view tiled and merged as usual, views fused by pooled NMS or weighted box fusion (WBF), threshold re-chosen by max F2:

  | Views | Fusion | Threshold | Val P | Val R | Val F2 | Val AP50 | s / photo | ΔF2 vs no TTA, 95 % CI |
  |---|---|---|---|---|---|---|---|---|
  | 1 (no TTA) | | 0.29 | 0.735 | 0.859 | 0.831 | 0.861 | 0.32 | |
  | 2 (photo + mirror) | NMS | 0.28 | 0.677 | 0.886 | 0.834 | 0.862 | 0.62 | +0.003 [−0.012, +0.019] |
  | **2 (photo + mirror)** | **WBF** | **0.32** | **0.797** | **0.874** | **0.857** | **0.889** | **0.62** | **+0.027 [+0.004, +0.048]** |
  | 4 (+ vflip, rot90) | NMS | 0.45 | 0.745 | 0.862 | 0.836 | 0.872 | 1.19 | +0.005 [−0.019, +0.028] |
  | 4 | WBF | 0.25 | 0.741 | 0.883 | 0.850 | 0.891 | 1.19 | +0.019 [+0.002, +0.039] |
  | 8 (all) | NMS | 0.52 | 0.753 | 0.862 | 0.838 | 0.881 | 2.41 | +0.007 [−0.018, +0.032] |
  | 8 | WBF | 0.24 | 0.755 | 0.889 | 0.858 | 0.906 | 2.42 | +0.028 [+0.004, +0.051] |

  Rule (the task's): among settings under 2 s per photo, the best val F2, adopted only if its interval is above zero. **Passed the rule: 2 views with WBF**, with the threshold re-chosen on val: **0.32**. It is available as `detect_tiled(..., tta=("id", "hflip"))` but is **not** the default (`TTA_VIEWS = ("id",)`): scored once on test it was within noise of the single view (below), the demo frames were detected single-view, and rebuilding the demo and every number around it was not worth it with hours left. Dan made that call after the test score was seen, so both results are reported. The gain is mostly precision: WBF divides a box's summed confidence by the number of views, so a box only one view sees keeps half its score. Note: the first version of `tta_on_val.py` took the best F2 overall (8 views, 2.4 s) and so rejected TTA on speed; the rule was corrected to apply the speed limit first, after seeing that result. Seconds are from the same val pass on the 4080 SUPER (decode + views + fusion); the single-view time here (0.32 s) is higher than `evaluate_model.py`'s 0.25 s because the photo is decoded to an array first. TTA is in `detect_tiled` only: `detect_frame` (the demo frames) is unchanged.
- **Secondary high-recall operating point.** Rule fixed before looking: the highest threshold whose val recall is ≥ 0.90 (about nine in ten people surfaced; a false alarm costs a reviewer seconds). For single-view inference that was 0.10 (val recall 0.907, precision 0.571); for the 2-view TTA setting it is **0.16** (val recall 0.901, precision 0.654). `scripts/evaluate_model.py` recomputes it from val and writes it, with its test score, to lane A's `data/work/detect/operating_points.json`, not to `metrics.json`: the contract's `DetectorMetrics` has no field for it (see §6.3b).

- **Tiling fix and site-held-out retrain.** `boxes_in_tile` used to drop people less than 50 % inside a tile while leaving them visible, so the model learned partial people as background. Now `masked_regions_in_tile` + `apply_masks` black them out (in `tile_dataset.py` and hard-negative tiles; `--no-mask-partial` restores the old tiles). Weights-v2 was trained before the fix, so it takes effect at the next retrain. To test it, `scripts/make_site_holdout.py` built a site-held-out split (GOR + RAK held out: 186 photos / 331 people; training 724 photos from the other 11 sites), and two run-2-recipe retrains were started: a control with the old tiles and one with masking, to be compared by `scripts/compare_on_holdout.py` with run 2. The control finished (80 epochs, tile-val mAP50 0.912), but Claude Code stopped the masked run at epoch 14 of 80 because the system was low on memory, so no comparison was made and run 2 stays. To finish it: `python scripts/train_site_holdout.py data/heridal/yolo_tiles_site_mask site_mask`, then `python scripts/compare_on_holdout.py --model run2=data/runs/tiles_s_v2/weights/best.pt --model control=data/runs/site_nomask/weights/best.pt --model mask=data/runs/site_mask/weights/best.pt`.
- **Test result of the TTA setting** (run once, after all of the above): run 2 + photo/mirror TTA at threshold 0.32: P 0.835, R 0.858, AP50 0.872, F2 0.853, 0.50 s per photo (single-view before: 0.802 / 0.864 / 0.868, F2 0.850, 0.25 s). High-recall threshold 0.16: P 0.727, R 0.893, F2 0.854. Recall counting a loose box (IoU ≥ 0.1): 0.881 at 0.32, 0.920 at 0.16. **Reported model: run 2, single view, threshold 0.29** (`detector_metrics.json`; the TTA run is kept as `detector_metrics.run2-tta.json`).

### 6.3b Contract change needed for the secondary threshold (lane D decides)

`DetectorMetrics` forbids extra keys. To show the high-recall point on the metrics screen, lane D would add an optional field, e.g. `detector.high_recall: {threshold, voc: VocScores, rule: string} | null`, bump the contract to 1.2, and have the `metrics` stage copy it from `data/work/detect/operating_points.json`. Until then it lives only in lane A's files and docs.

### 6.4 Run on the demo frames (as soon as D has frames, around hour 8–10)

Run `run_survey(Path("data/survey/frames"), <best weights>, Path("data/work/detect"), <candidate_threshold>, <model name>)`. D's `detect` stage is a thin wrapper that calls exactly this. It:

- runs `detect_frame` on every frame in `data/survey/frames/`, `conf=0.05`;
- writes `data/work/detect/config.json` (weights path, model name, thresholds), which D's pipeline reads for `detections.json`'s header;
- writes `data/work/detect/detections_raw.json`:
  ```json
  {"model": "yolo11s-heridal-tiled", "save_threshold": 0.05, "candidate_threshold": 0.31,
   "frames": {"f0001": [{"box": [512, 300, 560, 362], "conf": 0.874}], "f0002": []}}
  ```
  Every frame id is present; detections are sorted by descending conf. This is an internal file, not a contract file. D's pipeline turns it into `detections.json`.
- runs `make_crop` for every detection with `conf ≥ candidate_threshold` into `data/work/detect/crops/<frame_id>-dNN.jpg` (NN = 01, 02… by descending conf). Below the threshold there's no crop, and the contract's `crop` field is `null`.
- Re-run this step after §6.5 with the final model.

The detect stage needs the GPU, so it runs on the desktop. Copy `data/work/detect/` to the team drive so B, C and D can run the downstream stages on laptops.

### 6.5 Hard-negative mining + fine-tune (hour 10–18, overnight)

1. `mine`: tiled inference over **training** images. A false positive is a prediction with `conf ≥ 0.25` and IoU < 0.1 to every true box.
2. For each false positive, cut the 1024 tile centred on it (clamped to the image), with that tile's true labels (often none). Cap at 2,000 tiles, seeded.
3. Add them to the training tiles; fine-tune from best weights about 20 epochs with `lr0=0.002`.
4. Re-run §6.3 for the "+ hard negatives" row. **Keep the model only if it is clearly better on val**: a paired bootstrap over the annotated val photos (`sightline.ml.tuning.paired_bootstrap_f2`, 2,000 resamples, seed 7) whose 95 % interval of ΔF2 is above zero. Report the test row either way, but never use it to decide.

   > **Disclosure.** This step used to say "keep the model only if test-set F2 doesn't drop", and that is how the weights-v2 hard-negative model was dropped (test F2 0.840 vs 0.850). Run 2 was also kept over run 1 with test scores in view. Both were test-set selections; see `scripts/README.md` for the retroactive val check.

### 6.6 Stretch: re-check classifier (only if ahead at hour 18)

ResNet-18 on 128×128 crops: positives = crops of true boxes, negatives = mined false positives. Re-score each detection as `conf × p_person`. Report it as a fifth ablation row (needs a contract bump to 1.1, so agree with D first). First on the cut list.

### 6.7 OpenCV 5 runtime and the Nemotron verifier (2026-10-20, val only)

**OpenCV 5 detector parity.** `sightline/ml/detect_cv.py` (`CvDetector`) runs weights-v2 through `cv2.dnn` (opencv-python 5.0.0.93) on its ONNX export (imgsz 1024, opset 17), with the same slicing, letterbox and NMS as `Detector.detect_tiled` (single view). Checked against Ultralytics + SAHI on the first 12 val photos:

```bash
uv run --extra ml python scripts/compare_cv_detector.py --pt data/weights/release_v2/yolo11s_tiles_run1_best.pt --photos 12
```

At threshold 0.25 each detector found 19 boxes, with the same count on every photo. All 19 matched one-to-one at IoU ≥ 0.9, and the largest confidence difference on a matched box was 0.0012. Seconds per photo: Ultralytics + SAHI on the 4080 SUPER 0.54 s, OpenCV DNN on the CPU 10.92 s (later found to be single-threaded because `ultralytics` was imported in the same process; fixed, 1.9 s on 32 threads: `scripts/README.md`, "OpenCV 5 parity"). The two times use different hardware, so they don't compare speed fairly; the OpenCV path is the CPU-only fallback, with no torch.

**Full parity on val and test (A-X3).** `scripts/parity_table.py` at the frozen threshold 0.29: VOC P / R / AP50 and SAR P / R are identical to three decimals on val (0.735 / 0.859 / 0.861) and test (0.802 / 0.864 / 0.868; SAR 0.898 / 0.896, the published numbers). At or above the threshold, 100 % of boxes match one-to-one at IoU ≥ 0.95 on both splits (max confidence difference 0.0015); among all saved boxes 99.8 %. Test was read once for this check and nothing was changed after it. Table and timings: `scripts/README.md`, "OpenCV 5 parity".

**Demo cache on the cv2 path.** With the variable-size ONNX (`scripts/export_onnx.py`), `run_survey` on cv2.dnn reproduces the published 500-frame demo cache exactly (36 boxes, confidences to 3 decimals, 14 crops). With the fixed-size export it did not: 1000×750 frames were padded to a 1024×1024 square instead of 1024×768 as `YOLO.predict` does, which changed boxes near the top and bottom edges.

**Verifier benchmark.** Nemotron-3.5-Super-VL (`nvidia/Nemotron-3.5-Super-VL` on Nebius Token Factory) answers `person` / `not_person` for 256 px crops, with thinking off.

```bash
uv run python scripts/bench_verifier.py -n 50 --prompts basic strict --no-think
```

The run used 150 crops (seed 0): 50 people and 50 empty-ground crops from the **val** split, plus 50 hard negatives. Per-crop results are in `runs/bench_verifier/20261020-134015.csv`.

| Prompt | Accuracy | Recall (people) | FP rate, empty ground | FP rate, hard negatives | Median latency | Tokens / crop |
|---|---|---|---|---|---|---|
| basic | 92.7 % (139/150) | **96 %** (48/50) | 0 % (0/50) | 18 % (9/50) | 1.0 s | 297 |
| strict | 92.0 % (138/150) | 86 % (43/50) | 0 % (0/50) | **10 %** (5/50) | 1.0 s | 363 |

The two prompts' mistakes are nested. Strict misses both people basic misses plus 5 more, and basic flags all 5 of strict's false positives plus 4 more. Under the lane's recall-first rule (F2, §6.3) basic is ahead, so **basic is the prompt for now**. The sample is small, though: a two-sided sign test on the 5 people only basic found gives p ≈ 0.06. Four of the missed people were looked at. Two are clearly visible: a person on snow with a long shadow, which only strict missed and rejected with confidence 95 (`train_GOR_2058`), and a small person in white on grass, which both prompts missed (`train_JAS_0150`). One is in deep tree shade but visible (`train_VRD_3004`, strict only). In one, missed by both, no person can be seen against the rocks (`train_GOR_3049`; the label is about 64 px). The verifier re-ranks and flags detections; it never removes them.

Caveats:
- **The hard negatives come from the train split.** They are 50 centre crops of patches the detector fired on, from `data/heridal/hard_negatives_v2/` (245 train photos, none in val). The detector was trained on these photos, so they may not look like the false positives it makes on new photos. 8 of basic's 9 hard-negative false positives come from one site (ZRI).
- **The earlier numbers were measured on test.** The 20-crop runs `20261020-124918` and `20261020-125216`, including the strict figures quoted before (87 % accuracy, 75 % recall, 3/20 hard-negative false positives) and the choice of strict over basic, used person and empty-ground crops from the **test** split. This run on val supersedes them. `bench_verifier.py` now takes those crops from `--split` (default val) and has no fallback to test.

### 6.8 The verifier on val (A-V2, 2026-10-20, val only)

`sightline/agent/verify.py` gives each uncertain detection a second look: re-look tools chosen by heuristic failure mode (`relook.py`), then Nemotron-3.5-Super-VL on Token Factory (thinking off, temperature 0, JSON schema, prompt `verify-v1`) on the crop plus up to two tool images. `scripts/eval_verifier.py` builds each val photo into a mission the way the pipeline will (1000×750 display frame, original kept for the zoom), labels every detection with VOC matching, and runs `verify()` on the 170 detections the rules can change: all 87 near-misses (0.15–0.29) and the 83 queue items below 0.5.

```bash
uv run --extra ml python scripts/eval_verifier.py      # ~2 min, 170 model calls
```

| Rule (95 val photos, 333 people) | Precision | Recall | F2 | ΔF2 vs (a), 95 % CI | Δ recall, 95 % CI |
|---|---|---|---|---|---|
| (a) threshold 0.29 only | 0.735 | 0.859 | 0.831 | — | — |
| (b) + promote near-misses the verifier calls `yes` | 0.667 | **0.892** | 0.836 | +0.005 [−0.009, +0.021] | **+0.033 [+0.016, +0.052]** |
| (c) (b) + demote `no` below 0.5 (reported, never applied) | 0.672 | 0.892 | 0.837 | +0.006 [−0.007, +0.022] | +0.033 [+0.017, +0.052] |

Paired bootstrap over val photos, 2,000 resamples, seed 7. **Rule (b) is the one we use**: it finds 11 more of the 333 people (recall +3.3 points, clearly above zero) at the cost of 45 more false alarms to dismiss (precision −6.8 points); F2 is not clearly better either way. Under the recall-first rule (§6.3) and because each promotion is only a proposal a person approves, (b) is worth it. Demotion barely changes anything (3 false alarms) and the agent never dismisses detections in v1, so (c) is reported only.

What the verifier says (170 verified detections):

| Set | n | people called `yes` | false positives called `no` | `unclear` |
|---|---|---|---|---|
| near-misses | 87 (12 people) | 92 % | 11 % | 26 % |
| queue items below 0.5 | 83 (28 people) | 89 % | 5 % | 13 % |
| boxes under 60 px | 75 (16 people) | 94 % | 3 % | 23 % |

It rarely misses a person but is lenient: it calls `yes` on 45 of the 75 near-miss false positives. Some of those "false positives" are unlabelled people or second boxes on a labelled person (`DETECTOR_LIMITS.md` §3), so the true precision is somewhat better than measured, but the verdict badge is weak evidence of a false alarm. Cost per detection: 830 tokens in, 65 out, median 1.35 s model time (1.4 s with the re-look tools); no invalid JSON in 170 calls. Per-detection results: `runs/verifier/val-20261020-165346.csv`.

**A stricter prompt, chosen on val.** `verify-v2` adds: answer `yes` only for a visible human shape (head with body, limbs, outline and shadow), lists the common false alarms (rocks, logs, stumps, shadows, bushes, bags, clothing on the ground), and sends doubt to `unclear` rather than `no`. Same 170 val detections:

| Rule (val) | Prompt | Precision | Recall | F2 | ΔF2 vs (a) | Δ recall vs (a) |
|---|---|---|---|---|---|---|
| (b) promote `yes` | v1 | 0.667 | 0.892 | 0.836 | +0.005 [−0.009, +0.021] | +0.033 [+0.016, +0.052] |
| (b) promote `yes` | **v2** | 0.699 | 0.886 | **0.841** | +0.010 [−0.003, +0.024] | +0.027 [+0.009, +0.046] |

v2 promotes 24 false alarms instead of 45 and keeps 9 of the 12 near-miss people instead of 11 (v2 − v1: recall −0.006 [−0.019, +0.005], F2 +0.005 [−0.005, +0.015]). **Chosen: v2 + rule (b)**, the highest val F2 (now the default, `prompts.VERIFY_VERSION`). Two prompts were compared, both on val only.

**The single test score** (101 photos, 337 people; v2 + rule (b), fixed before test was read; 121 detections verified):

| Rule (test) | Precision | Recall | F2 | Kept |
|---|---|---|---|---|
| (a) threshold 0.29 only | 0.802 | 0.864 | 0.850 | 363 |
| **(b) + promote near-misses called `yes`** | 0.772 | **0.875** | 0.853 | 382 |
| (c) (b) + demote `no` below 0.5 (reported, never applied) | 0.780 | 0.875 | 0.855 | 378 |

On test the verifier finds 4 more of the 337 people (recall +0.012, 95 % CI [+0.003, +0.023]) for 15 more false alarms; F2 +0.002 [−0.006, +0.011], so no clear change. The gain is smaller than on val because v2 was more cautious on test: it called 4 of the 11 near-miss people `yes` (36 %, against 75 % on val) and 59 % of near-misses `unclear`. On boxes under 60 px it called 2 of 8 people `yes` and 65 % of all such crops `unclear`: on the smallest people the VL model mostly abstains rather than guesses. That is the honest headline for the report and the Nebius feedback: **a small, real recall gain, human-approved, at about 920 tokens in / 68 out and 1.4 s per detection; weak on the smallest crops.** Test was read once for the verifier; nothing was changed after it. Results: `runs/verifier/test-verify-v2-20261020-170158.csv`.

---

## 7. Tests and acceptance checks

- `tests/ml/test_convert.py`: a VOC XML fixture converts to the exact YOLO line expected.
- `tests/ml/test_tiling.py`: a 4000×3000 image gives 20 tiles; a box straddling two tiles lands in both only where ≥ 50% inside; edge tiles snap to the border.
- `tests/ml/test_scoring.py`: hand-built cases: perfect match → P=R=1; one miss; one false positive; SAR scoring accepts a large box covering two people as 2 recalled.
- `tests/ml/test_crops.py`: a box at the image corner produces a 256×256 crop without error.
- Acceptance: the counts in §4 match; val and test never overlap (assert no shared filenames); every ablation row (4 core rows plus the 3 no-tiling baselines) uses the same threshold rule.

Tests must run on CPU without weights; use tiny fixtures.

---

## 8. Fallbacks

| Problem | Fallback |
|---|---|
| Desktop unreachable | Train on Colab/Kaggle from the uploaded tiles (yolo11s, fewer epochs). |
| Training underperforms | Ship the best checkpoint; report the real numbers against the human baseline. Never tune on test. |
| Hard negatives hurt | Keep the previous model; still report the row. |
| Out of time for SAR scoring | Report VOC only; hide the SAR column. |

---

## 9. Your screen: Metrics (hours 18–26)

`web/src/metrics/MetricsView.tsx`, reading `metrics.json` only. See `05_FRONTEND_SHARED.md` for the shell and look.

- **Headline row:** three stat tiles: our recall vs. human 68%; our precision vs. human 59%; seconds per image, ours vs. 33 s.
- **Ablation table:** the 7 rows in `ABLATION_NAMES` order (an old 4-row file shows its 4, the old name mapped), VOC precision / recall / AP50, the row in use ("Fine-tuned + tiling") highlighted by name, not the best AP50. Results shows five of them as bars ("Why resolution matters").
- **Ranking block** (D's numbers): frames reviewed before the first hit, ranked vs. flight order, and the random-order expectation.
- **Search block** (C's numbers): median and 90th-percentile cells to find, three methods, with a **"Simulated"** badge.
- Every number shows its source on hover (e.g. "HERIDAL test set, 101 images").

---

## 10. Your part of the pitch

About 30 seconds: why tiling (the 10-pixel smudge), the stock-vs-ours jump from the ablation table, and our numbers vs. the human baseline. Have the "is it just CV?" answer ready: the stock model misses most people, and the tricks are the project.

---

## 11. For Claude (instructions when this file is given to Claude Code)

- You are working on **lane A** only. Edit `sightline/ml/`, `scripts/`, `tests/ml/`, `web/src/metrics/`. Don't touch other lanes' folders, `sightline/contract.py` or `web/src/contract.ts`.
- **Never evaluate or tune on the test split** except in `evaluate` for final reporting. Thresholds come from val.
- Keep all randomness seeded (`seed=7` default).
- Large data lives under `data/`; never commit it. Tests use tiny fixtures in `tests/ml/fixtures/`.
- GPU code must also import and fail clearly on a CPU machine (B, C and D run `uv sync` without the `ml` extra). Import torch/ultralytics/sahi lazily inside functions, not at module top level.
- Before finishing: `uv run pytest tests/ml`, `uv run ruff check sightline/ml`.
- Good first prompts:
  1. "Read docs/LANE_A_ML.md §5–6.1. Write `scripts/convert_heridal.py` and `scripts/tile_dataset.py` with tests first."
  2. "Implement `sightline/ml/evaluate.py` per §6.3 with the tests in §7. No GPU needed for tests."
  3. "Implement `Detector` per §5, lazily importing ultralytics and sahi."

---

## 12. Remote access to the GPU desktop (Windows) from the MacBook

Set this up before the event and test it from a phone hotspot.

**Network: Tailscale.** Install on both machines, same account. On the PC, enable "Run unattended". Turn on MagicDNS and note the PC's machine name (e.g. `desktop-dan`); it works from any network.

**SSH server on the PC** (PowerShell as Administrator):

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell `
  -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force
```

Key login from the Mac: `ssh-keygen -t ed25519`, then paste `~/.ssh/id_ed25519.pub` into the PC file. For an **administrator** account that's `C:\ProgramData\ssh\administrators_authorized_keys`, then:

```powershell
icacls.exe "C:\ProgramData\ssh\administrators_authorized_keys" /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"
```

(A standard account uses `C:\Users\<you>\.ssh\authorized_keys` instead.) Add to the Mac's `~/.ssh/config`:

```
Host pc
  HostName desktop-dan
  User <windows username>
```

Now `ssh pc`, `scp pc:"C:/path" .`, and VS Code Remote-SSH to `pc` all work.

**Remote desktop, for starting training.** Processes started over SSH on Windows can die with the connection. Start long runs in a terminal on the PC's own desktop: Windows Pro → Settings › System › Remote Desktop + the "Windows App" on the Mac; Windows Home → Chrome Remote Desktop or RustDesk. Start the run, disconnect, check later over SSH (`nvidia-smi`, `results.csv`).

**Keep it alive for 36 hours.** Sleep: Never. Pause Windows Update for the week. Tailscale and sshd start automatically; consider BIOS "power on after power loss".

**Python on the PC.** Native Windows Python with the CUDA build of PyTorch (exact command from pytorch.org), then `ultralytics` and `sahi`. Check: `python -c "import torch; print(torch.cuda.get_device_name(0))"` prints the 4080 SUPER.

**Pre-event test from a hotspot:** `ssh pc` works; remote desktop works; a 2-epoch run survives disconnecting for 10 minutes; `scp` both ways; the Colab/Kaggle backup has the tiles.
