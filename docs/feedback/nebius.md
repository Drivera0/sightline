# Nebius × NVIDIA feedback (draft, lane A)

Draft for the Nebius "Most Valuable Feedback" form (MASTER_PLAN §8.2, LANE_A §5.8): per tool,
what we used it for, what worked, what needs work, onboarding, and whether we'd build on it again,
with numbers. Measured 2026-10-20 on Nebius Token Factory. Lane E adds `radio.md` (Parakeet,
Magpie, tool calling over voice). The Serverless Job section is from the A-N1 run on 2026-10-22.

**Prices** (Token Factory model catalog, https://tokenfactory.nebius.com/model-catalog.md, read
2026-10-20; per million tokens, the page states no currency): Nemotron-3.5-Super-VL 0.30 in /
0.90 out; Nemotron 3 Super 0.30 / 0.90; Nemotron 3 Nano 0.06 / 0.24.

**To fill in before submitting:** the onboarding timings below, from Dan's notes.

## Token Factory: Nemotron-3.5-Super-VL (vision verdicts)

**What we used it for.** A second look at uncertain person detections in search-and-rescue drone
photos: the detector's crop plus one or two OpenCV 5 re-look images (contrast-enhanced,
native-resolution zoom, re-detection) go in; a JSON verdict comes out (person yes/no/unclear,
posture, group size, clothing, reason). Code: `sightline/agent/verify.py`.

**Numbers** (461 live calls on HERIDAL val and test crops; thinking off; temperature 0; 2–3 images
of 256–384 px per call):

| | Value |
|---|---|
| Latency per call | p50 1.35 s, p90 1.65 s, max 2.19 s |
| Tokens per call | 886 in, 67 out on average (439 k tokens in all) |
| Cost per call (catalog prices) | about 0.00033, so about 0.33 per 1,000 uncertain detections; all 461 evaluation calls about 0.15 |
| JSON schema compliance (`response_format: json_schema`) | 461 / 461 valid on the first try |
| Real people called `yes` (val, prompt v2) | 75 % of near-miss people, 86 % of queue people |
| False alarms called `no` (val, prompt v2) | 17 % of near-miss false alarms, 13 % of queue ones |
| Crops where the person box is under 60 px (test) | 65 % answered `unclear`; 2 of 8 people called `yes` |

**What worked.** Structured output was flawless. Latency is steady enough to run inline per
detection. The model follows instructions about abstaining: told to answer `unclear` when it
can't tell, it does, rather than inventing. On a near-miss (detector 0.18) of a person lying down,
it answered from the native-resolution zoom correctly ("yes, lying, white top, dark pants") where
the frame crop was a blur (`docs/architecture/agent.md`).

**What needs work.**
- **Small aerial people.** Below about 60 px the model mostly abstains. Search-and-rescue drone
  photos are full of 40–80 px people seen from above; this is the regime that matters.
- **Calibration between prompts.** With a neutral prompt (v1) it called 60 % of near-miss false
  alarms (rocks, bags, shadows) a person; a stricter prompt (v2) cut promoted false alarms from 45
  to 24 on val but also found 2 fewer people. Confidence scores, or log-probs on the `person` field,
  would let us set an operating point instead of rewording prompts.
- **Val → test shift.** The same prompt answered `yes` for 75 % of near-miss people on val and 36 %
  on test. We can't tell from the outside whether that is the model or
  our data; per-request confidence would help here too.

## Token Factory: Nemotron 3 Nano (briefings) and Super (reasoning)

**What we used it for.** `NVIDIA-Nemotron-3-Nano-30B-A3B` writes 60-word radio briefings for
ground teams from a dict of facts (`sightline/agent/loop.py: write_briefing`); every briefing is
post-checked (no "clear"/"cleared", every number must appear in the facts) before a person
approves it. `nemotron-3-super-120b-a12b` is wired for planning text.

