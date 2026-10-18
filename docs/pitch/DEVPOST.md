# Devpost write-up (draft)

Paste each section into the matching Devpost field. Numbers: `NUMBERS.md`.
Submission deadline: **18 Oct 2026, 1:15 PM PDT**.

---

## Tagline

Find the hiker in 500 drone photos, then show the rescue team where to look next.

## Inspiration

North Shore Rescue, Canada's busiest volunteer search-and-rescue team, rescues more than a
hundred people a year in the mountains above Vancouver. Drones now go up on many of those
searches. On Mount Seymour, a hypothermic hiker was found two kilometres away on the drone's
last battery.

Flying is the fast part. Every flight brings back hundreds of 12-megapixel photos, and a lost
person is about 60 pixels wide in each one. Research on real search imagery measured people at
33 seconds a photo, and they still missed about a third of the people. One 500-photo survey is
four and a half hours of careful looking.

## What it does

Sightline is one loop for the person reviewing drone photos:

1. **Rank.** A detector trained on real, labelled search-and-rescue photos reads every photo and
   puts the likeliest crops at the top of a review queue. On our 500-photo demo survey, all six
   people are within the first 15 photos reviewed, against photo 462 in flight order.
2. **Pin.** When a searcher presses P for "person", the sighting becomes a GPS pin on the map, with
   its position uncertainty drawn as a circle.
3. **Search next.** A Bayesian probability map updates after every photo. Ground the drone could
   see clearly fades; forest the camera could not see into stays bright. Saying "not a person" on
   a false alarm updates the map live. That is where the ground team should walk next.

It assists searchers. It never decides on its own that a person is safe or that an area is clear.

## How we built it

- **Detector (Python, PyTorch, Ultralytics YOLO11s, SAHI).** Trained on 1024 px tiles cut from the
  HERIDAL aerial search dataset, using only the annotated training photos, with rotation and flips.
  Tiling is the key: shrinking a whole photo makes a person a few pixels tall. We also mined
  hard negatives (bags, rocks, debris), measured them, and kept the model that scored better.
- **Geo (Python, NumPy).** Camera math turns a pixel into a GPS position from the drone's pose,
  height and heading, and builds each photo's ground footprint. The demo flies a simulated
  lawnmower path over Mount Seymour.
- **Search map (Python, NumPy, OpenCV).** A 1 km grid of 20 m cells. A canopy classifier estimates
  how much of each cell is under trees, which sets the probability of detection; each photo then
  applies a Bayesian update. A simulation of 30,000 lost hikers compares search strategies.
- **Pipeline (Python, Pydantic, Typer).** Eight stages run every lane's code in order and write a
  cache of JSON and image files. A shared data contract with validation means a wrong shape fails
  in the pipeline, not on stage. Ground truth never reaches the website.
- **Website (React, TypeScript, Vite, Tailwind, Zustand, MapLibre, PMTiles), on Vercel.** It only
  reads the cache, so the demo needs no GPU and no server, and it works with Wi-Fi off thanks to an
  offline basemap.
- 886 automated tests across the four parts (649 Python, 237 web).

## Results

On the 101 HERIDAL test photos (337 people) the model never saw in training:

| | Recall | Precision | Time per photo |
|---|---|---|---|
| Published human baseline | 68% | 59% | 33 s |
| Stock YOLO11s, photo shrunk | 19.6% | 42.0% | 0.06 s |
| **Sightline (tiled, fine-tuned)** | **76.9%** | **71.3%** | **0.25 s** |

Search map, **simulated** (30,000 simulated lost hikers in ground the drone photographed but did
not find): a ground team reaches the right 20 m cell after a median of 102 cells with Sightline,
122 if photographed ground is treated as cleared, and 154 with no photos at all.

## Challenges we ran into

- **Tiny people.** A stock detector found one person in five. Tiling plus fine-tuning took recall
  to 77%.
- **Bad labels.** About 560 training and validation photos in the public copy of the dataset have
  empty label files, and some of them show people nobody labelled. Training on them taught the model that those
  people were background. We found this mid-hackathon and retrained without them.
- **Four people, one product.** We agreed a data contract in the first hour, so the website was
  built on fake data while the model trained, and each part plugged in when it was ready.
- **Honest evaluation.** We picked the detector's threshold on validation photos and scored only on
  test photos. The ranking result uses a seeded random flight order, never hand-placed people.

## Accomplishments that we're proud of

- Beating the published human baseline on recall and precision, more than 130 times faster per photo.
- A review queue that puts all six people in the first 15 of 500 photos.
- Every number on screen traces to a file or a paper, and everything simulated is labelled as simulated.

## What we learned

- Most of a small-object detector's accuracy came from how we fed it images, not from the model.
- "Not found" is information: a photo of open ground that shows nobody lowers the odds there, but a
  photo of dense forest barely does.
- Check the dataset before trusting it.

## Honest limits

- **Simulated flight path.** The photos are real, but their positions are placed on a simulated
  flight over Mount Seymour.
- **Simulated search evaluation.** The search-map comparison uses simulated lost hikers.
- **10 m position uncertainty is assumed**, not measured.
- **Wrong landscape.** HERIDAL is Croatian Mediterranean scrub photographed in daylight, not BC
  rainforest, snow or night.
- **Flat prior.** The search map still starts from a uniform placeholder prior, labelled on screen.
- **Small test set.** 101 test photos and a 500-photo demo survey with six people.

## What's next for Sightline

- Measure the real pin error using the photos' own GPS and gimbal data.
- A real lost-person prior from published search statistics.
- Thermal and low-light imagery, and BC terrain.
- Put it in front of a real search team and measure time-to-find on their own flights.

## Built with

python, pytorch, ultralytics, yolo, sahi, opencv, numpy, pydantic, fastapi, typer, react,
typescript, vite, tailwindcss, zustand, maplibre, pmtiles, vitest, pytest, vercel

## Credits

- Imagery: HERIDAL dataset (Božić-Štulić, Marušić & Gotovac, 2019), VOC-format copy by Pyrrö (2021),
  CC BY 3.0.
- Human baseline: Pyrrö, Naseri & Jung, "Rethinking Drone-Based Search and Rescue with Aerial
  Person Detection", arXiv:2111.09406 (2021).
- Basemap: Protomaps, © OpenStreetMap contributors.

## Team

- **Daniel** — detector: data, training, hard negatives, evaluation, metrics screen.
- **Jason** — geo: camera math, pixel to GPS, flight path, map layers, offline basemap.
- **Harvir** — search map: grid, canopy, Bayesian update, simulation, heat layer.
- **Grace** — pipeline and app: data contract, survey builder, pipeline, review queue, pitch.

*(Add each person's previous degree here if we enter Best Use of Interdisciplinary Background —
see `EVENT_NOTES.md`.)*
