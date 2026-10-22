# INT8 QDQ in OpenCV 5's DNN engines (experiment, val only)

**Result: the INT8 model loads and runs in OpenCV 5's new engine without errors, but it is slower
than FP32 and slightly less accurate.** The default inference path is unchanged: FP32 on
`ENGINE_NEW`.

| Val, 95 photos, 333 people, threshold 0.29 | ms per 1024 px tile | s per 4000×3000 photo (20 tiles) | VOC P / R / AP50 | Model size |
|---|---|---|---|---|
| FP32 (the shipped export), `ENGINE_NEW` | **92.0 ± 3.0** | **1.99 ± 0.09** | **0.735 / 0.859 / 0.861** | 36.4 MB |
| INT8 QDQ (Detect head kept float), `ENGINE_NEW` | 132.4 ± 3.5 | 2.77 ± 0.07 | 0.728 / 0.853 / 0.842 | 12.0 MB |

Mean ± sd over 5 timing runs. INT8 is 1.44× slower per tile, misses 2 more people (284 vs 286
found) and has 1 more box kept (390 vs 389).

## Method

- **Quantization** (`scripts/quantize_onnx.py quantize --exclude-head`), following opencv_zoo's
  `tools/quantize/quantize-ort.py`: a `CalibrationDataReader`, then `quant_pre_process`, then
  `quantize_static` with onnxruntime 1.30.0 (the new `quant` extra, which is not a run-time
  dependency). QDQ format (opencv_zoo uses QOperator), uint8 activations, int8 weights per
  tensor, MinMax calibration, opset 17 kept. Calibration used **64 val tiles**: random SAHI slices
  of random annotated val photos (seed 0), preprocessed exactly as `CvDetector` does (letterbox,
  1/255, RGB). The source model is the fixed 1024 px FP32 export
  (`data/weights/release_v2/yolo11s_tiles_run1_best.onnx`).
- **Loading:** `cv2.dnn.readNetFromONNX(path, engine)` through a new optional `engine` argument
  of `CvDetector`. When `engine` is not given, the call is unchanged, and a test checks this.
  With `ENGINE_NEW` passed explicitly there is no fallback to classic: the AUTO mode is the one
  that falls back. Neither engine printed a warning or an error for either QDQ model (the logs
  were checked).
- **Timing** (`bench --no-eval --runs 5`): 40 val tiles through `forward()` alone, and 5 full val
  photos through `detect_tiled` (the same tiling, letterbox, NMS and merge as production). After
  one warm-up pass, the runs of all models are interleaved (run 1 of each model, then run 2, and
  so on), so background load hits every row the same way.
- **Accuracy** (`bench`): `detect_tiled` on all 95 annotated val photos, scored with
  `score_voc` at the frozen 0.29 threshold, the same code as the report's parity table. The FP32
  row reproduces the published val numbers (0.735 / 0.859 / 0.861) exactly.
- **Machine:** AMD Ryzen 9 9950X (16 cores, 32 threads, all used by `cv2.setNumThreads`), WSL2
  Linux 6.18, OpenCV 5.0.0 (pip wheel, CPU), Python 3.11.17.
- **The test split was never read.**

## Other rows measured

| Variant (val) | ms per tile | s per photo | VOC P / R / AP50 |
|---|---|---|---|
| FP32, `ENGINE_CLASSIC` | 121.8 ± 33.5 (one outlier run at 182; the other four 103–111) | 2.29 ± 0.21 | 0.735 / 0.859 / 0.861 |
| INT8 QDQ, head float, `ENGINE_CLASSIC` | 186.1 ± 7.0 | 3.85 ± 0.09 | 0.720 / 0.850 / 0.839 |
| INT8 QDQ, **whole graph** quantized, `ENGINE_NEW` | 168 (from the noisy first run) | — | **0 / 0 / 0**: no box at or above 0.29 on any photo, and no true positive at any confidence |
| ONNX Runtime 1.30 CPU, outside OpenCV (reference) | FP32 102.9 ± 8.1, INT8 head float 69.0 ± 3.9 | — | not scored |

- **The fully quantized graph finds nobody.** ONNX Runtime gives the same all-zero class scores
  on the same tile, so the problem is the quantization, not OpenCV. The likely cause is YOLO11's
  output: box coordinates (0–1024 px) and class scores (0–1) are concatenated into one tensor, and
  a single uint8 scale over that range rounds every score to zero. Keeping the 84 nodes of the
  Detect head (`/model.23/`) in float fixes it, which is what `--exclude-head` does. This model's
  classic-engine row was stopped before it finished, since its new-engine row was already zero.
- **ONNX Runtime makes the same INT8 file 1.5× faster; OpenCV 5 makes it 1.44× slower.** This fits
  OpenCV running the QDQ pairs as dequantize, then a float convolution, rather than fusing them
  into int8 kernels. We have not checked this in OpenCV's source. The INT8 file has 248
  QuantizeLinear and 375 DequantizeLinear nodes around 88 convolutions.

## Caveats

- **A busy machine.** Other jobs shared the CPU (load average 16–50 on 32 threads during these
  runs). The table uses the second timing run (load 17–21). The first run, at load 21–47, gave
  the same order: FP32 new 124 ± 19 ms, INT8 new 171 ± 32 ms, `runs/int8/bench-20261022-021019.json`.
  The FP32 new-engine figure (92 ms per tile, 1.99 s per photo) agrees with the report's quiet-machine
  measurement (96 ms, 1.91 s), and the interleaving keeps the comparison fair. The absolute
  numbers on a quiet machine may be a few per cent lower.
- **One calibration recipe.** We tried MinMax, per-tensor, 64 tiles, with the head float.
  Per-channel weights, entropy or percentile calibration, or more tiles might recover the 0.02
  of AP50. None of them would change the speed result, which comes from how the engine runs QDQ.
- The accuracy table is one deterministic pass. Timing used 40 tiles and 5 photos, a subset
  of val.
- On this CPU, cv2.dnn has no CUDA build and the new engine is CPU-only. INT8 might do better
  on another backend (OpenVINO, TIM-VX/NPU); that was not tried.

## Conclusion

On a desktop CPU with OpenCV 5.0's pip wheel, INT8 QDQ is not worth it for this detector. It
loads and runs in the new engine, which answers the open question in our research notes, but it
costs 44 % more time and 0.02 AP50. The size goes down 3×, which would matter only for a download
(the browser copy) and not on the server. FP32 on `ENGINE_NEW` stays the default.

## Reproduce

```bash
uv sync --extra ml --extra quant
uv run python scripts/quantize_onnx.py quantize --exclude-head          # runs/int8/*_int8_qdq_nohead.onnx
uv run python scripts/quantize_onnx.py bench \
    --int8 runs/int8/yolo11s_tiles_run1_best_int8_qdq_nohead.onnx          # accuracy + timing
uv run python scripts/quantize_onnx.py bench --no-eval --runs 5 --timing-photos 5 \
    --int8 runs/int8/yolo11s_tiles_run1_best_int8_qdq_nohead.onnx          # interleaved timing only
```

Outputs, not committed (`runs/` is ignored): `runs/int8/bench-*.json`,
`runs/int8/accuracy-20261022.log`.
