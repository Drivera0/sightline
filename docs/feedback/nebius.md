# Nebius × NVIDIA: feedback per tool

For the Nebius "Most Valuable Feedback" form. Each tool follows the judges' template: what we used it
for, what worked, what needs work, how onboarding felt (zero to hello world), and whether we would build
with it again. Token Factory numbers are from 2026-10-20; the Serverless Job and Serverless Endpoint
numbers from 2026-10-22. The radio desk's own measurements are in `docs/feedback/radio.md`.

**Onboarding timings** (items 2–5 and 7 read from our session logs and `git log`; items 1 and 6 from memory):

1. Token Factory: sign-up → first API key, 10 hours
2. Token Factory: key in the shell → first successful chat call, about 3 minutes (2026-10-20 13:29 → 13:32 PDT, session log)
3. Token Factory: key → first tool call that parsed, about 2.5 hours (13:29 → 15:58 PDT, `git log`), almost all of it writing the client; the one model-side snag was replies that came back empty after the model spent the token budget thinking, fixed by turning thinking off (`extra_body`)
4. Serverless Jobs: `nebius` CLI install → logged in, about 2 minutes (2026-10-21 21:14 → 21:16 PDT), after one failed try because `profile create` only works interactively
5. Parakeet and Magpie: start of the spike → first transcript and first spoken reply, about 75 minutes (2026-10-20 18:30 → 19:45 PDT), including the NeMo environment build and the 3 GB download
6. Builders credits: applied → credited, under a day; the process was straightforward
7. Serverless Endpoints: start (docs, CLI help) → first detection from our endpoint, about 14 minutes including our app code and image build (2026-10-22 17:37 → 17:50:44 UTC, `docs/evidence/nebius_endpoint/20261022-1747/commands.log`), 5 of them the create itself

**Prices** (Token Factory model catalog, https://tokenfactory.nebius.com/model-catalog.md, read
2026-10-20 and again 2026-10-22, unchanged; per million tokens, no currency stated on the page):
Nemotron-3.5-Super-VL 0.30 in / 0.90 out; Nemotron 3 Super 0.30 / 0.90; Nemotron 3 Nano 0.06 / 0.24.

**Model ids, checked against the live catalog on 2026-10-22:** `nvidia/Nemotron-3.5-Super-VL`
(us-north1), `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` (eu-north1) and `nvidia/nemotron-3-super-120b-a12b`
(us-central1) all exist verbatim. Parakeet and Magpie are not on Token Factory; we run them on our own GPU.

## 1. Token Factory: the chat completions API

**What we used it for.** Every language and vision model call in Sightline, at run time, through one
client (`sightline/agent/llm.py:224`): vision verdicts, briefings, conditions extraction and radio
turns with tool calls.

**What worked.**
- The `openai` SDK worked unchanged (base URL + key), including images as data URIs, `response_format`
  with a JSON schema, and tool calls with ids.
- Structured output: 461 of 461 vision replies were valid JSON on the first try (§2).
- Latency steady enough to call inline per detection: p50 1.35 s, p90 1.65 s for a vision verdict (§2).

**What needs work.**
- **Thinking tokens count against `max_tokens`, silently.** Our first smoke test asked for a 2-word
  reply with `max_tokens` of 20–60 and got **empty content** with `finish_reason: length`: the model had
  spent the budget thinking, and nothing in the response says so. We now default to 2048 and raise a
  clear error for this case (`sightline/agent/llm.py:347`). A `reasoning_tokens` field, or a
  warning, would make it obvious.
- **Turning thinking off is not documented where you look first.**
  `extra_body={"chat_template_kwargs": {"enable_thinking": false}}` works (`llm.py:56`), but we found it
  by trial; it belongs in the model card and the quick-start.
- **Model ids differ in casing and style** (`nemotron-3-super-120b-a12b`,
  `NVIDIA-Nemotron-3-Nano-30B-A3B`, `Nemotron-3.5-Super-VL`), so we copied each from the console. A
  `GET /v1/models` listing capabilities (vision, tools, JSON schema, thinking) would let a client check
  at start-up. The catalog's JSON (`/api/public/models_info`) lists ids and prices but not capabilities.
