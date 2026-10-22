# Security

Sightline is a hackathon prototype for search-and-rescue planning. It has never been used on a real
search, and the public demo holds no real search data. This page covers what the demo exposes, what
protects it and how to report a problem.

## What the public demo exposes, and why

- **The website** (Vercel) is static. Its demo missions are fixtures in the bundle. It holds no keys
  and no token.
- **The mission API on AWS** (`https://<ip>.sslip.io`, HTTPS through Caddy) is open by default, so
  judges can create a mission, upload a photo and watch the agent work without signing up. Anyone
  with the address can read missions (`GET`) and their event streams (SSE), and, unless the write
  token is on, create missions, upload photos and make decisions. The photos are HERIDAL validation
  images (CC BY 3.0) and the missions are demos.
- **What it doesn't expose:** API keys (Nebius, Tavily) are only in AWS Secrets Manager and the
  container's environment, never in the image, the repo, the browser or a mission trace (the trace
  redacts key-like fields, `sightline/agent/trace.py`). The S3 bucket is private. The instance has no
  SSH port: shell access goes through SSM. The instance role can only reach its own bucket prefix,
  queue, log group, metrics namespace and secret (`deploy/aws/iam-policy.json`).
- **CORS** lets browsers call the API from the Vercel site and from localhost only. That limits
  browsers, not scripts (`deploy/aws/README.md`).

## What the write token closes

With `SIGHTLINE_API_TOKEN` set on the API, every POST, PUT, PATCH and DELETE needs
`Authorization: Bearer <token>`. Without it the API answers 401 with a plain message. Reads,
`/health` and SSE stay open, so the public site can still show a mission but can't change one.
Clients send the token from the same variable (`VITE_API_TOKEN` for a private web build only: a
token in a public bundle is readable by anyone). How to turn it on during judging:
`deploy/aws/README.md`. Code: `sightline/api/auth.py`.

## Limits on what a client can send

All in `sightline/api/limits.py` and `sightline/api/missions.py`, with tests in
`tests/pipeline/test_api_hardening.py`. The sizes are based on the 1,647 full HERIDAL photos
(median 5.1 MB, largest 6.9 MB).

| What | Limit | Answer |
|---|---|---|
| One photo | 28 MB (4× the largest HERIDAL photo), 100 MP, must decode as a JPEG with GPS and a drone pose | rejected in `rejected` with the reason |
| One photo batch | 1–50 files, 400 MB | 422 / 413 |
| File type | `.jpg`, `.jpeg` or `.png`, declared as JPEG, PNG or no type | 415 |
| File name | a label only, never a path; `..`, separators and absolute paths are refused | rejected, "unsafe file name" |
| JSON writes | 1 MB | 413 |
| Other multipart writes (radio audio) | 25 MB; the clip must be 0.4–30 s | 413 / "say again" |
| Writes per client IP | 600 per 60 s by default (`SIGHTLINE_RATE_LIMIT`; behind Caddy keyed on `X-Forwarded-For`). Sized for the simulated fleet on one IP: 3 drones + a ground station write at most 4 times per tick, 480 a minute at `creek_run`'s 2 ticks a second, leaving 120 for the console, radio and a replay (`sightline/api/limits.py`). The fleet and `creek_run` retry after `Retry-After`. | 429 + `Retry-After` |
| Sprint-1 zip upload (`POST /survey`) | its own limits on size, count and unpacked size; member names are never used as paths | 413 / 422 |

Every uploaded image is decoded and re-saved by Pillow before anything else reads it. The mission
store refuses any relative path containing `..`, a backslash or an absolute path
(`sightline/mission/store.py`).

## Data retention

The demo stores nothing about real people. Photo originals in S3 expire after 30 days (bucket
lifecycle rule), container logs after 14 days (CloudWatch), and mission files live on the instance's
volume until `deploy/aws/teardown.sh` deletes everything after judging. Responsible use, imagery and
the "never clear" rule: `docs/report/OPENCV_REPORT.md` §11.

## Secrets in the repository

On 2026-10-22, all of git history (every branch, 907 commits) was searched for AWS access keys
(`AKIA…`), OpenAI-style keys (`sk-…`), JWTs (`eyJ…`), NVIDIA (`nvapi-…`) and Tavily (`tvly-…`) keys,
private keys, `KEY=`/`TOKEN=` assignments with a value, and any committed `.env` file. **No secret
was found.** The only hits were a word ending in "-task-board", base64 image data, and fixed test
values, and the only env file ever committed is `.env.example`, with empty keys. `.env` is
gitignored.

## Reporting a problem

Please don't open a public issue for a vulnerability. Contact the maintainer privately through the
GitHub profile [@Drivera0](https://github.com/Drivera0). We'll answer within a few days. This is a prototype, so the likely fix is to
stop the instance first and patch it afterwards.
