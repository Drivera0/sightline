# Judge Q&A sheet

Short answers first; the second line is only if they push. Numbers: `NUMBERS.md`.

---

**"Doesn't Eagle Eyes already do this?"**
Eagle Eyes, from Squamish, is real and good: North Shore Rescue has flown it on live operations.
It flags unusual pixels, by how far each pixel is from the photo's colour distribution, so a
pilot can look. Sightline is a trained person detector plus two things after the sighting: a
ranked review queue across a whole survey, and a map of where to search next when nobody is found.
*If pushed:* we would rather plug into a tool like that than replace it; our map step works on
top of any detector.
Sources: DroneXL, Apr 2025; BC Aviation Council; New Ventures BC profile.

**"FlyBy placed at HackGT with drone search-and-rescue. How are you different?"**
FlyBy (HackGT 13, Best Overall 2nd place) works in a simulated disaster: a simulated drone, simulated
sightings, a fine-tuned model that suggests the next action per lead, and a fly-brain-inspired
obstacle reflex. Ours starts from real labelled drone photos, measures the detector against a
published human baseline, and turns "found nobody" into a search map.
*If pushed:* the two are complementary; FlyBy is about the drone and the dispatch decision, we are
about the photos a team already has.
Source: devpost.com/software/flyby-fdxcua.

**"Isn't this just computer vision? Run YOLO and you're done."**
We tried that first. Stock YOLO finds 19.6% of people here, because a person is about 60 pixels
in a 12-megapixel photo and shrinking the photo makes them vanish. Tiling and fine-tuning took us
to 76.9%. And the detector is one of three steps; the other two are the queue and the search map.

**"The AIR paper reports 86%. You have 77%. Why is yours worse?"**
Different scoring. Our 76.9% uses strict box matching (IoU ≥ 0.5). AIR scores with a looser
search-and-rescue rule, where a box counts if it lands on the person. Under that looser rule we
get 80.7% recall at 81% precision. AIR is a research RetinaNet tuned for this benchmark; ours is a
small YOLO trained in a day on one GPU at a quarter of a second per photo. Both beat the human
baseline of 68%.
*Check before stage:* the AIR 86% figure and its precision come from the original deck (slide 9);
confirm the table in arXiv 2111.09406 if a judge asks for the exact setting.

**"Why is so much simulated?"**
Because the honest alternative is no evaluation at all. HERIDAL photos are real but most have no
usable flight log, so we place them on a simulated flight over Mount Seymour; you can't run 30,000
real lost-person searches, so the map comparison is simulated; and we assumed a 10 m position
error. Every one of those is labelled "simulated" on screen. The detector numbers are not
simulated: they are measured on 101 real test photos we never trained on.

**"Will this work in BC?"**
Not yet proven. HERIDAL is Croatian scrub in daylight, not coastal rainforest, snow or night. That
is exactly why the map trusts open ground more than canopy. Next step: test on BC imagery and
thermal.

**"How do you know you didn't overfit to the test set?"**
The threshold was chosen on validation photos, and the test set was used only for the final score.
We also kept a model that scored worse on a variant we tried (hard negatives: F2 0.740 vs 0.757),
instead of quietly tuning until the test number went up.

**"Does it decide where the person is?"**
No. It orders the photos and suggests where to look; a searcher confirms every sighting, and the
app never marks an area as clear.

**"Your search map only beats naive inside the surveyed area."**
Correct, and we say so. Over the whole 1 km grid it ties naive, because the drone only photographed
part of it and our starting prior is still flat. Inside the area the drone covered, it sends the
team to the right cell after 102 cells instead of 122.

**"What would you need to use this for real?"**
A real lost-person prior from published search statistics, measured pin error from the drones' own
GPS, BC and thermal imagery, and a pilot run with a team on their own flights.

**"What did each of you do?"**
Daniel: detector. Jason: geo and map layers. Harvir: search map. Grace: pipeline, app and pitch.