- **Models live in different regions** (us-north1, eu-north1, us-central1, per the catalog). One base
  URL served all three for us; the catalog does not say whether region affects latency.

**Onboarding.** Zero to the first chat reply: about 10 hours (sign-up → key, waiting on the
account) then about 3 minutes (key → first call, 2026-10-20 13:29 → 13:32 PDT by our session log). The
first tool call that parsed came 2.5 hours after the key, nearly all of it our own client code. The one-line check we now give others is in `README.md:124`.

**Would we build with it again?** Yes. One OpenAI-compatible client for vision, text and tools, with
reliable structured output, is what let a small team wire five jobs to NVIDIA models in a week.

## 2. Nemotron-3.5-Super-VL (`nvidia/Nemotron-3.5-Super-VL`)

**What we used it for.** A second look at uncertain person detections in drone photos: the detector's
crop plus one or two OpenCV 5 re-look images (contrast-enhanced, native-resolution zoom, re-detection)
go in; a JSON verdict comes out (person yes/no/unclear, posture, group size, clothing, reason). Code:
`sightline/agent/verify.py`.

**Measured** (461 live calls on HERIDAL val and test crops; thinking off; temperature 0; 2–3 images of
256–384 px per call):

| | Value | Source |
|---|---|---|
| Latency per call | p50 1.35 s, p90 1.65 s (max 2.19 s) | `docs/report/OPENCV_REPORT.md:542-543`; max over the 461 calls in the three Nemotron VL runs' CSVs in `docs/evidence/verifier/` (the three `*-20261020-*` folders; not the Omni folder, §10) |
| Tokens per call | about 890 in, 67 out (mean of all 461 calls) | `docs/report/OPENCV_REPORT.md:542` |
| Cost per call (catalog prices) | about 0.00033, so about 0.33 per 1,000 uncertain detections; all 461 evaluation calls 461 × 0.00033 ≈ 0.15 | `docs/report/OPENCV_REPORT.md:543-544` |
| JSON schema compliance | 461 / 461 valid on the first try | `docs/report/OPENCV_REPORT.md:544`; `docs/architecture/agent.md:339-340` |
| Real people called `yes` (val, prompt v2) | 75 % of near-miss people (9 of 12), 86 % of queue people | `docs/LANE_A_ML.md:304`; run file `docs/evidence/verifier/val-verify-v2-20261020-165932/val-verify-v2-20261020-165932.json` |
| False alarms called `no` (val, prompt v2) | 17 % of near-miss false alarms, 13 % of queue ones | the same run file |
| Person boxes under 60 px (test) | 65 % answered `unclear`; 2 of 8 people called `yes` | `docs/LANE_A_ML.md:314` |
| Effect on the search (test, once) | 4 more of 337 people found (recall 0.864 → 0.875, 95 % CI [+0.003, +0.023]) for 15 more false alarms | `docs/report/OPENCV_REPORT.md:537-538` |

