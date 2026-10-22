# Probability of detection by person size, and a stress test

Measured 22 Oct 2026 on the validation split. Evidence: `docs/evidence/pod/20261022-104502/pod.json` and
`pod.md`. Script: `scripts/analysis/stress_test.py`. Figure: `docs/report/figures/pod_curve.png`.

**Result.** At the frozen threshold 0.29 the detector finds a person whose shorter side spans about 18 px
**63 % of the time**, one of 22 px 74 %, one of 27 px 81 %, and one of 37 px or more 87 to 89 %. Under 20 px
it found 38 of 61 people (62 %). The live map used to credit every photo with the test recall 0.864. It now
reads the recall off this curve at the photo's ground sampling distance (GSD), so a photo taken too high to
show a person well counts for less: at 2 cm per pixel a 0.5 m wide person is 25 px and the photo's look is
worth 0.78, not 0.864; at 3 cm per pixel it is worth 0.63.

Of the degradations, motion blur, fog, dusk and heavy JPEG cost the most recall; downscaling alone (half the
pixels per person in each direction) cost 3.6 points.

![POD curve and stress test](figures/pod_curve.png)

## Method

- **Data.** The 95 annotated val photos (4000×3000, 333 people), as `evaluate_model.py` loads them
  (`annotated_only=True`; the Zenodo copy has 60 empty annotation stubs). The test split was not run.
- **Detector.** The frozen `cv2.dnn` path, `CvDetector.detect_tiled`: 1024 px SAHI slices, 0.2 overlap,
  merge NMS at IoU 0.5, VOC matching at IoU 0.5 and threshold 0.29. Nothing was tuned. Run on the GPU
  with the CUDA build of OpenCV 5.0.0 (`docs/report/CV2_CUDA.md`; its boxes are the CPU boxes to the
  pixel). The baseline reproduces the val numbers of `scripts/parity_table.py` exactly
  (P / R / AP50 0.735 / 0.859 / 0.861).
- **Conditions**, one at a time on the full-resolution photo:
  - downscale ×0.9 / 0.75 / 0.6 / 0.5: `INTER_AREA` down, `INTER_LINEAR` back up. This simulates a higher
    flight (fewer pixels per person) with the same photo size and tiling;
  - fog 20 / 40 / 60 %: alpha blend with light grey (192);
  - motion blur 5 / 9 / 15 px: a horizontal line kernel;
  - dusk: gamma 1.8 or 2.5 on 0..1, then brightness ×0.6 (−40 %);
  - JPEG re-encoded at quality 50 or 30.
- **Person size** is the shorter side of the labelled box in pixels. The original val boxes run from 25 to
  115 px, so the size curve pools the original photos with the four downscales, each box's size multiplied
  by the downscale factor (1,665 person-looks, 12 to 115 px). Bins with fewer than 20 people are reported
  but not used. The used bins are made non-decreasing in size (pool-adjacent-violators weighted by people),
  which only merges 37–44 px and 54–86 px.
- **Test, read-only.** The per-box test predictions already on disk (`data/work/analysis/preds.json`,
  written by `scripts/analysis/detector_errors.py` from the published model at 0.29) were rebinned by the
  same size measure. They give the published recall, 0.864 (291 / 337). Nothing was chosen from them.
- **Wall time** 342 s (5.7 min) for this run, with the baseline and 37 of the ×0.9 photos read from the
  per-condition cache of an interrupted first run (about 25 s per condition of 95 photos on the GPU;
  other jobs shared the machine).

## Conditions at threshold 0.29 (val, 95 photos, 333 people)

| Condition | Recall | Precision | AP50 | Found |
|---|---:|---:|---:|---:|
| original | 0.859 | 0.735 | 0.861 | 286 |
| downscale ×0.9 | 0.844 | 0.753 | 0.869 | 281 |
| downscale ×0.75 | 0.838 | 0.744 | 0.852 | 279 |
| downscale ×0.6 | 0.838 | 0.746 | 0.840 | 279 |
| downscale ×0.5 | 0.823 | 0.757 | 0.828 | 274 |
| fog 20 % | 0.784 | 0.752 | 0.795 | 261 |
| fog 40 % | 0.679 | 0.739 | 0.711 | 226 |
| fog 60 % | 0.616 | 0.751 | 0.623 | 205 |
| motion blur 5 px | 0.823 | 0.735 | 0.835 | 274 |
| motion blur 9 px | 0.730 | 0.759 | 0.755 | 243 |
| motion blur 15 px | 0.559 | 0.735 | 0.598 | 186 |
| dusk, gamma 1.8, −40 % | 0.772 | 0.576 | 0.757 | 257 |
| dusk, gamma 2.5, −40 % | 0.694 | 0.419 | 0.601 | 231 |
| JPEG q50 | 0.793 | 0.779 | 0.845 | 264 |
| JPEG q30 | 0.721 | 0.787 | 0.781 | 240 |

Dusk is the only condition that also raises false alarms (446 and 551 boxes kept against 389): the detector fires on
more of the darkened ground. Fog, blur and JPEG lose people but keep precision.

## Recall by person size

On the original val boxes (baseline), and the test rebinning for comparison:

| Shorter side | Val people | Val recall (95 % CI) | Test people | Test recall |
|---|---:|---|---:|---:|
| < 20 px | 0 | n/a | 0 | n/a |
| 20–40 px | 42 | 0.762 (0.61–0.87) | 81 | 0.876 |
| 40–60 px | 177 | 0.876 (0.82–0.92) | 184 | 0.859 |
| 60–100 px | 111 | 0.874 (0.80–0.92) | 70 | 0.871 |
| > 100 px | 3 | 0.667 | 2 | 0.500 |

