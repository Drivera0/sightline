# What changed during the submission period (Nebius × NVIDIA Global AI Hackathon)

Sightline existed before this hackathon's build: we built it in 36 hours at BCS Hackathon 2026
(Oct 16–17, tag `bcs-final-submission`). That version was a batch tool. It took one drone survey,
ranked the photos with a tiled detector, put each detection on a map and ran a Bayesian probability
map over the survey area, all from a precomputed cache.

Everything below was added between Oct 20 and the `nebius-submit` tag (`git diff
bcs-final-submission..nebius-submit`):

- **Live missions:** a search is created in the browser, and photos are uploaded as each flight lands
  (or watched from a folder, or sent by the simulated fleet). Each photo is processed as it arrives:
  pose from EXIF/XMP, the detector, the map step. The browser gets updates over server-sent events.
  There is a mission store with a contract checked on every write.
- **Nemotron throughout, on Nebius Token Factory:**
  - Nemotron VL takes a second look at uncertain detections, using OpenCV 5 re-look images.
  - Nemotron 3 Super handles planning and the radio's tool calls.
  - Nemotron 3 Nano writes the briefings.
  - Every call is traced.
- **An agent that proposes and a person who decides:** verdicts, clues, conditions and the planner's
  legs become proposals with reasons and evidence. Nothing happens until the search manager approves
  it in the command view.
- **A radio desk:** ground teams talk to Sightline on a secondary channel, with Parakeet speech to text,
  Nemotron with tools and Magpie speech. A clue is logged only after Sightline reads it back and the team
  confirms. It transmits only approved briefings.
- **A simulated drone fleet:** 2–3 drones fly approved legs and send their photos through the same API.
  A team's clue re-tasks the nearest drone (the creek scenario). There is a simulated fleet evaluation.
  All of it is labelled simulated.
- **An information-gain planner** for drone legs and team assignments, and a live map that every photo,
  review, searched sector and clue updates.
- **Conditions from Tavily at run time:**
  - forecast, warnings and park alerts, each value kept only with a verbatim quote;
  - they decide whether drones may fly, how much a photo can see, where people shelter, and what teams
    hear.
- **A Nebius Serverless Job** detects the fleet's photos in batch on CPU (711 photos, 483 s).
- **Command view:** task board, teams, approval inbox, clue log and printable assignment cards with
  GPX/KML. Also a mission debrief and a front door that explains the product.
- **AWS deployment:** S3, SQS, a worker running OpenCV 5 `cv2.dnn`, CloudWatch and Secrets Manager.
- **Continuous integration:** the tests, a smoke test of the whole live loop with fakes, and the web
  build, on every change.

What stayed from BCS: the detector weights (YOLO11s fine-tuned on HERIDAL), the tiling, the Bayesian
map's core update, and the demo survey.
