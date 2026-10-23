# Drone feed clips: credits and licences

The console's "Drone feed" tile plays these while a simulated drone flies a leg. They are **public-domain
footage, not this flight**: the tile says so ("drone feed (public-domain footage, not this flight)").
Each is a 10 s stretch of one shot, re-encoded to 1280 x 720 H.264 (yuv420p, CRF 29, no audio,
`+faststart`) so it loops; the `.jpg` is its first frame (the poster).

| File | Shows | Source | Credit | Licence | Kept (original time) |
|---|---|---|---|---|---|
| `forest-1.mp4`, `forest-1.jpg` | Slow aerial drift over a conifer slope, Castle Crags peaks at the top | [DVIDS video 998726](https://www.dvidshub.net/video/998726/), "Aerial View of Shasta-Trinity National Forest near Castle Crags Wilderness" (VIRIN 260306-O-NM884-6706) | U.S. Forest Service video by Andrew Avitt and Bob Doucette, Shasta-Trinity National Forest, via DVIDS | Public domain (the page: "PUBLIC DOMAIN This work … must comply with the restrictions shown on https://www.dvidshub.net/about/copyright") | 84 s to 94 s |
| `forest-2.mp4`, `forest-2.jpg` | Drone pan over a shaded forested valley and rocky ridgelines | the same video | the same | the same | 278 s to 288 s |

DVIDS terms: the work is a U.S. government work in the public domain; it must not be used to imply
endorsement by the U.S. Forest Service or the Department of Defense. Sightline is not affiliated with or
endorsed by either.

Encoding (per clip, start time as above):

    ffmpeg -ss <START> -i DOD_111563303.mp4 -t 10 -an \
      -vf "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1" \
      -c:v libx264 -preset slow -crf 29 -pix_fmt yuv420p -movflags +faststart forest-N.mp4
    ffmpeg -i forest-N.mp4 -frames:v 1 -q:v 5 forest-N.jpg

Not used: the same producer's thermal clip of Stanislaus National Forest (DVIDS 1022439, public domain):
its warm spots could read as a find on a search console.
