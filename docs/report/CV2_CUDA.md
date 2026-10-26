# cv2.dnn on the GPU: OpenCV 5.0.0 built with CUDA

Measured 22 Oct 2026 on the development machine: Ryzen 9 9950X (32 threads), RTX 4080 SUPER
(driver 617.42), WSL2 on Windows, Ubuntu 24.04, gcc 13.3, CMake 3.28. Other jobs shared the
machine; the 1-minute load average is noted per run below.

**Result.** With a custom build of OpenCV 5.0.0 (CUDA 12.9, cuDNN 9.10), the Sightline detector runs
on the GPU through `cv2.dnn`: **10.5 ms per 1024 px slice and 0.30 s per 4000×3000 photo** in FP32,
against 95.8 ms and 1.97 s on the CPU with the pinned pip wheel, and **0.25 s per photo for Torch**
(Ultralytics + SAHI, `detector_metrics.json`) on the same GPU. The FP32 boxes are the CPU boxes to
the pixel: 363 of 363 at the frozen threshold 0.29, confidences within 0.000002, and the same test
scores (VOC P / R / AP50 0.802 / 0.864 / 0.868). FP16 is no faster here and moves a few boxes.

This is not the shipped path. The project pins `opencv-python==5.0.0.93`, which has no CUDA; the
judge path in `scripts/reproduce_cv2.py` stays on the CPU.

## Why a custom build, and why the classic engine

- No pip wheel of OpenCV 5.0.0 is built with CUDA (`cv2.cuda.getCudaEnabledDeviceCount()` is 0
  with `opencv-python==5.0.0.93`).
- OpenCV 5.0's new DNN engine (the default, `ENGINE_AUTO`) runs on the CPU only: `dnn.hpp` at the
  5.0.0 tag says of `ENGINE_NEW` "The engine does not support non CPU back-ends for now". The GPU
  path is therefore `readNetFromONNX(path, ENGINE_CLASSIC)` with `DNN_BACKEND_CUDA` and
  `DNN_TARGET_CUDA` (FP32) or `DNN_TARGET_CUDA_FP16`.