The POD curve (original + downscales, size × factor):

| Shorter side | People | Recall | 95 % CI | Median px | Curve value |
|---|---:|---:|---|---:|---:|
| < 15 px | 9 | 0.556 | 0.27–0.81 | 14.5 | (not used) |
| 15–20 px | 52 | 0.635 | 0.50–0.75 | 17.8 | 0.635 |
| 20–25 px | 159 | 0.742 | 0.67–0.80 | 22.2 | 0.742 |
| 25–30 px | 210 | 0.809 | 0.75–0.86 | 27.0 | 0.809 |
| 30–35 px | 243 | 0.831 | 0.78–0.87 | 32.0 | 0.831 |
| 35–40 px | 220 | 0.877 | 0.83–0.91 | 37.2 | 0.870 |
| 40–50 px | 357 | 0.866 | 0.83–0.90 | 44.2 | 0.870 |
| 50–60 px | 213 | 0.897 | 0.85–0.93 | 54.0 | 0.893 |
| 60–80 px | 165 | 0.897 | 0.84–0.93 | 64.8 | 0.893 |
| 80–100 px | 33 | 0.849 | 0.69–0.93 | 86.0 | 0.893 |
| > 100 px | 4 | 0.500 | 0.15–0.85 | 104.8 | (not used) |

## What the map does with it

`sightline/search/pod.py` loads `sightline/search/pod_curve.json` (written by
`stress_test.py --write-curve`; its `source` key names the evidence file). For each photo,
`frame_recall` takes the GSD of the pixels the detector saw (`FrameInput.detector_gsd_m`, the original
photo's GSD in the live mission pipeline), turns an assumed person width of 0.5 m into pixels
(`PERSON_WIDTH_M / gsd`), and reads the curve: linear between points, held at the end values outside
them. That recall, times the conditions' visibility factor, goes into the existing per-cell POD
(`recall × (1 − canopy) × overlap`, capped at 0.95). Without a GSD for the detector's pixels, or without
the curve file, the constant 0.864 is used as before; the batch demo map (`sightline/search/build.py`)
gets no detector GSD from its frames today, so it keeps the constant.

| GSD (m per px) | 0.5 m person | Recall used |
|---:|---:|---:|
| 0.010 | 50 px | 0.884 |
| 0.015 | 33 px | 0.841 |
| 0.020 | 25 px | 0.781 |
| 0.025 | 20 px | 0.688 |
| 0.030 | 17 px | 0.635 |

A person under 20 px is found about 62 % of the time (38 of 61 here), against 86 % over the whole val
split; the map now discounts those cells accordingly, so after a high pass they keep more of their
probability than a full look would leave them, and the planner reads that probability.

## Limits

- **Val, not test, and val shares sites with training.** On new terrain expect lower numbers throughout
  (0.825 at the four unseen test sites, `docs/DETECTOR_LIMITS.md` §5).
- **Downscaling is a simulation of altitude.** A real higher flight also changes the viewing angle, haze
  and the camera's own processing.
- **0.5 m is an assumption, and it is smaller than a HERIDAL box.** Labelled boxes include a margin and
  people lying or sitting; HERIDAL's median shorter side is 53 px at a GSD the dataset does not publish.
  So "25 px for a 0.5 m person" is conservative: the real box at that GSD is likely larger and the map's
  discount is likely larger than needed.
- **Below 16 px the curve is not measured.** It holds 0.635 there, and the 9 people under 15 px were found
  5 times (0.56), so for very high flights the held value probably overstates the look.
- **One degradation at a time.** Real dusk with fog and motion blur together will be worse than any row.
- **Small bins are wide.** The 95 % intervals in the size table span 10 to 25 points; the curve is a
  measured trend, not a calibrated probability per pixel.

## Context

- **Johnson's criteria, as applied by DJI to drone SAR.** DJI's Drone SAR Altitude Guide (results page,
  https://enterprise-insights.dji.com/saraltitudeguideresult32) states that, by Johnson's criteria, the
  length of an object on screen needed for a 79 % probability is 4 px to detect it, 15 px to recognise it and
  25 px to identify it as the person searched for. The detector here sits near those marks: about 0.64 at
  18 px and 0.78 at 25 px. The two numbers are not the same measure (a person watching a screen against a
  detector at a fixed threshold), so the comparison is context, not validation.
- **Recall by GSD as the sensing function of a search.** Dumenčić, Lanča, Jakac and Ivić (2025),
  "Experimental validation of UAV search and detection system in real wilderness environment",
  https://arxiv.org/abs/2502.17372, use a YOLOv8 detector's recall per GSD group as the sensing function of
  their search planner, measured on their own initial flights (0.95 to 0.98 at the lowest GSD groups,
  0.88 at the highest); in the field missions recall fell as GSD rose, as here.

## Reproduce

```bash
# CPU (pip OpenCV): about 1.9 s per photo, so roughly 45 min for the 15 conditions:
uv run python scripts/analysis/stress_test.py --write-curve
# GPU, with the CUDA build of OpenCV (docs/report/CV2_CUDA.md):
PYTHONPATH=<dir with the built cv2/> uv run python scripts/analysis/stress_test.py --backend cuda --write-curve
```

Reruns read `runs/pod/cache/<onnx>/<condition>.jsonl` and only run what is missing.
