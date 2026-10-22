# Sightline dress run 20261022-192933

Commit `de32e70`,
host: 32 CPUs, 30 GB RAM,
Linux 6.18.33.2-microsoft-standard-WSL2, Docker 29.8.2.
Container CPUs: all.
Image build: from nothing (--no-cache --pull).
LLM: fake (no key); conditions: fake (no key).

| Stage | Seconds | Result |
|---|---:|---|
| install-python-deps | 139.3 | pass |
| install-web-deps | 5.7 | pass |
| fetch-model | 2.6 | pass |
| fetch-caches | 7.6 | pass |
| install-project | 1.5 | pass |
| pytest | 90.3 | pass |
| smoke | 12.5 | pass |
| validate-demo-cache | 0.5 | pass |
| demo-cache-metrics | 0.0 | pass |
| api-remote-check | 2.3 | pass |
| api-remote-detector | 3.3 | pass |
| web-build | 1.9 | pass |
| web-dist-check | 0.2 | pass |
| **docker build (total)** | 367.5 | pass |
| **docker run (total)** | 124.8 | pass |
| **end to end** | 492.4 | pass |
