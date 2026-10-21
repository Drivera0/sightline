# Sightline batch detection for a Nebius Serverless Job (A-N1): OpenCV 5 cv2.dnn on the CPU, no torch.
#   docker build -f deploy/nebius/Dockerfile -t sightline-batch .        (from the repo root)
#   docker run --rm -v $PWD/photos:/in -v $PWD/out:/out sightline-batch /in /out
FROM python:3.11-slim

# opencv-python (not headless, shared with ultralytics) needs these to import cv2.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.13.4 /uv /bin/uv

WORKDIR /app
COPY pyproject.toml uv.lock README.md LICENSE ./
RUN uv sync --frozen --no-dev --no-install-project
COPY sightline ./sightline
COPY scripts/nebius_batch_detect.py ./scripts/

# The variable-size ONNX export of weights-v2 (release model-onnx-v2), checked by SHA256.
ARG ONNX_URL=https://github.com/Drivera0/sightline/releases/download/model-onnx-v2/sightline-detector-v2-dynamic.onnx
ARG ONNX_SHA256=e44fed268293ea2f0bba0cb695892d0d87b592e465159c5e7bafdd68f4557370
RUN curl -fsSL -o /app/model.onnx "$ONNX_URL" \
    && echo "$ONNX_SHA256  /app/model.onnx" | sha256sum -c -
ENV SIGHTLINE_ONNX=/app/model.onnx

ENTRYPOINT ["uv", "run", "--frozen", "--no-dev", "python", "scripts/nebius_batch_detect.py"]
