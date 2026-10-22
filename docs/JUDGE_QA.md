# Judge Q&A: the twelve questions we expect, answered from the repo

Short, honest answers to the live questions a hostile judge is likely to ask, each with its evidence.
Where the honest answer is "we don't know yet", it says so and names what would settle it. Line numbers
are as of `main` at #124 plus this branch.

### 1. Why is the hero button "Start a new search" if the public site can't start one? What do I see at 10 pm when the EC2 box is stopped?

Today the public build has no API address baked in, so "Start a new search" shows "Live missions aren't
available here" with a developer-facing line about `VITE_API_URL`, followed by two links that do work:
the demo search and the command view on a demo mission (`web/src/App.tsx:35-45`). The demo mission needs
no server (`web/src/App.tsx:31-33`). The AWS API is stopped between demos to save cost
(`README.md:180-181`), so at 10 pm a live mission is not available unless it was started. What would fix
it: build the site with the API address, replace the developer line with a plain "the live server is off
between demos" message, and keep the instance running through judging (a decision for Dan).

### 2. Where in the product can I see the perception → decision → action trace for the proposal I just approved?

Not in the web app yet. Every tool call, model call, verdict, proposal and decision is written to the
mission's `trace.jsonl` (`sightline/mission/store.py:612`), and the debrief reads it
(`sightline/api/missions.py:345-355`), but there is no trace route or tab: the routes are
`sightline/api/missions.py:193-505`, and `TraceEntry` exists only as a type in `web/src/contract.ts`.
Today the trace is shown in the docs (`docs/architecture/agent.md`, the trace table) and printed by
`scripts/trace_excerpt.py`. A `GET /missions/{id}/trace` route and a Trace tab would resolve it.

### 3. The second look costs 15 false alarms for 4 finds and doesn't move F2. Why keep it? What operating point would a SAR manager choose?

Because a missed person costs more than a false alarm, which is why the threshold itself was chosen by
F2 (`docs/report/OPENCV_REPORT.md:335-336`). The 15 extra false alarms are spread over 101 test photos
(the review queue grows from 363 to 382 items, `docs/LANE_A_ML.md:310-311`), and each is a proposal a
person dismisses, never an automatic action. The recall gain is small but its 95 % CI excludes zero
([+0.003, +0.023], `docs/report/OPENCV_REPORT.md:352-353`). Which operating point a SAR manager would
pick, we don't know: no search manager has reviewed it. A 30-minute read by a BC SAR volunteer would
answer it.

### 4. Two model choices saw test scores. What's your best estimate of true test recall?

We don't have an untouched number. The disclosure is in `README.md:56` and
`docs/report/OPENCV_REPORT.md:505-507`. Two bounds from the repo: validation recall at the same
threshold is 0.859 (`docs/report/OPENCV_REPORT.md:144-145`), and on the four test sites the model has
never seen it is 0.825 against 0.883 on trained sites (`docs/DETECTOR_LIMITS.md:113-118`). Our honest
estimate for new terrain is nearer 0.825 than 0.864. Scoring once on a new held-out set (for example
SARD) would settle it.

### 5. With a flat prior the planner equals a serpentine. When in a real search is there a clue early enough to matter?

Agreed on the first part: on a flat prior the planner finds the person within 30 minutes in 6.9 % of
trials against 6.8 % for a fixed order (`docs/report/OPENCV_REPORT.md:395-396`, `:400-402`). With a clue
at the start it is 10.7 % against 6.3 % (`:397-398`). We only evaluated a clue at the start; how early
real clues arrive we have not measured. Running `scripts/planner_eval.py` with the clue at 30 and 60
minutes, and with a cited lost-person prior in place of the placeholder (`:465-468`), would answer it.

### 6. What is physical about this entry? Have you flown a real drone photo through the live API end to end?

A real drone photo, yes: one full 4000×3000 HERIDAL photo (taken by a real drone) uploaded through the
AWS API, 7.1 s from upload to processed on the default instance
(`docs/report/OPENCV_REPORT.md:299-304`). Our own drone, no: the fleet, its flight and the photos'
poses are simulated and labelled (`docs/report/OPENCV_REPORT.md:466-467`). What is physical is the
loop: drone photos change the map, the map re-tasks a drone and a team, and a person approves each move
(`docs/architecture/agent.md`, second chain). A flight with a DJI drone over a volunteer would settle it.

### 7. Does `nvidia/Nemotron-3.5-Super-VL` exist on Token Factory today? What happens to a mission if Token Factory is down?

Yes. Checked against the live catalog on 2026-10-22: `nvidia/Nemotron-3.5-Super-VL` (us-north1),
`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` and `nvidia/nemotron-3-super-120b-a12b` are all listed verbatim
(`docs/feedback/nebius.md:21-23`). If Token Factory is down, detection and the map carry on (they run on
our own CPU), the second look returns `unclear` naming the error and makes no proposal, planner proposals
continue with template briefings (`docs/architecture/agent.md:221-224`), and the radio answers "say
again" and changes nothing (`docs/report/OPENCV_REPORT.md:462-463`).

### 8. HERIDAL's original terms: may the imagery be shown on a public site?

We use the VOC-format copy by Pyrrö (2021), which is published under CC BY 3.0, and we attribute it
(`README.md:201`, `:205`). We have not cited the original HERIDAL release's own terms page, so we don't
know yet whether it adds conditions. Citing the original release page (or asking its authors) would
resolve it.

### 9. AGPL + ONNX weights: can North Shore Rescue deploy on a Jetson without open-sourcing their stack?

Our code is AGPL-3.0 to match Ultralytics, which the detector is trained with (`README.md:205`), and we
treat the exported ONNX weights as covered too. For a team running it unmodified, AGPL asks for source
only when they distribute it or offer it over a network to others; for a modified stack it would. We
are not lawyers and have not asked. An answer from Ultralytics on its enterprise licence, or a detector
trained with a permissively licensed framework, would resolve it.

### 10. Who is accountable when a sector shows "searched at POD 60 %" and the person was there? How is that different in practice from declaring the sector done?

The search manager is: every assignment and every proposal is approved by a named person and logged with
who and when (`docs/report/OPENCV_REPORT.md:490`). "Searched at POD 60 %" is a measure of effort, not a
verdict. The map keeps 40 % of that sector's probability, and a searched sector's POD is capped at 0.9,
so searching never rules a sector out (`docs/report/OPENCV_REPORT.md:480-489`). The planner keeps
weighing the sector, so it can come back to the top of the list. Tests check that no text the system
writes says otherwise (`docs/report/OPENCV_REPORT.md:480-486`).

### 11. Radio: WER on a real volunteer's voice over a real handset?

Not measured yet. The 20 phrases and the scoring script are ready (`docs/feedback/radio.md:137-143`,
issue #49); what is missing is three people recording them. Today's numbers are from typed lines and
Magpie's voice, plus real-voice rehearsals timed end to end (`docs/feedback/radio.md:101`,
`docs/report/OPENCV_REPORT.md:515-516`). Recording three voices, with and without radio sound, would
answer it.

### 12. Can I reproduce the HERIDAL test table in 10 minutes on a laptop without a GPU?

Probably not in 10 minutes, and we haven't timed it on a laptop. The detector runs on CPU through
OpenCV 5 at 1.9 s per full photo on 16 cores (`docs/report/OPENCV_REPORT.md:156`), so the 101 test photos
take about 3 minutes of detection on that machine, plus the data and weight downloads
(`README.md:145-151`). `scripts/parity_table.py` also runs the Torch path for comparison, which is slower
on CPU. Timing a clean run on a laptop with only the `cv2.dnn` path would give an honest number.
