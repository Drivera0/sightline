# Nebius × NVIDIA feedback (draft, lane A)

Draft for the Nebius "Most Valuable Feedback" form (MASTER_PLAN §8.2, LANE_A §5.8): per tool,
what we used it for, what worked, what needs work, onboarding, and whether we'd build on it again,
with numbers. Measured 2026-10-20 on Nebius Token Factory. Lane E adds `radio.md` (Parakeet,
Magpie, tool calling over voice); the Serverless Job section is filled in after A-N1.

**To fill in before submitting:** prices per million tokens for each model from the Token Factory
console (we did not want to quote prices we had not checked), and the onboarding timings below
from Dan's notes.

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

Filled in after A-N1 (Mon Oct 27): batch detection of the fleet scenario's photos, time and cost.
