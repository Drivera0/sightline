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
to 86.4%. And the detector is one of three steps; the other two are the queue and the search map.

**"The AIR paper reports 86%. How do you compare?"**
About the same, and on a stricter rule. Our 86.4% recall at 80.2% precision uses strict box
matching (IoU ≥ 0.5). AIR scores with a looser search-and-rescue rule, where a box counts if it
lands on the person; under that rule we get 89.6% recall at 89.8% precision. AIR is a research
RetinaNet tuned for this benchmark; ours is a small YOLO11s at a quarter of a second per photo.
Both beat the human baseline of 68%.
*If pushed:* we don't claim to beat AIR; the two numbers come from different setups. Our point is
the loop after the detector.
*Check before stage:* the AIR 86% figure and its precision come from the original deck (slide 9);
confirm the table in arXiv 2111.09406 if a judge asks for the exact setting.

**"Your recall went from 77% to 86%. Did you tune on the test set?"**
No. The predictions and the threshold didn't change. Four test photos are 4000×2250 but their
label files say 4000×3000, so 42 person boxes sat above the people and every hit there was scored
as a miss. We now read the size from the image, and the same predictions score 86.4% instead of
76.9%. We relabelled nothing else, so precision is probably still understated.
Source: `docs/DETECTOR_LIMITS.md` §1.

**"What does it get wrong?"**
It misses people in groups, clothing that matches pale or dark rock, and people sitting or lying
down. Misses cluster by site, not by size: two of twelve sites hold 28 of the 46 misses. Most of the
72 false alarms look like people the dataset didn't label; a few are bags and shadows, and a
reviewer clears those in seconds.
*If pushed:* lower the threshold to 0.10 and recall goes to 91.1% at 66.3% precision; the queue
absorbs extra false alarms better than missed people.

**"Why is so much simulated?"**
Because the honest alternative is no evaluation at all. HERIDAL photos are real but most have no
usable flight log, so we place them on a simulated flight over Mount Seymour; you can't run 30,000
real lost-person searches, so the map comparison is simulated; and we assumed a 10 m position
error. Every one of those is labelled "simulated" on screen. The detector numbers are not
simulated: they are measured on 101 real test photos we never trained on.

**"All six in the first seven — compared to what?"**
Compared to looking at photos in a random order, the first person turns up on average at photo 71.6;
ours is at photo 1. We don't quote a flight-order number as a baseline: that depends on one
flight's layout.

**"Will this work in BC?"**
Not yet proven. HERIDAL is Croatian scrub in daylight, not coastal rainforest, snow or night. That
is exactly why the map trusts open ground more than canopy. Next step: test on BC imagery and
thermal.

**"How do you know you didn't overfit to the test set?"**
The threshold was chosen on validation photos, and the test set was used only for the final score.
We also dropped a variant we tried (hard negatives: test F2 0.840 vs 0.850) instead of quietly
tuning until the test number went up.

**"Does it decide where the person is?"**
No. It orders the photos and suggests where to look; a searcher confirms every sighting, and the
app never marks an area as clear.

**"Your search map only beats naive inside the surveyed area."**
Correct, and we say so. Over the whole 1 km grid it ties naive, because the drone only photographed
part of it and our starting prior is still flat. Inside the area the drone covered: in the demo run,
Sightline's map needs 98 cells against 123 for a naive map (simulated); across seeds and with our
canopy estimate's measured error it stays at least 10% better, in every run.

**"Is 98 vs 123 cherry-picked?"**
It is the demo run (seed 7), and it is the best of the three seeds. That's why the claim we make is
"at least 10% better": with noise as large as our canopy classifier's measured error (MAE 0.34), the
naive map needs 10–13% more cells than ours on every seed. Sightline beat naive in all 15 runs
(3 seeds × 5 noise levels), but at the highest noise we tried the gain drops to 8–9%. And that noise
is random, while the classifier's real errors are systematic (it misses pale and autumn trees), so
even this is somewhat optimistic. Source: `docs/LANE_C_SEARCH.md`.

**"Why does a map matter if the drone already flew there?"**
In our simulation, even when the drone flies right over a hiker, the photos miss them about half
the time (trees, shadow, small people). So "photographed" can't mean "cleared"; the map keeps forest
the camera couldn't see into high on the list.
*Never give an exact percentage here; say "about half".*

**"What does the map assume?"**
Each photo is an independent look; the canopy estimate has MAE 0.34; the flight path, the 10 m clear
radius and the whole evaluation are simulated; the starting prior is a flat placeholder.

**"What would you need to use this for real?"**
A real lost-person prior from published search statistics, measured pin error from the drones' own
GPS, BC and thermal imagery, and a pilot run with a team on their own flights.

**"What did each of you do?"**
Daniel: detector. Jason: geo and map layers. Harvir: search map. Grace: pipeline, app and pitch.