**What worked.** Structured output was flawless. The model follows instructions to abstain: told to
answer `unclear` when it can't tell, it does, rather than inventing. On a near-miss (detector 0.18) of a
person lying down, it answered from the native-resolution zoom correctly ("yes, lying, white top, dark
pants") where the frame crop was a blur (`docs/architecture/av-chain/trace.jsonl`, line 3).

**What needs work.**
- **Small aerial people.** Below about 60 px the model mostly abstains. Drone photos in search and rescue
  are full of 40–80 px people seen from above; this is the regime that matters.
- **Calibration between prompts.** With a neutral prompt (v1) it called many near-miss false alarms
  (rocks, bags, shadows) a person: 45 of 75 (`docs/LANE_A_ML.md:295`). A stricter prompt (v2) cut
  promoted false alarms from 45 to 24 on val but also kept 2 fewer people (`docs/LANE_A_ML.md:304`).
  Confidence scores, or log-probs on the `person` field, would let us set an operating point instead of
  rewording prompts.
- **Val → test shift.** The same prompt answered `yes` for 75 % of near-miss people on val and 36 % on
  test (`docs/LANE_A_ML.md:314`). From the outside we can't tell whether that is the model or our data;
  per-request confidence would help here too.

**Onboarding.** Images as data URIs and `response_format: json_schema` worked on the first call in the
same client as the text models; no vision-specific setup.

**Would we build with it again?** Yes for structured visual verdicts. For tiny objects in aerial imagery,
not yet as the deciding signal; we use it as advice that a person approves.

## 3. Nemotron 3 Nano (`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`)

**What we used it for.** 60-word radio briefings for ground teams from a dict of facts
(`sightline/agent/loop.py:155`), and reading weather and park pages found by Tavily, returning each value
with the sentence it came from (`sightline/geo/conditions.py:338`).

**What worked.** All 5 live briefings passed our post-check (no "clear"/"cleared", every number in the
facts) on the first call once the prompt said "write numbers as digits, only numbers in the facts".
Conditions extraction gave the same values on two runs (`docs/report/TAVILY.md:66`). At 0.06 / 0.24
per million tokens it is the cheapest model we call.

**What needs work.**
- **Tool calling with thinking off:** 0 of 3 tool calls for a radio question, and once an invented answer
  ("northeast at 45 degrees, 5 kilometers") that no tool returned. With thinking on it called the tool
  (2 / 2) but took 3.1–4.5 s for the first call (`docs/feedback/radio.md:28-31`). The model card should
  say which models are reliable at tool calling with thinking off.
- **Staying with the facts.** The first briefing prompt produced invented urgency ("Move fast. Stay
  sharp.") and turned "a person seen in a photo" into "found"; asked to add "no orders", it once ended an
  alert with "No further action is needed" (`docs/architecture/agent.md:199-202`). For safety-critical
  text, a documented grounded-generation mode would save every team writing its own checker.

**Onboarding.** Same client and key as the others; the `max_tokens` surprise in §1 happened on this model.

**Would we build with it again?** Yes for short text from given facts, behind a post-check. Not for tool
calls with thinking off.

## 4. Nemotron 3 Super (`nvidia/nemotron-3-super-120b-a12b`)

**What we used it for.** The radio desk's reasoning step: a ground team's question or report goes in,
and the model answers from tools (sector boundary, assignment, conditions, clue drafts)
(`sightline/radio/turn.py:219`).

**Measured.**

| | Value | Source |
|---|---|---|
| Tool calls, spike, thinking off | 3 / 3 correct, 1.9–3.4 s for the tool call plus the reply | `docs/feedback/radio.md:14` |
| Model time over 30 live turns | p50 2.3 s, p90 3.2 s | `docs/feedback/radio.md:84` |
| Clue reports over 30 turns, after code guards | 6 / 6 drafted, read back, committed | `docs/feedback/radio.md:84` |
| Conditions questions over 30 turns, after code guards | 6 / 6 answered from the tool | `docs/feedback/radio.md:84` |

**What worked.** With thinking off it called tools correctly where Nano didn't, and faster than Nano with
thinking on (`docs/feedback/radio.md:28-31`).

**What needs work.**
- **Reasoning leaked into the reply** with thinking off: "Now respond per rules … Keep brief.`</think>`
  Team Two, Sightline…", and our radio spoke it aloud (`docs/feedback/radio.md:115-120`). We strip
  everything up to the last `</think>` (`sightline/agent/llm.py:79`). Expected: no reasoning in `content`
  with thinking off, or reasoning always in `reasoning_content`.
- **Describing a tool call instead of making it** ("calling get_sector_boundary…"), **claiming a clue was
  drafted without calling `draft_clue`** (3 of 6 reports late in a conversation), and **invented weather**
  without calling `get_conditions` (`docs/feedback/radio.md:54-55`, `:70-79`). All are now enforced in code.
  A `tool_choice: required` that the model honours would remove most of these guards.

**Onboarding.** No extra setup beyond §1; tool calls with ids worked through the `openai` SDK.

**Would we build with it again?** Yes for tool use, with code-side guards on anything safety-relevant.

## 5. Serverless Jobs

**What we used it for.** Batch person detection over a simulated drone fleet's photos ("process sensor
data at scale"): the 711 photos of the creek scenario (crops of HERIDAL validation photos at simulated
poses), run through the Sightline detector on OpenCV 5 `cv2.dnn` on CPU, no GPU and no torch. One
container image with the photos inside; the results come back through the job's logs. Code:
`deploy/nebius/run_job.sh`, `scripts/nebius_batch_detect.py`.

**Measured** (2026-10-22, us-north1, `cpu-d3` / `16vcpu-64gb`, 2.09 GB image in Container Registry):

| | Value |
|---|---|
| Detection inside the job | 711 photos in 483 s, 0.68 s per photo on 16 vCPUs |
| `ai job create` → `COMPLETED` | 677 s, so about 3 min of VM start and image pull before the first photo |
| Result | 180 boxes, one candidate (f0665 at 0.735): the same output as the same image under local Docker (32 CPUs, 0.47 s/photo), and the photo over the scenario's hidden person |
| Cost (list prices, our estimate) | 16 × $0.015 + 64 × $0.0045 = $0.53 per hour for the VM; 677 s ≈ **$0.10**, plus the 50 GiB disk for those minutes (< $0.01) and the image in the registry |

**What worked.** Once logged in, `nebius ai job create` with an image from a registry in the same project
needed no registry credentials, and `nebius ai job logs` gave the whole stdout back, which was enough to
return results without a bucket. The VM is deleted on completion, so nothing keeps billing. Per-second
billing makes short batch jobs cheap even with the 1 h minimum timeout setting.

**What needs work.**
- **Quota surprise:** the tenant's home region (eu-north1) and us-central1 have a **0 vCPU quota for CPU
  VMs**, while other regions have 200. The job failed with `ResourceExhausted … compute.instance.non-gpu.vcpu`;
  nothing in the console's first run or the CLI's defaults hints at it. A default project in the home region
  that can't run a CPU job is a trap; a hint naming a region with quota would save the guess.
- **CLI onboarding:** `nebius profile create` prompts interactively and fails with `Error: ^D` when stdin is
  not a terminal (it ran inside a tool that captures output); `--no-browser` plus explicit flags worked. A
  profile without `--parent-id` then makes `nebius iam project list` fail with `'' is invalid for parentId`
  instead of listing the projects the user can pick from.
- **Deprecations mid-onboarding:** `iam project` and `iam tenant` print deprecation warnings pointing to
  `iam v2`, so the commands in older guides already warn.
- **No CPU example in the Serverless Jobs docs:** every example is a GPU job; whether `cpu-d3` presets work
  for jobs had to be inferred from the Compute docs (they do).
- **Registry cleanup:** deleting an image failed the first time without a message we could act on; on
  retry it worked, and the registry can only be deleted once empty.
- Small: `PLATFORM` is a common environment variable (WSL sets `PLATFORM=WSL`), so our script's own
  `PLATFORM` default picked it up and the API answered `Platform "WSL" was not found`; our bug, but an
  error listing the valid platforms would have shortened it.

**Onboarding.** CLI install → logged in: about 2 minutes (2026-10-21 21:14 → 21:16 PDT), after one
failed try because `profile create` only works interactively. From the first `ai job create` (failed: the
`PLATFORM` clash, then the quota) to the first completed job took about 15 minutes by our logs, and the
successful job itself 11 minutes.

**Would we build with it again?** Yes for batch CPU work like this: a container, a command, logs back,
billed by the second. We would check quotas per region first.

## 6. Serverless Endpoints

**What we used it for.** The Sightline person detector served on demand: one drone photo in over HTTPS,
boxes out, on a CPU endpoint (OpenCV 5 `cv2.dnn`, no GPU, no torch). The mission worker sends detection
there when `SIGHTLINE_DETECT_URL` is set, so a field laptop or a small API box can hand detection to
Nebius. Code: `sightline/serve/detect_app.py`, `sightline/ml/remote.py`, `deploy/nebius/ENDPOINT.md`.

**Measured** (2026-10-22, us-north1, `cpu-d3` / `8vcpu-32gb`, token auth; client on our dev machine, so wall
times include upload; run files in `docs/evidence/nebius_endpoint/20261022-1747/`):

| | Value |
|---|---|
| Cold start: `ai endpoint create` → first detection | 291.5 s (create returned at 290.3 s, healthy at 291.2 s) |
| Cold start after `stop` → `start` | 272.9 s to the first detection; the logs show the image downloaded again |
| Warm, 50 full HERIDAL test photos (4000×3000) one at a time | p50 5.68 s, p90 5.80 s wall; 5.10 s of it detection in the container |
| Warm, 50 fleet photos (912×684 to 2667×2000) | p50 0.72 s, p90 3.45 s wall (189 ms detection at 912×684, 3.06 s at 2667×2000) |
| 4 concurrent | 0.193 full photos/s, 0.82 fleet photos/s: little over one at a time, since `cv2.dnn` already uses all 8 vCPUs |
| Cost per 1,000 photos (list price $0.264/h while running, best throughput) | **$0.38** full photos, **$0.089** fleet photos; the whole session (23 min) about $0.10 |
| Same output as the batch job | f0665: same box, 0.735, the one candidate |

**What worked.** A CPU endpoint worked from our own image with no GPU and no code change beyond a FastAPI
app: `--platform cpu-d3` was accepted though every example uses a GPU. `--dry-run` validated the whole
request in seconds before we spent five minutes on a create. The managed `https://` URL with bearer-token
auth meant no public IP, TLS or auth code on our side, and unauthenticated calls got 401. The image pull
from a registry in the same project needed no credentials, and the push took 5 s because the image shares
layers with our batch-job image. `stop` kept the URL, so the worker's configuration survived a stop and
start. `nebius ai endpoint logs` showed both our uvicorn log and the platform's start-up steps.

**What needs work.**
- **The token is printed in plain text.** `create` echoes `Token: <value>` even when we passed it in, and
  `stop` and `start` print the endpoint YAML with `spec.auth_token`. In CI logs or shared terminals that
  leaks the secret; we filtered it out of our logs ourselves. Mask it, or print it only once when the CLI
  generated it.
- **No scale to zero.** An endpoint bills like a VM while it runs. For photos that arrive in bursts during
  a search, scale to zero with a request-triggered start would make the endpoint the default; today a
  `stop` → `start` takes 4.5 minutes because the image is downloaded again, too slow for a first photo.
  Even a cached image on restart would help.
- **Health checks need the token.** The platform puts `/healthz` behind the same bearer token, so an
  external uptime check needs the secret. An option to leave one path open would help.
- **CPU endpoints are undocumented in practice.** The deploy tutorial and every example are GPU (vLLM on
  L40S), and `--platform` defaults to an H100/H200 platform; the manage page mentions CPU-only endpoints
  only for the minimum disk size. One CPU example would have saved the guess, as with Jobs (§5).
- Small: `delete $ENDPOINT_ID` in the tutorial versus `--id` required in the CLI help; `start` returned
  with `state: STARTING` while its instance already said RUNNING; while stopped the URL answers 404, which
  a client can't tell from a wrong path.

**Onboarding.** From starting (17:37 UTC: the docs and the CLI help) to the first detection from the
endpoint (17:50:44 UTC): **about 14 minutes**, including writing the FastAPI app and building the image;
5 of them were the create itself. The CLI profile and registry already existed
from the Serverless Job (§5); a new user would add the 2 minutes of CLI setup there.

**Would we build with it again?** Yes for an always-on detector during an active search, where 5 s per
full photo for $0.264 an hour is cheap. For the bursty, mostly idle case we would keep the batch job until
endpoints scale to zero.

## 7. Parakeet TDT 0.6B v2 (`nvidia/parakeet-tdt-0.6b-v2`, speech to text)

**What we used it for.** The radio desk hears ground teams: push-to-talk audio → text, on our RTX 4080
SUPER through NeMo (`sightline/radio/asr.py`). Not on Token Factory.

**Measured.** 45–130 ms per phrase for 3.9–8.7 s of audio; loads in 32 s; 6.1 GB GPU peak with Magpie
also loaded (`docs/feedback/radio.md:13`, `:17`). WER on the three spike phrases was 0.29 / 0.11 / 0.00
before normalisation, almost all of it number and word-split style (`docs/feedback/radio.md:36-40`). On
the 20 radio test phrases read by one human voice (162 words, direct microphone), WER after our
normaliser was **0.086**, with both spoken coordinates wrong; with the "niner" fix below it is **0.025**
and 2 / 2 coordinates are exact (`docs/feedback/radio.md:190-207`; `docs/evidence/radio_wer/`).
Two more voices are still to record (issue #49).

**What worked.** Fast enough that speech to text is never the bottleneck. Word timestamps came free.
No Hugging Face token needed.

**What needs work.** It writes numbers as digits and sometimes splits words ("Team Two" → "Team 2",
"Sightline" → "Sight line"), so every voice agent needs its own normaliser. A documented
inverse-text-normalisation switch would help. **It does not know the ICAO / radio word "niner"**: "four
niner point three eight one" came out as "49er.381", "one two two point niner four zero" as
"122.9er40", and "point niner three six" as "point nine or three six". Every coordinate error in our
WER set was this one word. We normalise it in code (`sightline/radio/protocol.py`, `normalize`), but a
radio-vocabulary hint or custom vocabulary (word boosting for "niner", "affirmative", "say again") at
inference time should fix it upstream for every SAR, aviation or marine voice agent. NeMo pins its own
Lightning and torch versions, so it needs its own environment (`docs/feedback/radio.md:175-176`).

**Onboarding.** `uv pip install "nemo_toolkit[asr,tts]"`, then our spike script runs in about 2 minutes
and downloads about 3 GB once (`docs/feedback/radio.md:172`). Start of the spike → first transcript and first spoken reply: about 75 minutes (2026-10-20
18:30 → 19:45 PDT), including the environment build and the one-time download.

**Would we build with it again?** Yes. Fast and accurate for short radio phrases on one consumer GPU.

## 8. Magpie TTS multilingual 357M (`nvidia/magpie_tts_multilingual_357m`, text to speech)

**What we used it for.** Sightline's spoken replies on the radio desk, speaker 0, on the RTX 4080 SUPER
(`sightline/radio/tts.py`). Not on Token Factory.

**Measured.** About 0.5× real time in the spike (1.8–4.8 s to generate 3.9–8.7 s of speech), about 0.66×
in later runs; loads in 57 s (`docs/feedback/radio.md:15`, `:59`). Full voice turns: TTS 4.6–10.4 s
depending on reply length, the bottleneck for a 5 s target (`docs/feedback/radio.md:58`). Speaking
sentence by sentence with a cached "<Callsign>, Sightline." opener brought time to first audio to
3.6–3.7 s (`docs/feedback/radio.md:60-61`), and first sound with spoken replies (team lines typed) to 2.5 s p50, 3.0 s p90
(`docs/feedback/radio.md:101`).

**What worked.** Natural enough for a radio channel; chunked inference (`create_chunk_state` /
`generate_speech`) let us start playing while it generates.

**What needs work.** Speed options didn't help (CFG off and bf16 were not faster). For voice agents a
streaming API with first audio under 300 ms would matter more than raw throughput
(`docs/feedback/radio.md:59-63`).

**Onboarding.** Same NeMo install as Parakeet (§7).

**Would we build with it again?** Yes, with chunked playback from the start.

## 9. Builders credits process

**What we used it for.** Token Factory credits for development and evaluation (the 461 vision calls cost
about 0.15 at catalog prices, §2), alongside the hackathon promo code.

**How it went.** Applied → credited: under a day. The form was short and the credit appeared without a
follow-up; nothing to change. One ask: a note on the credits page saying which services and regions the
credit covers, so a first job is not planned in a region with no quota (§5).

**Would we use it again?** Yes.

## 10. NVIDIA hosted API (build.nvidia.com): a second verifier

**What we used it for.** An evaluation-only test of a second vision model for the second look (§2), on
`https://integrate.api.nvidia.com/v1` with a free trial key: the same 170 val near-miss crops (40 real
people, 130 false alarms), the same prompt and JSON schema, `--workers 1 --min-interval 1.6`. Nothing at
run time uses this endpoint. Write-up: `docs/report/COSMOS_VERIFIER.md`; run files in
`docs/evidence/verifier/val-verify-v2-omni-20261022-160937/`.

**Measured** (2026-10-22):

| | Value |
|---|---|
| Cosmos Reason (`nvidia/cosmos-reason2-8b`) | listed by `GET /v1/models`, but every chat completion returns HTTP 404 "Function … not found for account" |
| `nvidia/cosmos3-nano-reasoner`, `nvidia/cosmos-reason1-7b`, `nvidia/vila` | HTTP 404 |
| `nvidia/nemotron-nano-12b-v2-vl` | HTTP 410, end of life 2026-08-26 |
| Nemotron 3 Nano Omni (`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`), the model we ran instead | 98 of 170 calls answered; 2 HTTP 500s, after which our client's circuit breaker skipped 70 crops |
| Omni on the 98 answered crops, against Nemotron-3.5-Super-VL on the same crops | people called `yes` 20/21 (VL 16/21); false alarms called `yes` 43/77 (VL 25/77), `no` 2/77 (VL 12/77); `yes` precision 0.317 (VL 0.390) |
| Omni model time and tokens per verdict (answered calls, reasoning on) | p50 10.8 s, p90 33.0 s; about 930 in, 650 out (VL: 1.3 s, 1.7 s; 920 in, 68 out) |

**What worked.** The same `openai` client and the same `verify()` call ran unchanged against a second
endpoint with only `--base-url` and `--model`; images as data URIs and the strict JSON schema were accepted,
and every answered reply was valid JSON on the first try. Omni, in reasoning mode, called `yes` on 4 of the
5 answered people VL had left `unclear`.

**What needs work.**
- **The catalogue and the live service disagree.** `GET /v1/models` lists `nvidia/cosmos-reason2-8b`,
  and the build.nvidia.com page for it shows Cosmos3 Nano Reasoner, yet the id returns 404 for a trial
  account and no Cosmos3 id answers. A client that checks the models list at start-up, as we suggest
  for Token Factory (§1), would still pick a model that cannot be called.
- **No deprecation signal.** Nothing in `/v1/models` marks a model as retired or not available to the
  account; we found out per id, by calling it. The 410 for `nemotron-nano-12b-v2-vl` named the end-of-life
  date, which is the right answer; a 404 "Function … not found for account" for a listed model is not.
  A `deprecated` / `end_of_life` field, or dropping retired ids from the listing, would fix it.
- **The trial rate limit is not stated where you call the API.** We kept to 37.5 requests a minute
  because 40 a minute is the limit trial users report on NVIDIA's developer forum, where a moderator says
  it depends on the model and current load
  (https://forums.developer.nvidia.com/t/request-for-nvidia-build-api-rate-limit-increase-40-rpm-200-rpm/378450,
  read 2026-10-22); we did not find the number in the API reference or the terms. A rate-limit header on
  each reply would let a client pace itself.
- **Trial reliability.** Two HTTP 500s in 98 calls at 37.5 requests a minute, each lasting long enough that
  three retries (1, 2, 4 s) failed. Fine for an evaluation, not for an inline check during a search.

**Onboarding.** A free key and the OpenAI-compatible base URL were all our existing client needed. Most
of the time went into finding a vision model that still answers.

**Would we build with it again?** For evaluation, yes: it is the easiest way to try an NVIDIA model that
is not on Token Factory. Cosmos is still the second verifier we want, once an id answers;
Nemotron-3.5-Super-VL on Token Factory stays as the second look.
