# Sightline image for AWS: one image, two containers (api and worker). Built by lane A (issue #23);
# compose, Caddy, IAM, S3/SQS and the commands it runs are lane D's (README.md "Still to do").
#   docker build -f deploy/aws/Dockerfile -t sightline .        (from the repo root)
#   docker run --rm sightline python scripts/container_check.py
FROM python:3.11-slim

# opencv-python (not headless: ultralytics and sahi need it too) needs these to import cv2.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.13.4 /uv /bin/uv

WORKDIR /app
# Extras D adds in D-C1 (pyproject): e.g. --build-arg UV_EXTRAS="--extra agent --extra conditions --extra aws"
ARG UV_EXTRAS=""
COPY pyproject.toml uv.lock README.md LICENSE ./
RUN uv sync --frozen --no-dev --no-install-project $UV_EXTRAS
COPY sightline ./sightline
COPY scripts/container_check.py ./scripts/
RUN uv sync --frozen --no-dev $UV_EXTRAS
ENV PATH="/app/.venv/bin:$PATH"

# The variable-size ONNX export of weights-v2 (release model-onnx-v2), checked by SHA256.
ARG ONNX_URL=https://github.com/Drivera0/sightline/releases/download/model-onnx-v2/sightline-detector-v2-dynamic.onnx
ARG ONNX_SHA256=e44fed268293ea2f0bba0cb695892d0d87b592e465159c5e7bafdd68f4557370
RUN mkdir -p /app/models \
    && curl -fsSL -o /app/models/sightline-detector-v2-dynamic.onnx "$ONNX_URL" \
    && echo "$ONNX_SHA256  /app/models/sightline-detector-v2-dynamic.onnx" | sha256sum -c -
ENV SIGHTLINE_ONNX=/app/models/sightline-detector-v2-dynamic.onnx \
    SIGHTLINE_BACKEND=cv2 \
    PYTHONUNBUFFERED=1

EXPOSE 8000
# api: the default. worker: override the command with lane D's worker (see README.md).
CMD ["python", "-m", "sightline.pipeline", "serve", "--host", "0.0.0.0", "--port", "8000"]