**Tool calling (radio spike, `docs/feedback/radio.md`).** With thinking off, Nemotron 3 Nano made
0 of 3 tool calls for a radio question and once invented an answer ("northeast at 45 degrees,
5 kilometers") that no tool returned; with thinking on it called the tool (2 / 2) but took
3.1–4.5 s for the first call. Nemotron 3 Super with thinking off was correct 3 / 3 in 1.9–3.4 s for
the tool call plus the reply. For tool use we route to Super; the model cards should say which
models are reliable at tool calling with thinking off.

**Reasoning leaking into the reply.** With thinking off (`chat_template_kwargs.enable_thinking=false`),
Nemotron 3 Super sometimes wrote its reasoning into `content` after a tool call: "Now respond per
rules, start with callsign then Sightline … Keep brief.`</think>`Team Two, Sightline. Sector …". Our
radio spoke it aloud before we noticed (`docs/feedback/radio.md`). We now drop everything up to the last
`</think>` in our client (`sightline/agent/llm.py: strip_reasoning`). Expected: with thinking off, no
reasoning in `content`; or reasoning always in `reasoning_content`, never mixed into the answer.

**What worked.** All 5 live briefings passed the post-check on the first call, and with
the instruction "write numbers as digits, only numbers in the facts" it kept to the facts.

**What needs work.** The first prompt produced invented urgency ("Move fast. Stay sharp.",
"Immediate response needed") and turned "a person seen in a photo" into "found". For safety-critical
text, a documented way to keep the model to the given facts (or a grounded-generation mode) would
save every team writing their own checker.

## Token Factory: onboarding and API behaviour

- **Thinking tokens count against `max_tokens`, silently.** Our first smoke test asked for a
  2-word reply with `max_tokens` of 20–60 and got **empty content** with `finish_reason: length`:
  the model had spent the budget thinking. Nothing in the response says that is what happened. We
  now default to 2048 and raise a clear error when the reply is empty for this reason
  (`sightline/agent/llm.py`). A response field such as `reasoning_tokens`, or a warning, would make
  this obvious.
- **Turning thinking off is not obvious.** `extra_body={"chat_template_kwargs": {"enable_thinking":
  false}}` works on Token Factory, but we found it by trial; it should be in the model card and the
  quick-start.
- **Model ids.** The ids we use (`nvidia/nemotron-3-super-120b-a12b`,
  `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`, `nvidia/Nemotron-3.5-Super-VL`) differ in casing and
  naming style; we had to copy each from the console. A `GET /v1/models` that lists capabilities
  (vision, tools, JSON schema, thinking) would let clients check at start-up.
- **OpenAI compatibility.** The `openai` SDK worked unchanged (base URL + key), including images
  as data URIs, `response_format` JSON schema, and tool calls with ids.

## Would we build on it again?

Yes for structured vision verdicts and short grounded text: reliable output format, steady
latency, simple integration. For tiny objects in aerial imagery, not yet as the deciding signal; we
use it as advice that a person approves, which is how Sightline treats every model output anyway.

## Serverless Jobs

**What we used it for.** Batch person detection over a simulated drone fleet's photos ("process sensor
data at scale"): the 711 photos of the creek scenario (crops of HERIDAL validation photos at simulated
poses), run through the Sightline detector on OpenCV 5 `cv2.dnn` on CPU, no GPU and no torch. One
container image with the photos inside; the results come back through the job's logs. Code:
`deploy/nebius/run_job.sh`, `scripts/nebius_batch_detect.py`.

**Numbers** (2026-10-22, us-north1, `cpu-d3` / `16vcpu-64gb`, 2.09 GB image in Container Registry):

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
- **Quota surprise:** the tenant's home region (eu-north1) and us-central1 have a **0 vCPU quota for CPU VMs**,
  while other regions have 200. The job failed with `ResourceExhausted … compute.instance.non-gpu.vcpu`;
  nothing in the console's first run or the CLI's defaults hints at it. A default project in the home region
  that can't run a CPU job is a trap; a hint naming a region with quota would save the guess.
- **CLI onboarding:** `nebius profile create` prompts interactively and fails with `Error: ^D` when stdin is not
  a terminal (it ran inside a tool that captures output); `--no-browser` plus explicit flags worked. A profile
  without `--parent-id` then makes `nebius iam project list` fail with `'' is invalid for parentId` instead of
  listing the projects the user can pick from.
- **Deprecations mid-onboarding:** `iam project` and `iam tenant` print deprecation warnings pointing to
  `iam v2`, so the commands in older guides already warn.
- **No CPU example in the Serverless Jobs docs:** every example is a GPU job; whether `cpu-d3` presets work for
  jobs had to be inferred from the Compute docs (they do).
- **Registry cleanup:** deleting an image failed the first time without a message we could act on; on retry
  it worked, and the registry can only be deleted once empty.
- Small: `PLATFORM` is a common environment variable (WSL sets `PLATFORM=WSL`), so our script's own
  `PLATFORM` default picked it up and the API answered `Platform "WSL" was not found`; our bug, but an
  error listing the valid platforms would have shortened it.

**Onboarding time:** from the first `ai job create` (failed: the `PLATFORM` clash, then the quota) to the first
completed job took about 15 minutes by our logs, and the successful job itself 11 minutes. Add the time from CLI
install to login from Dan's notes.

**Would we build on it again?** Yes for batch CPU work like this: a container, a command, logs back, billed by
the second. We would check quotas per region first.
