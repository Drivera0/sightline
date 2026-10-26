# What breaks first

The same three lines are used in both Devposts, `docs/JUDGE_QA.md`, the web page and the video script. Keep
them in sync; the numbers come from the report.

1. **The detector misses 46 of the 337 people in the HERIDAL test set (recall 0.864, strict VOC), and 28 of those 46 are at two sites, MED and CAB:** groups, clothing that matches pale or dark rock, people sitting or lying down.
2. **The second look is a small gain:** on test it finds 4 more of the 337 people for 15 more false alarms (95 % CI of the recall gain [+0.003, +0.023]), it is advice a person approves, and on people under 60 px it mostly answers "unclear".
3. **The fleet is a simulation, the approvals are not:** the drones, their flights and where each photo was taken are generated over real aerial photographs (HERIDAL), and the site's one "Simulation on real aerial photographs" chip says so. In the guided run and in free play the visitor makes every approval live in the browser (Watch instead, if they pick it, is logged as such), and every move in the log names its approver. Only the agent traces kept as evidence have pre-written human steps, and each trace says so.

Sources:

1. `docs/report/OPENCV_REPORT.md:853-855`; `docs/DETECTOR_LIMITS.md:39`, `:54`
2. `docs/report/OPENCV_REPORT.md:537-540`; `docs/LANE_A_ML.md:314`
3. `docs/report/OPENCV_REPORT.md:884-886`, `:1210-1216`

Why lead with them: judges reward naming the weakness. A judge in the Nebius hackathon's "Will your project
ship?" session said "publish your limitations. Judges read documented failure cases as rigor"
([recording](https://nebiusglobalaihackathon.devpost.com/updates/47163-recording-will-your-project-ship)),
and a year of hackathon judging notes put it as "Prepare an honest answer to what breaks first. Have it ready
before a judge asks." and "Admitting a limitation raised scores in my sheets." (Magomed Kurbaitaev,
[What Judges Actually Score](https://dev.to/kurbaitaev/what-judges-actually-score-notes-from-a-year-of-hackathon-judging-3p4l)).
