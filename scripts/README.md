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

MD5 `c5dc48d8bae53cd09b2933e98327e3ab`. Test data only: never train on it, never commit it.

## Scripts

| Script | What it does | Output |
|---|---|---|
| `convert_heridal.py` | VOC XML → YOLO txt using the official `trainval`/`test` lists; val = seeded 10 % of trainval, split by image (`seed=7`). Images are hard-linked, not copied. | `data/heridal/yolo_full/{train,val,test}/{images,labels}`, `convert_report.json` |
| `tile_dataset.py` | Cuts train and val images into 1024 px tiles, 20 % overlap. Keeps a box if ≥ 50 % of it is inside the tile and it's ≥ 8 px a side. Keeps every tile with a box plus a seeded 25 % of empty tiles. | `data/heridal/yolo_tiles/{train,val}`, `dataset.yaml`, `tile_report.json` |

Run order: `convert_heridal.py`, then `tile_dataset.py`. Both print a JSON report with the counts.

Expected counts (match the HERIDAL paper): 1,546 trainval images / 2,892 boxes, 101 test images / 337 boxes.
The raw archive also contains 37 JPEGs and 3 XMLs that are in no official list; they are reported and ignored.

Logic lives in `sightline/ml/voc.py` and `sightline/ml/tiling.py`; tests in `tests/ml/`.

## Event-time scripts (GPU)

| Script | What it does | Output |
|---|---|---|
| `evaluate_model.py` | Chooses `candidate_threshold` on **val** (max F2, tiled inference), then scores the 4 ablation rows on the full **test** set with VOC and SAR-style matching. | `data/work/detect/detector_metrics.json` (contract `DetectorMetrics` + `Ablation` rows), `evaluate_details.json` |
| `mine_hard_negatives.py` | Tiled inference over training images; cuts a 1024 tile around every false positive (conf ≥ 0.25, IoU < 0.1 to all truth), capped at 2,000, seeded. Writes a YAML that trains on tiles + hard negatives. | `data/heridal/hard_negatives/{images,labels}`, `data/heridal/dataset_hn.yaml` |

Detection on the demo frames is one call, `sightline.ml.run_survey(...)` (see `sightline/ml/survey.py`); D's
`detect` stage wraps it. The library code: `detect.py` (`Detector`: `detect_frame`, `detect_tiled` via SAHI,
`detect_resized`), `evaluate.py` (scoring, threshold choice), `crops.py`, `hard_negatives.py`, `data.py`.
Until lane D lands `sightline/contract.py`, the metrics models come from `sightline/ml/_contract_shim.py`.

## Training (timing run, then run 1)

```bash
yolo detect train model=yolo11s.pt data=data/heridal/yolo_tiles/dataset.yaml imgsz=1024 \
  epochs=<n> batch=-1 patience=15 seed=7 single_cls=True degrees=180 flipud=0.5 fliplr=0.5 \
  close_mosaic=10 project=data/runs name=tiles_s
```

Start long runs in a terminal on the desktop's own session, not over SSH.
