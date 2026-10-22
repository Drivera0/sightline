# Sightline clean-machine dress run: from a bare Python image to tests, demo cache, API and website,
# with every stage timed. Use deploy/dressrun/run.sh (it sends only the files git would commit as
# the build context, then runs the container and writes runs/dressrun/<timestamp>/times.md).
#
# Build time: the installs and downloads. Run time (stages.sh): pytest, smoke, the demo-cache
# validation, the API + remote_check, the web build. CPU only: nothing here needs a GPU.
# No keys are baked in; run.sh passes NEBIUS_API_KEY / TAVILY_API_KEY through at run time if set.
FROM python:3.11-slim-bookworm

# opencv-python (not headless: ultralytics and sahi need it too) needs libgl1 and libglib2.0-0.
# git: the pipeline stamps the commit into manifest.json, and a test builds a throwaway repo.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# Pinned tools: uv as in deploy/aws, Node 22 as in CI, pnpm as web/package.json's packageManager.
COPY --from=ghcr.io/astral-sh/uv:0.13.4 /uv /bin/uv
COPY --from=node:22.20.0-bookworm-slim /usr/local/bin/node /usr/local/bin/node
ARG TARGETARCH
ARG PNPM_VERSION=9.15.9
RUN set -e; case "${TARGETARCH:-amd64}" in \
      amd64) arch=x64; sum=38949c3009bd674780ca7d652baa9e2310f5cda07ab9160b0e2a9c4934ab0def ;; \
      arm64) arch=arm64; sum=93061af1e6186089c94c167dd3f441624893195559ff80918f109089e0459d84 ;; \
      *) echo "unsupported arch $TARGETARCH"; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/pnpm \
      "https://github.com/pnpm/pnpm/releases/download/v${PNPM_VERSION}/pnpm-linux-${arch}"; \
    echo "$sum  /usr/local/bin/pnpm" | sha256sum -c -; \
    chmod +x /usr/local/bin/pnpm

COPY deploy/dressrun/stage.sh /usr/local/bin/stage
ENV PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1 \
    CI=1

WORKDIR /app

# 1. Python: the dependencies from uv.lock (torch, ultralytics, sahi; astral for conditions; the
#    dev group for pytest), then the project itself.
COPY pyproject.toml uv.lock .python-version README.md LICENSE ./
RUN stage install-python-deps uv sync --frozen --no-install-project --extra ml --extra conditions

# 2. Web dependencies from the lockfile.
COPY web/package.json web/pnpm-lock.yaml ./web/
RUN stage install-web-deps bash -c 'cd web && pnpm install --frozen-lockfile'

# 3. The in-browser detector (ONNX, release model-onnx-v2, SHA256-checked) and both survey caches
#    (releases demo-cache and real-gps-cache), with the same scripts the Vercel build runs. The
#    API uses the same ONNX through cv2.dnn.
COPY web/scripts/fetch-model.sh web/scripts/fetch-caches.sh ./web/scripts/
RUN stage fetch-model bash -c 'cd web && bash scripts/fetch-model.sh && test -s public/models/sightline-detector-v2.onnx'
RUN stage fetch-caches bash -c 'cd web && bash scripts/fetch-caches.sh && test -s public/cache/demo/manifest.json && du -sh public/cache/*'

# 4. The rest of the repo, then install the project into the environment.
COPY . .
RUN stage install-project uv sync --frozen --extra ml --extra conditions \
    && ln -sfn ../web/public/cache/demo cache/demo

ENV PATH="/app/.venv/bin:$PATH" \
    UV_FROZEN=1 \
    UV_NO_SYNC=1 \
    SIGHTLINE_ONNX=/app/web/public/models/sightline-detector-v2.onnx

CMD ["bash", "deploy/dressrun/stages.sh"]
