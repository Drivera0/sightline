# Nebius × NVIDIA: feedback per tool

For the Nebius "Most Valuable Feedback" form. Each tool follows the judges' template: what we used it
for, what worked, what needs work, how onboarding felt (zero to hello world), and whether we would build
with it again. Token Factory numbers are from 2026-10-20; the Serverless Job numbers from 2026-10-22.
The radio desk's own measurements are in `docs/feedback/radio.md`.

**Pending from Dan** (onboarding timings that only he has; everything else below is from the repo):

1. Token Factory: sign-up → first API key, `<Dan: minutes>`
2. Token Factory: first successful chat call, `<Dan: minutes>`
3. Token Factory: first tool call that parsed, `<Dan: minutes>`
4. Serverless Jobs: `nebius` CLI install → logged in, `<Dan: minutes>`
5. Parakeet and Magpie: NeMo install → first transcript and first spoken reply, `<Dan: minutes>`
6. Builders credits: applied → credited, `<Dan: days>`, and how the process felt

**Prices** (Token Factory model catalog, https://tokenfactory.nebius.com/model-catalog.md, read
2026-10-20 and again 2026-10-22, unchanged; per million tokens, no currency stated on the page):
Nemotron-3.5-Super-VL 0.30 in / 0.90 out; Nemotron 3 Super 0.30 / 0.90; Nemotron 3 Nano 0.06 / 0.24.

**Model ids, checked against the live catalog on 2026-10-22:** `nvidia/Nemotron-3.5-Super-VL`
(us-north1), `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` (eu-north1) and `nvidia/nemotron-3-super-120b-a12b`
(us-central1) all exist verbatim. Parakeet and Magpie are not on Token Factory; we run them on our own GPU.

## 1. Token Factory: the chat completions API

**What we used it for.** Every language and vision model call in Sightline, at run time, through one
client (`sightline/agent/llm.py:23-25`): vision verdicts, briefings, conditions extraction and radio
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
  clear error for this case (`sightline/agent/llm.py:228-229`). A `reasoning_tokens` field, or a
  warning, would make it obvious.
- **Turning thinking off is not documented where you look first.**
  `extra_body={"chat_template_kwargs": {"enable_thinking": false}}` works (`llm.py:31`), but we found it
  by trial; it belongs in the model card and the quick-start.
- **Model ids differ in casing and style** (`nemotron-3-super-120b-a12b`,
  `NVIDIA-Nemotron-3-Nano-30B-A3B`, `Nemotron-3.5-Super-VL`), so we copied each from the console. A
  `GET /v1/models` listing capabilities (vision, tools, JSON schema, thinking) would let a client check
  at start-up. The catalog's JSON (`/api/public/models_info`) lists ids and prices but not capabilities.
- **Models live in different regions** (us-north1, eu-north1, us-central1, per the catalog). One base
  URL served all three for us; the catalog does not say whether region affects latency.

**Onboarding.** Zero to the first chat reply: `<Dan: minutes>` (sign-up → key), `<Dan: minutes>`
(first call). The one-line check we now give others is in `README.md:100`.

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
| Latency per call | p50 1.35 s, p90 1.65 s (max 2.19 s) | `docs/report/OPENCV_REPORT.md:357-358`; max over the 461 calls in `runs/verifier/*.csv` |
| Tokens per call | about 890 in, 67 out (mean of all 461 calls) | `docs/report/OPENCV_REPORT.md:357` |
| Cost per call (catalog prices) | about 0.00033, so about 0.33 per 1,000 uncertain detections; all 461 evaluation calls 461 × 0.00033 ≈ 0.15 | `docs/report/OPENCV_REPORT.md:358-359` |
| JSON schema compliance | 461 / 461 valid on the first try | `docs/report/OPENCV_REPORT.md:359`; `docs/architecture/agent.md:125` |
| Real people called `yes` (val, prompt v2) | 75 % of near-miss people (9 of 12), 86 % of queue people | `docs/LANE_A_ML.md:303`; run file `runs/verifier/val-verify-v2-20261020-165932.json` (local runs, not in git, named in `docs/LANE_A_ML.md` §6.8) |
| False alarms called `no` (val, prompt v2) | 17 % of near-miss false alarms, 13 % of queue ones | the same run file |
| Person boxes under 60 px (test) | 65 % answered `unclear`; 2 of 8 people called `yes` | `docs/LANE_A_ML.md:314` |
| Effect on the search (test, once) | 4 more of 337 people found (recall 0.864 → 0.875, 95 % CI [+0.003, +0.023]) for 15 more false alarms | `docs/report/OPENCV_REPORT.md:350-353` |

