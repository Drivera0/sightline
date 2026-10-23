# Judge Q&A: the twelve questions we expect, answered from the repo

Short, honest answers to the live questions a hostile judge is likely to ask, each with its evidence.
Where the honest answer is "we don't know yet", it says so and names what would settle it. Line numbers
are as of `main` at #180 (2026-10-22); the hostile review of that day re-checked them.

### What breaks first

1. The detector misses 46 of the 337 people in the HERIDAL test set (recall 0.864, strict VOC), and 28 of those 46 are at two sites, MED and CAB: groups, clothing that matches pale or dark rock, people sitting or lying down (`docs/report/OPENCV_REPORT.md:853-855`; `docs/DETECTOR_LIMITS.md:39`, `:54`).
2. The second look is a small gain: on test it finds 4 more of the 337 people for 15 more false alarms (95 % CI of the recall gain [+0.003, +0.023]), it is advice a person approves, and on people under 60 px it mostly answers "unclear" (`docs/report/OPENCV_REPORT.md:537-540`).
3. The fleet and the approvals in the demo are simulated: the drones, their flights and their photos are simulated, and the human approvals in the recorded traces are scripted; both are labelled so on screen and in the trace (`docs/report/OPENCV_REPORT.md:884-886`).

The same three lines, for the web page and the video script: `docs/submission/WHAT_BREAKS_FIRST.md`.

### Where to look, in order

