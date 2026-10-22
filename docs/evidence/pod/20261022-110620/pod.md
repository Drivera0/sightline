# POD stress test, 20261022-110620

Val split, 95 photos, 333 people; cv2.dnn (cpu), yolo11s_tiles_run1_best.onnx; frozen threshold 0.29. Wall time 0 s (0.0 min), 15 of 15 conditions from the cache.

## Conditions

| Condition | Recall | Precision | AP50 | Found / people | Boxes kept |
|---|---:|---:|---:|---:|---:|
| original | 0.859 | 0.735 | 0.861 | 286 / 333 | 389 |
| downscale x0.9 | 0.844 | 0.753 | 0.869 | 281 / 333 | 373 |
| downscale x0.75 | 0.838 | 0.744 | 0.852 | 279 / 333 | 375 |
| downscale x0.6 | 0.838 | 0.746 | 0.840 | 279 / 333 | 374 |
| downscale x0.5 | 0.823 | 0.757 | 0.828 | 274 / 333 | 362 |
| fog 20% | 0.784 | 0.752 | 0.795 | 261 / 333 | 347 |
| fog 40% | 0.679 | 0.739 | 0.711 | 226 / 333 | 306 |
| fog 60% | 0.616 | 0.751 | 0.623 | 205 / 333 | 273 |
| motion blur 5 px | 0.823 | 0.735 | 0.835 | 274 / 333 | 373 |
| motion blur 9 px | 0.730 | 0.759 | 0.755 | 243 / 333 | 320 |
| motion blur 15 px | 0.559 | 0.735 | 0.598 | 186 / 333 | 253 |
| dusk gamma 1.8, -40 % | 0.772 | 0.576 | 0.757 | 257 / 333 | 446 |
| dusk gamma 2.5, -40 % | 0.694 | 0.419 | 0.601 | 231 / 333 | 551 |
| JPEG q50 | 0.793 | 0.779 | 0.845 | 264 / 333 | 339 |
| JPEG q30 | 0.721 | 0.787 | 0.781 | 240 / 333 | 305 |

## Recall by person size (original val boxes, baseline)

| Shorter side | People | Found | Recall | 95 % CI |
|---|---:|---:|---:|---|
| <20 px | 0 | 0 | n/a |  |
| 20-40 px | 42 | 32 | 0.762 | 0.61-0.87 |
| 40-60 px | 177 | 155 | 0.876 | 0.82-0.92 |
| 60-100 px | 111 | 97 | 0.874 | 0.80-0.92 |
| >100 px | 3 | 2 | 0.667 | 0.21-0.94 |

## POD curve (baseline + downscales, size x downscale factor)

| Shorter side | People | Found | Recall | 95 % CI | Median px |
|---|---:|---:|---:|---|---:|
| <15 px | 9 | 5 | 0.556 | 0.27-0.81 | 14.5 |
| 15-20 px | 52 | 33 | 0.635 | 0.50-0.75 | 17.8 |
| 20-25 px | 159 | 118 | 0.742 | 0.67-0.80 | 22.2 |
| 25-30 px | 210 | 170 | 0.809 | 0.75-0.86 | 27.0 |
| 30-35 px | 243 | 202 | 0.831 | 0.78-0.87 | 32.0 |
| 35-40 px | 220 | 193 | 0.877 | 0.83-0.91 | 37.2 |
| 40-50 px | 357 | 309 | 0.866 | 0.83-0.90 | 44.2 |
| 50-60 px | 213 | 191 | 0.897 | 0.85-0.93 | 54.0 |
| 60-80 px | 165 | 148 | 0.897 | 0.84-0.93 | 64.8 |
| 80-100 px | 33 | 28 | 0.849 | 0.69-0.93 | 86.0 |
| >100 px | 4 | 2 | 0.500 | 0.15-0.85 | 104.8 |

Monotone curve points (px, recall; * low-n): (14.5, 0.556, n=9*), (17.8, 0.635), (22.2, 0.742), (27.0, 0.809), (32.0, 0.831), (37.2, 0.870), (44.2, 0.870), (54.0, 0.893), (64.8, 0.893), (86.0, 0.893)
Below the smallest point the map falls linearly to 0 at 4 px.

## Labelled box size in metres

121 boxes on the 70 of 95 photos with an EXIF pose: shorter side median 0.808 m (IQR 0.673-0.961), 53 px at a median GSD of 1.41 cm/px.

## Map recall by assumed person width

| Width | 2 cm/px | 3 cm/px |
|---|---:|---:|
| 0.4 m | 0.688 (20 px) | 0.494 (13.3 px) |
| 0.5 m | 0.781 (25 px) | 0.607 (16.7 px) |
| 0.6 m | 0.823 (30 px) | 0.688 (20 px) |
| 0.7 m | 0.854 (35 px) | 0.758 (23.3 px) |
| 0.8 m (used) | 0.870 (40 px) | 0.805 (26.7 px) |

## Test, read-only rebinning of data/work/analysis/preds.json

Recall 0.864 (291 / 337).

| Shorter side | People | Found | Recall |
|---|---:|---:|---:|
| <20 px | 0 | 0 | n/a |
| 20-40 px | 81 | 71 | 0.876 |
| 40-60 px | 184 | 158 | 0.859 |
| 60-100 px | 70 | 61 | 0.871 |
| >100 px | 2 | 1 | 0.500 |
