# What changed during the submission period (Nebius × NVIDIA Global AI Hackathon)

Sightline was first built inside this hackathon's submission period: our team of four, Daniel Rivera, Grace Chu ([@bamobam](https://github.com/bamobam)), Harvir Nijjar ([@har-vir](https://github.com/har-vir)) and Jason Kim ([@jkiim](https://github.com/jkiim)), built it together in 36 hours at BCS Hackathon 2026; everything below was added since
(Oct 16–17, tag `bcs-final-submission`). That version was a batch tool. It took one drone survey,
ranked the photos with a tiled detector, put each detection on a map and ran a Bayesian probability
map over the survey area, all from a precomputed cache.

Everything below was added between Oct 20 and the `nebius-submit` tag, which is created at submission
(`git diff bcs-final-submission..nebius-submit`). Every NVIDIA model call, the radio desk, the agent, the
fleet and the Serverless Job are new in this period:

- **Live missions:** a search is created in the browser, and photos are uploaded as each flight lands
  (or watched from a folder, or sent by the simulated fleet). Each photo is processed as it arrives:
  pose from EXIF/XMP, the detector, the map step. The browser gets updates over server-sent events.
  There is a mission store with a contract checked on every write.
- **Nemotron throughout, on Nebius Token Factory:**
  - Nemotron VL takes a second look at uncertain detections, using OpenCV 5 re-look images.
  - Nemotron 3 Super answers the radio's turns with tool calls.
  - Nemotron 3 Nano writes the briefings and reads the conditions pages, keeping each value with its quote.
  - Every call is traced.
- **An agent that proposes and a person who decides:** verdicts, clues, conditions and the planner's
  legs become proposals with reasons and evidence. Nothing happens until the search manager approves
  it in the console.
- **A radio desk:** ground teams talk to Sightline on a secondary channel, with Parakeet speech to text,
  Nemotron with tools and Magpie speech (Parakeet and Magpie run on a local RTX 4080 SUPER). A clue is logged only after Sightline reads it back and the team
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
- **A Nebius Serverless Endpoint** serves the same detector one photo at a time over HTTPS (5.68 s p50
  for a 4000×3000 photo, $0.38 per 1,000; `deploy/nebius/ENDPOINT.md`); `SIGHTLINE_DETECT_URL` points the
  worker at it.
- **The subject from a public bulletin:** Nemotron Nano decides whether to search, Tavily searches and
  extracts, and a profile field is kept only with a verbatim quote; approval sets the lost-person prior
  (three live runs in `docs/report/TAVILY.md`).
- **Real footage in:** `scripts/real_flight.py` checks a folder's GPS and pose, geotags video frames from
  an SRT or flight log, and sends it through the live API (`docs/REAL_FLIGHT.md`).
- **Command-post files:** ICS 204 per team, ICS 214 from the trace, CalTopo GeoJSON (`docs/EXPORTS.md`).
- **The map counts what a photo can show:** recall by person size at each photo's GSD, and a terrain
  factor measured on LADD, an unseen dataset where the frozen detector's recall is 0.516
  (`docs/report/POD.md`, `docs/report/LADD.md`).
- **A re-look leg and a ledger:** an `unclear` second look on a small box proposes a 25 m pass, and every
  look and leg records its expected and realised value; in simulation the pass resolved 0 of 25 val
  near-misses, and the report says so (`docs/report/AGENT_EVAL.md`).
- **One console:** task board, teams, approval inbox, clue log and printable assignment cards with
  GPX/KML, the views Map · Photos · Review · Trace · Debrief (with the exports and the trace's model,
  tool and ledger chips), the demo as a 3-minute story, and an About section on the home page (`#about`) that explains the product.
- **AWS deployment:** S3, SQS, a worker running OpenCV 5 `cv2.dnn`, CloudWatch and Secrets Manager.
- **Continuous integration:** the tests, a smoke test of the whole live loop with fakes, and the web
  build, on every change.

What stayed from BCS: the detector weights (YOLO11s fine-tuned on HERIDAL), the tiling, the Bayesian
map's core update, and the demo survey.