1. The home page: https://sightline-iota-sandy.vercel.app (`#`): one measured claim over the survey's photos, four measured facts with their sources, how it works, who it is for, **Guided simulation** (five scenario cards on the same mountain and photos) and a **For judges** strip of links.
2. **Start the simulation** on a scenario card (about 3 min, the guided search, `#m/demo?s=<seed>&guide=1`; the overdue hiker is marked "Start here"). You are the search manager: the clock runs to each decision and waits, the agent proposes, you decide, and the map, the teams and the clock show what your decision changed (the survey, triage including the 0.17 standing detection, f0273-d02, that the second look caught on this flight, the radio clue, the assignment, the lost link, assigning again, the find). **What you did** then compares your choices with the agent's line and prints every draw; **Watch instead** plays the agent's line. A team's pass finds the subject on a draw fixed by the seed, at the sector's POD (0.60). The old `#m/demo?t=0` to `?t=6` links open the plain console at those moments.
3. The Trace view: OpenCV output changing the agent's next action, and which model did what (`#m/demo/trace`). In the plain console the fixture's own decisions are labelled "The scenario's search manager", and its stand-in model calls "Replayed" (not "This flight").
4. Conditions (W in the console): live Tavily facts with the quote and the page each came from (`#m/demo/map/conditions`).
5. The Debrief: the measured results, what breaks first, and the links out (report, trace, code; a live mission's debrief to keep) (`#m/demo?t=6`; `&judges` opens this list there, and the old `#judges` redirects to it).
6. The About sheet: who built it, the two entries, the colours, the models, the limits and the licences (`#about`, or the wordmark).

### 1. Why is there a New search if the public site can't start one? What do I see at 10 pm when the EC2 box is stopped?

The public build has no API address baked in, so New search (`#new`, the empty console) says "The live
mission server runs during demos and judging; this site is the demo", with the form disabled and "Load the
demo mission" (`#m/demo/map`), which works without a server (`web/src/ingest/NewSearch.tsx:92-96`, `:128`). The demo
mission is the whole public site and needs no server (`web/src/App.tsx:74-75`); `#` is the home page, whose scenario cards open it. The AWS API is stopped between demos to save cost
(`README.md:237-238`), so at 10 pm a live mission is not available unless it was started. During judging
`.github/workflows/judging-check.yml` checks the API every 6 hours and opens an issue when it fails
(`deploy/aws/README.md:107-115`); whether the instance stays up all through judging is a decision for Dan.

### 2. Where in the product can I see the perception → decision → action trace for the proposal I just approved?

In the console's Trace view, `#m/<id>/trace` (`web/src/command/TraceView.tsx`). It polls
`GET /missions/{id}/trace` (`sightline/api/missions.py:413`) and groups the trace into chains by the ids they
share (perception → decision → action → approval), one line per step with the tool or model, input, output
and ms, the proposal each chain led to, and who decided it. Without a server, `#m/demo/trace` shows this flight's own trace first (the 0.17 standing f0273-d02 with its live second look kept word for word; stand-in model calls labelled Replayed), then two earlier runs, labelled Earlier run: the 0.18 lying-down showcase chain on a validation photo and a live conditions lookup (`docs/report/OPENCV_REPORT.md:499-504`).
The same chain as a table is in `docs/architecture/agent.md` and the report (`docs/report/OPENCV_REPORT.md:490-497`).

### 3. The second look costs 15 false alarms for 4 finds and doesn't move F2. Why keep it? What operating point would a SAR manager choose?

Because a missed person costs more than a false alarm, which is why the threshold itself was chosen by
F2 (`docs/report/OPENCV_REPORT.md:317-318`). The 15 extra false alarms are spread over 101 test photos
(the review queue grows from 363 to 382 items, `docs/LANE_A_ML.md:310-311`), and each is a proposal a
person dismisses, never an automatic action. The recall gain is small but its 95 % CI excludes zero
([+0.003, +0.023], `docs/report/OPENCV_REPORT.md:537-538`). Which operating point a SAR manager would
pick, we don't know: no search manager has reviewed it. A 30-minute read by a BC SAR volunteer would
answer it.

### 4. Two model choices saw test scores. What's your best estimate of true test recall?

About 0.86: the reported 0.864 or slightly below, because the alternatives differed by less than
validation can resolve and the dropped model had the higher test recall (`docs/report/OPENCV_REPORT.md:308-315`,
`README.md:40`). We don't have an untouched number. Two bounds from the repo: validation recall at the same
threshold is 0.859 (`docs/report/OPENCV_REPORT.md:141-142`), and on the four test sites the model has
never seen it is 0.825 against 0.883 on trained sites (`docs/DETECTOR_LIMITS.md:117`), so on new terrain
expect nearer 0.825. Scored once with no tuning on LADD, 1,365 Russian drone photos the model never saw,
recall is 0.516 (precision 0.509, AP50 0.458), so on very different terrain expect about half (`docs/report/LADD.md`).

### 5. With a flat prior the planner equals a serpentine. When in a real search is there a clue early enough to matter?

Agreed on the first part: on a flat prior the planner finds the person within 30 minutes in 6.9 % of
trials against 6.8 % for a fixed order (`docs/report/OPENCV_REPORT.md:664-665`). With a clue at the start it
is 10.7 % against 6.3 % (`:666-667`). The prior no longer has to be flat: with the subject category set,
Koester's lost-person rings move finds within 30 min from 22.1 % to 52.8 % for a dementia subject with three
drones, and cost 21.9 % → 15.7 % when the category is wrong (`docs/report/OPENCV_REPORT.md:683-687`,
`docs/report/PLANNER_V2.md`). With a clue arriving 10 minutes in, three drones with opening legs and two
teams find the person within 30 minutes in 26.6 % of trials (`docs/report/PLANNER_V2.md`, table (c)). How early real clues
arrive we have not measured; running the same evaluations with the clue at 30 and 60 minutes would answer it.

### 6. What is physical about this entry? Have you flown a real drone photo through the live API end to end?

A real drone photo, yes: one full 4000×3000 HERIDAL photo (taken by a real drone) uploaded through the
AWS API, 7.1 s from upload to processed on the default instance
(`docs/report/OPENCV_REPORT.md:374`). Our own drone, no: the fleet, its flight and the photos'
poses are simulated and labelled (`docs/report/OPENCV_REPORT.md:884-886`). What is physical is the
loop: drone photos change the map, the map re-tasks a drone and a team, and a person approves each move
(`docs/architecture/agent.md`, second chain). A flight with a DJI drone over a volunteer would settle it.

### 7. Does `nvidia/Nemotron-3.5-Super-VL` exist on Token Factory today? What happens to a mission if Token Factory is down?

Yes. Checked against the live catalog on 2026-10-22: `nvidia/Nemotron-3.5-Super-VL` (us-north1),
`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` and `nvidia/nemotron-3-super-120b-a12b` are all listed verbatim
(`docs/feedback/nebius.md:22-24`). If Token Factory is down, detection and the map carry on (they run on
our own CPU), the second look returns `unclear` naming the error and makes no proposal, planner proposals
continue with template briefings (`docs/architecture/agent.md:339-343`), and the radio answers "say
again" and changes nothing (`docs/report/OPENCV_REPORT.md:882`). After 4 failed attempts in a row a circuit
breaker makes every call fail fast for 60 s, so a mission pays about 82 s in all rather than minutes per call;
the agent evaluation injects this and shows it in the trace (`docs/report/OPENCV_REPORT.md:577`,
`docs/report/AGENT_EVAL.md`).

### 8. HERIDAL's original terms: may the imagery be shown on a public site?

We use the VOC-format copy by Pyrrö (2021), which is published under CC BY 3.0, and we attribute it
(`README.md:265`, `:269`). We have not cited the original HERIDAL release's own terms page, so we don't
know yet whether it adds conditions. Citing the original release page (or asking its authors) would
resolve it.

### 9. AGPL + ONNX weights: can North Shore Rescue deploy on a Jetson without open-sourcing their stack?

Our code is AGPL-3.0 to match Ultralytics, which the detector is trained with (`README.md:269`), and we
treat the exported ONNX weights as covered too. For a team running it unmodified, AGPL asks for source
only when they distribute it or offer it over a network to others; for a modified stack it would. We
are not lawyers and have not asked. An answer from Ultralytics on its enterprise licence, or a detector
trained with a permissively licensed framework, would resolve it.

### 10. Who is accountable when a sector shows "searched at POD 60 %" and the person was there? How is that different in practice from declaring the sector done?

The search manager is: every assignment and every proposal is approved by a named person and logged with
who and when (`docs/report/OPENCV_REPORT.md:919`). "Searched at POD 60 %" is a measure of effort, not a
verdict. The map keeps 40 % of that sector's probability, and a searched sector's POD is capped at 0.9,
so searching never rules a sector out (`docs/report/OPENCV_REPORT.md:909-918`). The planner keeps
weighing the sector, so it can come back to the top of the list. Tests check that no text the system
writes says otherwise (`docs/report/OPENCV_REPORT.md:909-918`).

### 11. Radio: WER on a real volunteer's voice over a real handset?

Measured on one voice so far, direct microphone, not a handset: 20 phrases, 162 words, WER 0.086 with 0 / 2
coordinates right, then 0.025 with both exactly right after the "niner" fix, both scored after the radio desk's normaliser
(`docs/evidence/radio_wer/20261022-101034/wer.md`, `docs/feedback/radio.md:190-207`). The one real
finding: Parakeet does not know the radio word "niner" and writes "49er" or "nine or"; the normaliser
now resolves both. Two more voices and a set through a handheld radio are still to be recorded (issue
#49); until then this is one speaker, not a population.

### 12. Can I reproduce the HERIDAL test table in 10 minutes on a laptop without a GPU?

On a 16-core desktop with the GPU hidden, yes: `scripts/reproduce_cv2.py` runs the 101 test photos through
OpenCV 5 `cv2.dnn` only and checks the three VOC scores against the published ones in 4 min 58 s (about
5 min 10 s with the downloads), measured while another job used about 11 of the 32 threads
(`README.md:169-180`, `docs/report/OPENCV_REPORT.md:1022-1035`). On a laptop we haven't timed it; the detector
needs about 30 CPU-seconds per full photo (`docs/report/OPENCV_REPORT.md:377`), so the time grows as the core
count falls. Timing a clean run on a laptop would give an honest number.
