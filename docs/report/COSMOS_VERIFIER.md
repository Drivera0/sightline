# Cosmos as a second verifier (experiment, val only)

**Status: built and tested with a mocked client; not yet run.** `NVIDIA_API_KEY` was not set in
the environment when this was written (2026-10-22), so the Cosmos row below is empty. To fill it:

```bash
NVIDIA_API_KEY=... uv run --extra ml python scripts/eval_verifier.py --split val \
    --model nvidia/cosmos-reason2-8b --base-url https://integrate.api.nvidia.com/v1 \
    --workers 1 --min-interval 1.6 --out runs/cosmos_verifier
```

## Question

Would NVIDIA's physical-AI reasoner, Cosmos Reason, do the second look as well as Nemotron VL? We
score both on the same val near-miss and queue detections with the same prompt.

## What runs at run time is unchanged

Cosmos is **not on Nebius Token Factory**: the catalog was checked on 2026-10-22 and has no Cosmos
model. This experiment calls NVIDIA's hosted API (`build.nvidia.com`, OpenAI-compatible) from an
evaluation script only. `sightline/agent/verify.py` and every run-time model call still go
through Token Factory, so the claim "every runtime model call goes through Token Factory" still
holds. The extra endpoint and its key exist only in `scripts/eval_verifier.py --base-url`.

## Model id

| Where | Id |
|---|---|
| Hosted API, `GET https://integrate.api.nvidia.com/v1/models` (2026-10-22, 83 models) | **`nvidia/cosmos-reason2-8b`**: the only Cosmos id listed |
| Hugging Face | `nvidia/Cosmos-Reason2-8B` (released 2025-12-19, updated 2026-03-10). Its collection is marked archived and points to Cosmos3 |
| build.nvidia.com | the `nvidia/cosmos-reason2-8b` page now shows **Cosmos3 Nano Reasoner** (`nvidia/Cosmos3-Nano` on Hugging Face, released 2026-05-31). No `cosmos3` id is in the `/v1/models` list |

The script uses `nvidia/cosmos-reason2-8b`, the id the API lists. It is possible that NVIDIA now
serves Cosmos3 Nano under that id, since the catalog page shows Cosmos3 Nano. The `model` field
of each reply goes into the trace and the summary JSON, so a real run will show what answered.

## Method

`scripts/eval_verifier.py`, unchanged except for new options (`--model`, `--base-url`,
`--api-key-env`, `--min-interval`, `--price-in/--price-out`, `--data-root`):

- **The same detections.** The frozen detector (weights-v2, tiled, threshold 0.29) runs on the 95
  annotated val photos. `verify()` runs on every near-miss (0.15 ≤ conf < 0.29) and every queue
  item below 0.5: **170 detections**, the same set as the Nemotron VL row. Detection is
  deterministic, so the same detections come out.
- **The same images and prompt.** The same `verify()` call builds the crop and the OpenCV 5
  re-look images (the tools are chosen by the same heuristics) and sends prompt `verify-v2` with
  the same JSON schema (`response_format`, strict) at temperature 0. Only `model` and the
  endpoint change.
- **Nemotron-only flags off.** Token Factory's `chat_template_kwargs.enable_thinking=false` is not
  sent to the second endpoint. If Cosmos writes `<think>…</think>` before its answer,
  `strip_reasoning` drops it before the JSON is parsed (as for Nemotron).
- **Rate limits.** `--workers 1 --min-interval 1.6` keeps to at most 37.5 requests a minute.
  The client retries 429 and 5xx three times (1, 2, 4 s). NVIDIA states the trial limit on the
  API page; we have not confirmed the number.
- **Scores.** Accuracy: a decided verdict that matches the VOC label (`yes` on a true positive,
  `no` on a false one); `unclear` counts as wrong. Also the yes-rate, people called `yes`,
  false positives called `no`, the `unclear` share, the same for crops under 60 px, the val
  F2 of rule (b) (promote near-misses called `yes`), the p50 and p90 model latency, tokens, and
  "no second look" (a failed call, or no valid JSON after one retry).
- Val only. The test split is not used for this experiment.

## Results (val, 95 photos, 333 people, 170 verified detections)

| Verifier | Endpoint | Accuracy | Yes-rate | People → yes | False → no | Unclear | < 60 px people → yes / unclear | Rule (b) val F2 | p50 / p90 model ms | Tokens in / out (mean) | Cost per detection |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Nemotron-3.5-Super-VL (`nvidia/Nemotron-3.5-Super-VL`), thinking off | Token Factory | 0.312 (53/170) | 0.500 | 0.825 (33/40) | 0.154 (20/130) | 0.382 | 0.813 / 0.507 | 0.841 | 1306 / 1562 | 916 / 68 | ≈ 0.00033 |
| Cosmos Reason (`nvidia/cosmos-reason2-8b`) | NVIDIA API (trial) | | | | | | | | | | trial credits** |

The Nemotron row is `docs/evidence/verifier/val-verify-v2-20261020-165932/val-verify-v2-20261020-165932.json` (the run behind report
§5.4); its accuracy, yes-rate and p90 are recomputed from that run's CSV with the definitions above.
Accuracy is low by construction: 130 of the 170 are false positives, and the prompt
asks for `unclear` rather than `no` when the model cannot tell. \*\* NVIDIA's hosted endpoint runs on trial credits and states no per-token price;
`--price-in/--price-out` fill a cost if a price applies.

## What we expect, and how to read it

The Nemotron row already shows the hard part: on val, half of the crops where the person is
under 60 px get `unclear`. Cosmos Reason is a 8B model trained for video and robotics scenes
from ground or vehicle cameras, not for 60 px people seen from 50 m up, so we expect it to do
worse. That is a useful result: it shows the second look needs a larger VL model, and that
the OpenCV 5 zoom, not the model, is what makes small people readable. Possible causes of a
worse row are image size limits on the hosted endpoint, the strict JSON schema not being
supported (counted as "no second look"), or the reasoning output using up `max_tokens`.

## Reproduce

Tests (mocked client, no key): `uv run pytest tests/agent/test_eval_verifier.py -q`. Then run the
command at the top. The outputs are `runs/cosmos_verifier/val-verify-v2-cosmos-reason2-8b-<time>.csv`
and `.json`. Copy the JSON's `accuracy`, `yes_rate`, `near_miss` / `small_under_60px` blocks, `rules`,
`median_model_ms`, `p90_model_ms` and the token means into the table.
