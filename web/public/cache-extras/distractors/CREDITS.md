# Distractor photos: credits and licences

The demo scenarios place these as extra photos in the simulated flight: things a drone photo shows that look
like a search but are **not the missing person** (`sightline/search/demo_scenario.py`, `DISTRACTORS`). They
are real photos from Wikimedia Commons, cut and scaled to 1000 px wide by
`scripts/make_distractor_fixture.py --prepare` (no EXIF kept). **None is a drone photo**: no CC0, public
domain or CC BY drone photo of these subjects was found (the drone campsite photos on Commons and Flickr were
all CC BY-SA), so each is the nearest licensed view from above, as listed. No logos, plates or identifiable
faces are in the cuts. `<kind>-crop.jpg` is the crop the reviewer sees, cut from the frame by the verifier.

| File | Shows | View | Source | Credit and licence | Cut (original px) |
|---|---|---|---|---|---|
| `backpack.jpg` | A blue and black backpack on alpine grass | Ground-level oblique (no licensed aerial photo of a pack was found) | [File:Tent,_sleeping_bag,_and_backpack.jpg](https://commons.wikimedia.org/wiki/File:Tent,_sleeping_bag,_and_backpack.jpg) ([Flickr](https://www.flickr.com/photos/sbittinger/53481362441/)) | Steve Bittinger, [CC BY 2.0](https://creativecommons.org/licenses/by/2.0) | (300, 1560)–(1960, 2268), below a drink bottle's label |
| `fire-ring.jpg` | A stone fire ring full of ash and two charred sticks, Snow Creek Trail, Yosemite | Close top-down (camera pointing straight down) | [File:Campfire_scar_08319.JPG](https://commons.wikimedia.org/wiki/File:Campfire_scar_08319.JPG) | Walter Siegmund, [CC BY 2.5](https://creativecommons.org/licenses/by/2.5) | whole photo |
| `shelter.jpg` | Two backpacking tents and a pack among granite slabs, McGee Creek, Inyo National Forest | Steep oblique from a rock outcrop above the camp | [File:Aerial_View_(140435851).jpeg](https://commons.wikimedia.org/wiki/File:Aerial_View_(140435851).jpeg) | J Doll, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0) | (420, 560)–(1100, 1070), the people at the right left out |
| `hikers.jpg` | Two search team members crossing a snowfield below Eagle Peak, Yellowstone (22 Sept 2024) | High oblique from well above | [File:Eagle_Peak_Search_&_Rescue-_ground_team_…_(54018097082).jpg](https://commons.wikimedia.org/wiki/File:Eagle_Peak_Search_%26_Rescue-_ground_team_searching_bowl_under_west_face_of_Eagle_Peak_(54018097082).jpg) | NPS / Jacob W. Frank, public domain (U.S. federal government work) | (2600, 2300)–(5900, 4775) |

Changes: cropped and resized (all four); nothing else. The CC BY works are used under their licences with
the credit above; no endorsement by the authors is implied. The hikers are real searchers on a real search
in another park, shown small and from behind; they stand in for "other hikers, not the subject".
