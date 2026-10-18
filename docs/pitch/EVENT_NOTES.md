# BCS Hacks 2026: rules check and prize fit

Checked 2026-10-17 evening from the event's Devpost overview and rules pages.

## Key facts
- **Event:** 17 Oct 1:00 PM to 18 Oct 3:00 PM (rules page), UBC Vancouver campus, invite only.
- **Devpost submission deadline: 18 Oct 2026, 1:15 PM PDT.**
- **Eligibility:** enrolled in the UBC BCS program (rules page); accepted participants, age of
  majority, college students only (overview).
- **Judges:** Mo Fardinzaman (Amazon), Leo Zhang (Asana), Iris Cheung (MLH Top 50, 6× winner),
  Alberto Escobar Mingo (Amazon), Devon Friend (Kardium).

## Pre-built code
The rules page states only dates and eligibility; it has **no rule about code written before the
event**. Our record is clean anyway:
- The first commit in the repo is 17 Oct 1:35 PM PDT, after the 1:00 PM start; every code commit
  is later (`git log`).
- Before the event we had the idea deck (16 Oct) and planning docs. The test-split release
  (`data-v1`, 17 Oct 2:48 PM) and both weight releases (`weights-v1` 17 Oct 5:42 PM, `weights-v2`
  later) are dated during the event. Ask Daniel whether any data prep or training ran before 1:00 PM;
  the lane A plan allowed data download and conversion as pre-event prep.
- Third-party parts we use, and should credit: HERIDAL data (CC BY 3.0), YOLO11s pretrained weights
  (Ultralytics), open-source libraries, the published human baseline.

If a judge asks, say: "Planning and the idea deck were before the event; all code was written
during it, and the git history shows that."

## Prize fit

| Prize | Fit | What to emphasise |
|---|---|---|
| **Best Overall** ($400) | Strong | Working loop on real data, measured against humans, honest labels, clear demo. |
| **Best Use of Tech for Social Good** ($100) | Strong | Search and rescue for a named local team (North Shore Rescue); assists, never decides. |
| **Best Use of Interdisciplinary Background** ($100) | **Possible — need input** | BCS students all have a previous degree. Needs one line per person on what their first field brought (for example: stats → the Bayesian map; design → the review queue). **Ask each teammate for their previous degree.** |
| Best Beginner Project ($100) | Weak | Only if the team counts as beginners; the project's scope will not read as beginner work. |

Devpost lets you select every prize you qualify for. Select at least Best Overall and Social Good.

## Still to do before 1:15 PM
- [ ] Each teammate's previous degree, for the interdisciplinary line in `DEVPOST.md`.
- [ ] Demo video link and repo link in the Devpost form.
- [ ] Confirm the three North Shore Rescue facts against the DroneXL / CBC articles.
