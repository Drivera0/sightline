# A second verifier for the second look (experiment, val only)

**Status (2026-10-22): Cosmos could not be run; Nemotron 3 Nano Omni was run in its place.
Nemotron-3.5-Super-VL stays as the second look. No number elsewhere in the report changes.**

The file keeps its old name (`COSMOS_VERIFIER.md`) so existing links work.

## Question

Would a second vision-language model, ideally from a different family than Nemotron VL, do the
second look as well? We score both on the same val near-miss and queue detections with the same
prompt. The first candidate was NVIDIA's physical-AI reasoner, Cosmos Reason.

## What runs at run time is unchanged

Neither Cosmos nor Nemotron 3 Nano Omni is on Nebius Token Factory (catalog checked on 2026-10-22).
This experiment calls NVIDIA's hosted API (`build.nvidia.com`, `https://integrate.api.nvidia.com/v1`,
OpenAI-compatible, free trial key) from an evaluation script only. `sightline/agent/verify.py` and
every run-time model call still go through Token Factory, so the claim "every runtime model call goes
through Token Factory" still holds. The extra endpoint and its key exist only in
`scripts/eval_verifier.py --base-url`; the key was read from `NVIDIA_API_KEY` and is in no file.

## Finding: the catalogue lists models that no longer answer

Checked on 2026-10-22 with a free build.nvidia.com key:

| Model id | In `GET /v1/models` | Chat completion |
|---|---|---|
| `nvidia/cosmos-reason2-8b` | yes (the only Cosmos id listed, of 83 models) | HTTP 404 "Function … not found for account" |
| `nvidia/cosmos3-nano-reasoner` | no | HTTP 404 |
| `nvidia/cosmos-reason1-7b` | no | HTTP 404 |
| `nvidia/vila` | no | HTTP 404 |
| `nvidia/nemotron-nano-12b-v2-vl` | no | HTTP 410, end of life 2026-08-26 |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | yes | answers, accepts images |

So the Cosmos harness could not run: the only Cosmos id the models endpoint lists returns 404 on
every call, and nothing in `/v1/models` marks it as retired. On Hugging Face, `nvidia/Cosmos-Reason2-8B`'s
collection is marked archived and points to Cosmos3 (`nvidia/Cosmos3-Nano`, released 2026-05-31),
and the build.nvidia.com page for `nvidia/cosmos-reason2-8b` shows Cosmos3 Nano Reasoner, but no
Cosmos3 id answers on the API. This is in the NVIDIA feedback (`docs/feedback/nebius.md` §10).

## Method

`scripts/eval_verifier.py`, the same harness as the Nemotron VL run, with `--model`, `--base-url`,
`--workers 1 --min-interval 1.6`:

```bash
NVIDIA_API_KEY=... uv run --extra ml python scripts/eval_verifier.py --split val \
    --model nvidia/nemotron-3-nano-omni-30b-a3b-reasoning \
    --base-url https://integrate.api.nvidia.com/v1 \
    --workers 1 --min-interval 1.6 --out runs/omni_verifier
```

- **The same detections.** The frozen detector (weights-v2, tiled, threshold 0.29) runs on the 95
  annotated val photos. `verify()` runs on every near-miss (0.15 ≤ conf < 0.29) and every queue
  item below 0.5: **170 detections** (40 real people, 130 false alarms), the same set and order as
  the Nemotron VL row (checked: the same 170 photo/index keys, the same tools per crop).
- **The same images and prompt.** The same `verify()` call builds the crop and the OpenCV 5
  re-look images and sends prompt `verify-v2` with the same JSON schema (`response_format`,
  strict) at temperature 0. Only `model` and the endpoint change.
- **Nemotron-only flags off.** Token Factory's `chat_template_kwargs.enable_thinking=false` is not
  sent to the second endpoint, so Omni runs in its reasoning mode; `strip_reasoning` drops any
  `<think>…</think>` before the JSON is parsed.
- **Rate limits.** `--min-interval 1.6` keeps to at most 37.5 requests a minute, under the 40 a minute
  commonly reported for the trial tier (NVIDIA does not state it in the API reference; see §10 of
  the feedback). The client retries 429 and 5xx three times (1, 2, 4 s), then its circuit breaker
  stops calling for a while (`sightline/agent/llm.py:67`).
- **Scores.** Accuracy: a decided verdict that matches the VOC label (`yes` on a true positive,
  `no` on a false one); `unclear` counts as wrong. Precision and recall of the `yes` verdict over
  the 170 crops (`tp` column). "No second look" is a failed call; the verifier then answers
  `unclear` with the reason, as at run time.
- Val only. The test split is not used for this experiment.

## Results (val, 95 photos, 333 people, 170 verified detections)

**72 of Omni's 170 calls failed.** The endpoint returned HTTP 500 twice (crops 78 and 138 in run
order), the retries failed, and the circuit breaker then turned the next 70 crops into "no second
look" (`CircuitOpen` in the reason column). Those 72 rows count as `unclear`, so the all-crop row
below mixes the model with the endpoint. The second table compares the two models on the **98
crops Omni answered**.