**What worked.** Structured output was flawless. The model follows instructions to abstain: told to
answer `unclear` when it can't tell, it does, rather than inventing. On a near-miss (detector 0.18) of a
person lying down, it answered from the native-resolution zoom correctly ("yes, lying, white top, dark
pants") where the frame crop was a blur (`docs/architecture/av-chain/trace.jsonl`, line 3).

**What needs work.**
- **Small aerial people.** Below about 60 px the model mostly abstains. Drone photos in search and rescue
  are full of 40–80 px people seen from above; this is the regime that matters.
- **Calibration between prompts.** With a neutral prompt (v1) it called many near-miss false alarms
  (rocks, bags, shadows) a person: 45 of 75 (`docs/LANE_A_ML.md:295`). A stricter prompt (v2) cut
  promoted false alarms from 45 to 24 on val but also kept 2 fewer people (`docs/LANE_A_ML.md:303`).
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
(`sightline/agent/loop.py:151`), and reading weather and park pages found by Tavily, returning each value
with the sentence it came from (`sightline/geo/conditions.py:316`).

**What worked.** All 5 live briefings passed our post-check (no "clear"/"cleared", every number in the
facts) on the first call once the prompt said "write numbers as digits, only numbers in the facts".
Conditions extraction gave the same values on two runs (`docs/report/TAVILY.md:64-65`). At 0.06 / 0.24
per million tokens it is the cheapest model we call.

**What needs work.**
- **Tool calling with thinking off:** 0 of 3 tool calls for a radio question, and once an invented answer
  ("northeast at 45 degrees, 5 kilometers") that no tool returned. With thinking on it called the tool
  (2 / 2) but took 3.1–4.5 s for the first call (`docs/feedback/radio.md:28-31`). The model card should
  say which models are reliable at tool calling with thinking off.
- **Staying with the facts.** The first briefing prompt produced invented urgency ("Move fast. Stay
  sharp.") and turned "a person seen in a photo" into "found"; asked to add "no orders", it once ended an
  alert with "No further action is needed" (`docs/architecture/agent.md:77-80`). For safety-critical
  text, a documented grounded-generation mode would save every team writing its own checker.

**Onboarding.** Same client and key as the others; the `max_tokens` surprise in §1 happened on this model.

**Would we build with it again?** Yes for short text from given facts, behind a post-check. Not for tool
calls with thinking off.

## 4. Nemotron 3 Super (`nvidia/nemotron-3-super-120b-a12b`)

**What we used it for.** The radio desk's reasoning step: a ground team's question or report goes in,
and the model answers from tools (sector boundary, assignment, conditions, clue drafts)
(`sightline/radio/turn.py:232`).

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
  everything up to the last `</think>` (`sightline/agent/llm.py:43`). Expected: no reasoning in `content`
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

**Onboarding.** CLI install → logged in: `<Dan: minutes>`. From the first `ai job create` (failed: the
`PLATFORM` clash, then the quota) to the first completed job took about 15 minutes by our logs, and the
successful job itself 11 minutes.

**Would we build with it again?** Yes for batch CPU work like this: a container, a command, logs back,
billed by the second. We would check quotas per region first.

## 6. Parakeet TDT 0.6B v2 (`nvidia/parakeet-tdt-0.6b-v2`, speech to text)

**What we used it for.** The radio desk hears ground teams: push-to-talk audio → text, on our RTX 4080
SUPER through NeMo (`sightline/radio/asr.py`). Not on Token Factory.

**Measured.** 45–130 ms per phrase for 3.9–8.7 s of audio; loads in 32 s; 6.1 GB GPU peak with Magpie
also loaded (`docs/feedback/radio.md:13`, `:17`). WER on the three spike phrases was 0.29 / 0.11 / 0.00
before normalisation, almost all of it number and word-split style (`docs/feedback/radio.md:36-40`). WER
on human volunteers' voices is not measured yet (issue #49, `docs/feedback/radio.md:137-143`).

**What worked.** Fast enough that speech to text is never the bottleneck. Word timestamps came free.
No Hugging Face token needed.

**What needs work.** It writes numbers as digits and sometimes splits words ("Team Two" → "Team 2",
"Sightline" → "Sight line"), so every voice agent needs its own normaliser. A documented
inverse-text-normalisation switch would help. NeMo pins its own Lightning and torch versions, so it needs
its own environment (`docs/feedback/radio.md:153-155`).

**Onboarding.** `uv pip install "nemo_toolkit[asr,tts]"`, then our spike script runs in about 2 minutes
and downloads about 3 GB once (`docs/feedback/radio.md:148-150`). Install → first transcript:
`<Dan: minutes>`.

**Would we build with it again?** Yes. Fast and accurate for short radio phrases on one consumer GPU.

## 7. Magpie TTS multilingual 357M (`nvidia/magpie_tts_multilingual_357m`, text to speech)

**What we used it for.** Sightline's spoken replies on the radio desk, speaker 0, on the RTX 4080 SUPER
(`sightline/radio/tts.py`). Not on Token Factory.

**Measured.** About 0.5× real time in the spike (1.8–4.8 s to generate 3.9–8.7 s of speech), about 0.66×
in later runs; loads in 57 s (`docs/feedback/radio.md:15`, `:59`). Full voice turns: TTS 4.6–10.4 s
depending on reply length, the bottleneck for a 5 s target (`docs/feedback/radio.md:57-58`). Speaking
sentence by sentence with a cached "<Callsign>, Sightline." opener brought time to first audio to
3.6–3.7 s (`docs/feedback/radio.md:60-61`), and first sound with real voices to 2.5 s p50, 3.0 s p90
(`docs/feedback/radio.md:101`).

**What worked.** Natural enough for a radio channel; chunked inference (`create_chunk_state` /
`generate_speech`) let us start playing while it generates.

**What needs work.** Speed options didn't help (CFG off and bf16 were not faster). For voice agents a
streaming API with first audio under 300 ms would matter more than raw throughput
(`docs/feedback/radio.md:59-63`).

**Onboarding.** Same NeMo install as Parakeet (§6).

**Would we build with it again?** Yes, with chunked playback from the start.

## 8. Builders credits process

**What we used it for.** Token Factory credits for development and evaluation (the 461 vision calls cost
about 0.15 at catalog prices, §2), alongside the hackathon promo code.

**How it went.** Applied → credited: `<Dan: days>`. What worked and what needs work: `<Dan: notes>`.

**Would we use it again?** `<Dan>`
