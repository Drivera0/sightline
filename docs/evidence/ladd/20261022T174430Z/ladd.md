# LADD, frozen detector, one run (20261022T174430Z)

Data: 1365 photos, 4733 people (0 photos without people); every photo of the Supervisely copy (datasets ds0; it carries no split).
Model `sightline-detector-v2.onnx` (sha256 `095fcc4340c0`), cv2.dnn on CUDA (cuda, ENGINE_CLASSIC),
threshold 0.29 (frozen on HERIDAL val), merge NMS 0.5.

| Set | VOC precision | VOC recall | AP50 | SAR-APD P / R |
|---|---|---|---|---|
| LADD (1365 photos, never seen) | 0.509 | 0.516 | 0.458 | 0.677 / 0.649 |
| HERIDAL test (101 photos) | 0.802 | 0.864 | 0.868 | 0.898 / 0.896 |
| HERIDAL test, 4 unseen sites | | 0.825 | | |

At 0.29: 2444 people found, 2289 missed, 2357 false alarms (1.73 per photo).
Wall time 472 s for 1365 photos detected in this invocation (0.34 s per photo of wall time); 1 workers x 32 threads.
