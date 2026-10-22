"""A-X1: the raw output tensor of OpenCV 5 ``cv2.dnn`` against onnxruntime, on the same input blobs.

    uv venv /tmp/ort && uv pip install --python /tmp/ort/bin/python onnxruntime "opencv-python==5.0.0.93" numpy
    /tmp/ort/bin/python scripts/raw_parity.py web/public/models/sightline-detector-v2.onnx docs/evidence/raw-parity.json

(onnxruntime is not a project dependency: this check is the only thing that needs it.) Two 1024 px tiles
from each of 6 HERIDAL **validation** photos (top-left and centre), preprocessed as ``CvDetector._forward``
does (``blobFromImage``, 1/255, RGB). Reports the max absolute difference per channel: box coordinates
are in pixels (0–1024), confidences in 0–1, so one threshold over both mixes units.
"""

import glob
import json
import sys

import cv2
import numpy as np
import onnxruntime as ort

onnx = sys.argv[1]
net = cv2.dnn.readNetFromONNX(onnx)
sess = ort.InferenceSession(onnx, providers=["CPUExecutionProvider"])
photos = sorted(glob.glob("data/heridal/yolo_full/val/images/*.jpg"))[:6]
diffs, rows = [], []
for p in photos:
    img = cv2.imread(p)
    h, w = img.shape[:2]
    for y0, x0 in ((0, 0), (h // 2 - 512, w // 2 - 512)):
        tile = img[y0 : y0 + 1024, x0 : x0 + 1024]
        blob = cv2.dnn.blobFromImage(tile, scalefactor=1 / 255, size=(1024, 1024), swapRB=True)
        net.setInput(blob)
        a = np.asarray(net.forward())
        b = sess.run(None, {"images": blob})[0]
        d = float(np.abs(a - b).max())
        box = float(np.abs(a[0, :4] - b[0, :4]).max())
        conf = float(np.abs(a[0, 4] - b[0, 4]).max())
        hi = a[0, 4] >= 0.05  # anchors that could become a detection
        conf_hi = float(np.abs(a[0, 4][hi] - b[0, 4][hi]).max()) if hi.any() else 0.0
        diffs.append((d, box, conf, conf_hi))
        rows.append(
            {
                "photo": p.split("/")[-1],
                "tile": [int(x0), int(y0)],
                "shape": list(a.shape),
                "max_abs_diff": d,
                "box_px_diff": box,
                "conf_diff": conf,
                "conf_diff_above_0.05": conf_hi,
                "max_conf_cv2": float(a[0, 4].max()),
                "max_conf_ort": float(b[0, 4].max()),
            }
        )
out = {
    "onnx": onnx.split("/")[-1],
    "opencv": cv2.__version__,
    "onnxruntime": ort.__version__,
    "tiles": len(rows),
    "max_abs_diff": max(x[0] for x in diffs),
    "box_px_max_diff": max(x[1] for x in diffs),
    "conf_max_diff": max(x[2] for x in diffs),
    "conf_max_diff_above_0.05": max(x[3] for x in diffs),
    "rows": rows,
}
print(json.dumps({k: v for k, v in out.items() if k != "rows"}))
with open(sys.argv[2], "w") as f:
    json.dump(out, f, indent=1)