- `WITH_CUDA` in OpenCV 5.0.0 needs the `cudev` module from opencv_contrib
  (`modules/core/CMakeLists.txt`: "CUDA: OpenCV requires enabled 'cudev' module from
  'opencv_contrib' repository"), so the build takes opencv_contrib at the same 5.0.0 tag.

## Build recipe

There was no CUDA toolkit on the machine (`nvcc` absent, nothing under `/usr/local/cuda*`), and
no sudo. The pip wheel `nvidia-cuda-nvcc-cu12` ships `ptxas` but no `nvcc` driver, so the toolkit
came from conda-forge into a user prefix with micromamba:

```bash
S=<scratch dir>
curl -sL https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xj -C $S/mm bin/micromamba
MAMBA_ROOT_PREFIX=$S/mm/root $S/mm/bin/micromamba create -y -p $S/tk -c conda-forge \
    "cuda-version=12.9" cuda-nvcc cuda-cudart-dev libcublas-dev "cudnn>=9" libnpp-dev
# conda-forge keeps the CUDA headers under targets/x86_64-linux/include; FindCUDA wants them in include/
cd $S/tk/include && for f in ../targets/x86_64-linux/include/*; do [ -e "$(basename $f)" ] || ln -s "$f" .; done
```

Versions installed: nvcc 12.9.86, cudart 12.9.79, cuBLAS 12.9.2.10, cuDNN 9.10.2.21, NPP 12.4.1.87.
NPP is not used by the DNN module, but OpenCV's CUDA detection links it into every module and the
configure step fails with `CUDA_nppc_LIBRARY` set to NOTFOUND without it. A test kernel built with
this nvcc ran on the GPU under WSL2 (`/usr/lib/wsl/lib/libcuda.so`) before the OpenCV build.

Sources: `opencv` and `opencv_contrib`, tag `5.0.0` (commits `40738fb` and `755e506`), the version
the pinned wheel reports (`cv2.__version__ == "5.0.0"`). Python bindings are built against the
project's interpreter (uv CPython 3.11.17) and numpy 2.4.6, and installed into a separate venv,
never over the project's wheel:

```bash
cmake $S/src/opencv \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=$S/install \
  -DOPENCV_EXTRA_MODULES_PATH=$S/src/opencv_contrib/modules \
  -DBUILD_LIST=core,imgproc,imgcodecs,dnn,python3,python_bindings_generator,cudev \
  -DWITH_CUDA=ON -DWITH_CUDNN=ON -DOPENCV_DNN_CUDA=ON -DWITH_CUBLAS=ON -DWITH_CUFFT=OFF \
  -DCUDA_ARCH_BIN=8.9 -DCUDA_ARCH_PTX= \
  -DCUDA_TOOLKIT_ROOT_DIR=$S/tk -DCUDA_TOOLKIT_INCLUDE=$S/tk/targets/x86_64-linux/include \
  -DCUDA_HOST_COMPILER=/usr/bin/g++ \
  -DCUDNN_LIBRARY=$S/tk/lib/libcudnn.so -DCUDNN_INCLUDE_DIR=$S/tk/include \
  -DCMAKE_INSTALL_RPATH="$S/tk/lib;$S/install/lib" \
  -DBUILD_opencv_python3=ON -DPYTHON3_EXECUTABLE=$S/venv/bin/python \
  -DPYTHON3_LIBRARY=<uv python>/lib/libpython3.11.so \
  -DPYTHON3_INCLUDE_DIR=<uv python>/include/python3.11 \
  -DPYTHON3_NUMPY_INCLUDE_DIRS=$S/venv/lib/python3.11/site-packages/numpy/_core/include \
  -DOPENCV_PYTHON3_INSTALL_PATH=$S/venv/lib/python3.11/site-packages \
  -DBUILD_TESTS=OFF -DBUILD_PERF_TESTS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_DOCS=OFF -DBUILD_JAVA=OFF \
  -DWITH_OPENCL=OFF -DWITH_FFMPEG=OFF -DWITH_GSTREAMER=OFF -DWITH_GTK=OFF -DWITH_QT=OFF
cmake --build . -j16 && cmake --install .
```

`detect_cv.py` calls only `core`, `imgproc` (`resize`), `imgcodecs` (`imread`) and `dnn`
(`readNetFromONNX`, `blobFromImage`, `NMSBoxes`), so nothing else is built. Configure summary:
`NVIDIA CUDA: YES (ver 12.9, CUBLAS)`, `NVIDIA GPU arch: 89`, `cuDNN: YES (ver 9.10.2)`.

Three configure attempts failed before this one, each fixed by a flag above:
`DNN: CUDA backend requires CUDA Toolkit` (the headers were not found in the conda layout:
`CUDA_TOOLKIT_INCLUDE`), `python3` listed as unavailable (`PYTHON3_LIBRARY`,
`python_bindings_generator` in `BUILD_LIST`), and `CUDA_nppc_LIBRARY` NOTFOUND (`libnpp-dev`).

Time: configure 161 s (it downloads IPP and a font), compile and install **3 min 45 s** at `-j16`,
started with the 1-minute load average at 9. Toolkit prefix 3.7 GB, installed OpenCV 98 MB.

To use it, the build's `cv2` package goes first on `PYTHONPATH`; the project's venv is otherwise
unchanged:

```bash
PYTHONPATH=<dir containing only the built cv2/> uv run python -c \
    "import cv2; print(cv2.__version__, cv2.cuda.getCudaEnabledDeviceCount())"   # 5.0.0 1
```

## Code switch

`CvDetector(onnx, backend=...)` in `sightline/ml/detect_cv.py`, or `SIGHTLINE_CV_BACKEND`:

| Value | Load | Where it runs |
|---|---|---|
| `cpu` (default) | `readNetFromONNX(path)`, unchanged: OpenCV 5's default engine | CPU |
| `cuda` | `readNetFromONNX(path, ENGINE_CLASSIC)`, `DNN_BACKEND_CUDA`, `DNN_TARGET_CUDA` | GPU, FP32 |
| `cuda-fp16` | same, `DNN_TARGET_CUDA_FP16` | GPU, FP16 |

A `cuda` backend on a cv2 without CUDA raises a `RuntimeError` naming this file instead of falling
back to the CPU without saying so. `tests/ml/test_detect_cv.py` checks that the default still calls
`readNetFromONNX` with no engine argument and sets no preferable backend or target.
`scripts/reproduce_cv2.py --backend cuda` runs the published-number check on the GPU, and
`scripts/bench_cv2_backend.py` produced the numbers below.

## Parity on the test split

The test split (101 photos, 337 people) is only re-scored with the existing weights-v2 ONNX
(`yolo11s_tiles_run1_best.onnx`) at the threshold frozen on val in sprint 1 (0.29). Nothing is tuned.
Boxes are matched one-to-one per photo, highest IoU first (`parity_table.match`).

| Backend | VOC P / R / AP50 | SAR P / R | Boxes ≥ 0.29 | Matched to CPU at IoU ≥ 0.95 | Largest conf diff (≥ 0.29) |
|---|---|---|---|---|---|
| CPU, pip wheel, new engine | 0.802 / 0.864 / 0.868 | 0.898 / 0.896 | 363 | — | — |
| CUDA FP32, classic engine | **0.802 / 0.864 / 0.868** | **0.898 / 0.896** | **363** | **363 / 363, same pixels** | 0.000001 |
| CUDA FP16, classic engine | 0.804 / 0.864 / 0.868 | — | 362 | 356 / 363 | 0.0054 |

- **FP32:** every box at or above 0.29 has the same integer coordinates as on the CPU, and so does
  every saved box at or above 0.05 (538 / 538, confidences within 0.000002).
  `reproduce_cv2.py --backend cuda` reports MATCH against `detector_metrics.json`
  (0.802 / 0.864 / 0.868).
- **FP16:** at 0.29, one CPU box is missing (a false positive that drops under the threshold or
  merges, so precision goes from 0.802 to 0.804) and 6 boxes move to IoU 0.84 to 0.95 with
  the CPU box; recall and AP50 are unchanged. Among all saved boxes (≥ 0.05), 536 match, 2 CPU
  boxes and 5 FP16 boxes have no partner, and 16 matched boxes are below IoU 0.95 (none below 0.5).

## Speed

Each run is the loop `evaluate_model.py` times for Torch's `seconds_per_image`: one photo after
another through `detect_tiled` at the save threshold 0.05, `imread` included, in one process. One
warm-up photo runs first (CUDA context, cuDNN algorithm choice). "Forward" is
`blobFromImage` + `setInput` + `forward` per 1024 px slice, averaged over the 2,000 slices of the
101 photos. Mean ± sample standard deviation over runs.

| Path | Device | Runs | ms per slice (forward) | s per 4000×3000 photo |
|---|---|---|---|---|
| Torch (Ultralytics + SAHI), `detector_metrics.json` | RTX 4080 SUPER | 1 | — | **0.25** |
| OpenCV 5 cv2.dnn, CUDA FP32, classic engine | RTX 4080 SUPER | 5 | **10.5 ± 0.4** | **0.303 ± 0.012** |
| OpenCV 5 cv2.dnn, CUDA FP16, classic engine | RTX 4080 SUPER | 5 | 10.8 ± 0.9 | 0.314 ± 0.022 |
| OpenCV 5 cv2.dnn, CPU, new engine (pip wheel) | Ryzen 9 9950X, 32 threads | 3 | 95.8 ± 0.1 | 1.973 ± 0.005 |

Per-run seconds per photo: FP32 0.321, 0.303, 0.291, 0.305, 0.293; FP16 0.300, 0.287, 0.324, 0.318,
0.343; CPU 1.968, 1.977, 1.975. An earlier 3-run set gave FP32 0.309 ± 0.009 and FP16
0.322 ± 0.062 (one FP16 run at 0.393). Load average at the start of the GPU runs was 15 and fell
to 2 during them; the CPU runs started at about 5. The GPU also held other processes' memory
(3.5 to 8.4 GB of 16 GB in use by other jobs).

Reading the numbers:

- On the GPU the network is **9× faster per slice** than on the CPU (10.5 against 95.8 ms) and the
  whole photo **6.5× faster** (0.30 against 1.97 s).
- **cv2.dnn on CUDA is about 20 % slower per photo than Torch** (0.30 against 0.25 s). The forward
  passes are about 0.21 s of a photo (20 slices × 10.5 ms); reading the 4000×3000 JPEG takes
  0.067 s (`cv2.imread`, mean over the 101 photos), and the rest is letterboxing, decoding and NMS
  in Python on the CPU. The slices go through one at a time (batch 1).
- **FP16 gives nothing here** (10.8 against 10.5 ms per slice, within the run-to-run spread),
  while it changes a few boxes. I did not look into why; at batch 1 on a small model the time may
  be dominated by kernel launches and copies more than by arithmetic. FP32 is the variant to quote.

## Caveats

- **Custom build, not the pinned wheel.** These numbers need the build above. Anyone running
  `uv sync` gets `opencv-python==5.0.0.93`, CPU only; `SIGHTLINE_CV_BACKEND=cuda` then fails with
  the `RuntimeError` above.
- **The classic engine, not OpenCV 5's new one.** The new engine is CPU-only in 5.0. The CPU row
  uses the new engine; the GPU rows use the classic engine. FP32 gives the same boxes either way
  on this model.
- **CUDA 12.9 from conda-forge, not the system toolkit** (there is none). The driver reports CUDA
  13.4 support, and the project's Torch uses CUDA 13.0 wheels; I built against 12.9 (it compiled
  with no source changes) rather than try CUDA 13 with OpenCV's CUDA code first.
- **One machine, shared, under WSL2.** Other jobs used the CPU and the GPU's memory during the
  runs. The Torch 0.25 s is a single run from the evaluation (`detector_metrics.json`); the parity
  run in `scripts/parity_table.py` measured Torch at 0.30 s per test photo on the same GPU.
- **Not tried:** batching slices on the GPU, `cv2.cuda` for the resize, ONNX Runtime with CUDA or
  TensorRT providers inside OpenCV (`ENGINE_ORT`), or TensorRT directly.