All 170 crops:

| Verifier | Endpoint | `yes` on people | `yes` on false alarms | `no` on false alarms | `unclear` (of which failed calls) | `yes` precision / recall | Accuracy | Rule (b) val F2 | p50 / p90 model ms | Tokens in / out (mean) | Cost per detection |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Nemotron-3.5-Super-VL (`nvidia/Nemotron-3.5-Super-VL`), thinking off | Token Factory | 33/40 | 52/130 | 20/130 | 65 (0) | 0.388 / 0.825 | 0.312 (53/170) | 0.841 | 1306 / 1562 | 916 / 68 | ≈ 0.00033 |
| Nemotron 3 Nano Omni (`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`), reasoning on | NVIDIA API (trial) | 20/40 | 43/130 | 2/130 | 105 (72) | 0.317 / 0.500 | 0.129 (22/170) | 0.836 | 4865 / 27182 * | 535 / 374 * | trial credits ** |

The 98 crops Omni answered (21 people, 77 false alarms):

| Verifier | `yes` on people | `yes` on false alarms | `no` on false alarms | `unclear` | `yes` precision / recall | Under 60 px: people `yes` / crops `unclear` | p50 / p90 model ms | Tokens in / out (mean) |
|---|---|---|---|---|---|---|---|---|
| Nemotron-3.5-Super-VL | 16/21 | 25/77 | 12/77 | 45 | 0.390 / 0.762 | 8/11 / 31/53 | 1309 / 1662 | 919 / 68 |
| Nemotron 3 Nano Omni | 20/21 | 43/77 | 2/77 | 33 | 0.317 / 0.952 | 11/11 / 20/53 | 10794 / 33021 | 928 / 649 |

\* The run's JSON averages over all 170 rows, with 0 ms and 0 tokens for the 72 failed calls; over
the 98 answered calls the figures are those of the second table. 0 JSON retries in both runs.
\*\* NVIDIA's hosted endpoint runs on trial credits and states no per-token price.

**Agreement on the same crops.** The two models give the same verdict on 89 of 170 crops (52 %),
69 of the 98 Omni answered (70 %). Where both decided (`yes` or `no`), they agree on 43 of 46. The
disagreements are one-sided: on 19 crops VL says `unclear` and Omni `yes`, on 7 VL says `no` and
Omni `unclear`, on 3 VL `no` and Omni `yes`; Omni never says `unclear` or `no` where VL says `yes`
on an answered crop.

**Real people by posture** (the posture Nemotron VL gave, since Omni's `unclear` rows carry none):

| Posture (VL) | People | VL `yes` | Omni `yes` | Omni failed calls |
|---|---|---|---|---|
| sitting | 17 | 17 | 13 | 4 |
| lying | 11 | 11 | 2 | 9 |
| standing | 5 | 5 | 1 | 4 |
| unknown (VL `unclear`) | 7 | 0 | 4 | 2 |

Omni's low count on lying and standing people is the outage, not the model: of the 20 people
it did not call `yes`, 19 fell in the failed calls (all on ZRI photos, late in the run)
and one was answered `unclear`. Of the 5 people VL left `unclear` whose calls Omni answered, Omni
said `yes` to 4.

The Nemotron VL row is `docs/evidence/verifier/val-verify-v2-20261020-165932/` (the run behind
report §5.4); the Omni row is `docs/evidence/verifier/val-verify-v2-omni-20261022-160937/`, both
CSV and JSON, read 2026-10-22.

## Conclusion

- **Nemotron-3.5-Super-VL stays as the second look.** On the crops both answered, Omni at the same
  prompt calls more of the people `yes` (20/21 against 16/21), but calls 43 of 77 false alarms a
  person against 25, almost never says `no` (2 against 12), and so has the lower `yes` precision
  (0.317 against 0.390). Its reasoning mode writes about 650 tokens per verdict and takes 10.8 s at
  the median and 33 s at p90, against 1.3 s and 1.7 s; inline per detection, that is too slow.
  On the hosted trial endpoint it also lost 72 of 170 calls: two HTTP 500s, and the circuit
  breaker's pause after each.
- With the endpoint failures counted, as a search would see them, Omni leaves 105 of 170 crops
  `unclear` (VL 65) and calls 20 of 40 people `yes` (VL 33).
- A second verifier from a different model family is still worth having, as a check on the
  first's blind spots. Cosmos is the natural candidate once a Cosmos id answers on the API; the
  harness needs only `--model`.
- Nothing else in the report changes: the run-time verifier, the rule and the test numbers in §5.4
  are as they were.

## Reproduce

Tests (mocked client, no key): `uv run pytest tests/agent/test_eval_verifier.py -q`. Then the
command under Method, with a key in `NVIDIA_API_KEY`. The outputs are
`runs/omni_verifier/val-verify-v2-nemotron-3-nano-omni-30b-a3b-reasoning-<time>.csv` and `.json`.
The per-crop comparison (agreement, posture, the 98 answered crops) is computed from the two CSVs
by joining on `photo` and `index`.
