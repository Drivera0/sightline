# Canopy classifier tuning report

- Date: 2026-10-18
- Labelled frames: 20
- Combinations tried: 180
- Best thresholds: exg_thr=0, std_thr=10, shadow_thr=40
- Best MAE: 0.3206
- Default thresholds: exg_thr=0.04, std_thr=12, shadow_thr=60
- Default MAE: 0.3412

Caveat: the labels are by eye, on a 5-step scale (0, 0.25, 0.5, 0.75, 1), by one
person, on a small set of 1000×750 crops. The thresholds were tuned on the same
frames that give the MAE, so the MAE is optimistic.

| id | label | default | best |
|---|---|---|---|
| c01 | 0.75 | 0.266 | 0.425 |
| c02 | 0.25 | 0.948 | 0.773 |
| c03 | 1.00 | 0.912 | 0.892 |
| c04 | 0.00 | 0.297 | 0.253 |
| c05 | 1.00 | 0.916 | 0.765 |
| c06 | 1.00 | 0.780 | 0.892 |
| c07 | 1.00 | 0.083 | 0.195 |
| c08 | 0.25 | 0.011 | 0.024 |
| c09 | 1.00 | 0.114 | 0.259 |
| c10 | 0.75 | 0.808 | 0.753 |
| c11 | 0.50 | 0.498 | 0.645 |
| c12 | 0.25 | 0.235 | 0.208 |
| c13 | 1.00 | 0.851 | 0.858 |
| c14 | 0.25 | 0.230 | 0.309 |
| c15 | 0.00 | 0.597 | 0.851 |
| c16 | 0.50 | 0.834 | 0.752 |
| c17 | 0.00 | 0.291 | 0.568 |
| c18 | 0.25 | 0.041 | 0.130 |
| c19 | 1.00 | 0.030 | 0.305 |
| c20 | 0.50 | 0.766 | 0.712 |
