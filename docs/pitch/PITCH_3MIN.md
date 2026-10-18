# 3-minute pitch (draft)

About 420 spoken words: ~2:48 at 150 words a minute, which leaves only ~12 s for pauses and clicks.
If the first rehearsal runs over, use the short version of Harvir's section (Timing notes). Every number is in `NUMBERS.md`.
Speaker names are suggestions; swap freely. Click steps live in `DEMO_60S.md` (Dan sends the final UI flow).

---

### 0:00–0:25 · Opener — Grace  *(slide: the "two people in this photo" haystack image)*

> On Mount Seymour, a drone found a hypothermic hiker two kilometres away,
> on its last battery.
>
> That drone flight is the easy part. What comes back is hundreds of photos like this one, and a
> person has to look at every single one.
>
> There are two people in this photo. Each of them is about sixty pixels wide.
> *(pause two seconds)* Most of you haven't found them yet.

### 0:25–0:55 · The bottleneck — Grace  *(slide: 33 s / 59% / 68% / 4.6 h)*

> Research on real search-and-rescue imagery measured how people do this: thirty-three seconds a
> photo, and they still miss about a third of the people.
> One survey flight of five hundred photos is four and a half hours of staring.
> North Shore Rescue does more than a hundred rescues a year. That time is the bottleneck.

### 0:55–1:50 · Demo — Grace drives, the team narrates  *(live site; see `DEMO_60S.md`)*

> Sightline is one loop: rank, pin, search next.
>
> *(Review)* These are the same five hundred photos. Our detector has already read all of them,
> in a quarter of a second each, and put the likeliest crops first. The first photo is a person.
> All six people are within the first seven photos: under four minutes of looking.
>
> *(Press P on a person)* A searcher confirms it, and the pin drops on the map, with its uncertainty
> circle.
>
> *(Press N on a false alarm, open the map)* Saying "not a person" updates the map live.
> *(Scrub)* Open ground the drone could see fades. Forest it could not see into stays bright.
> That is where the ground team goes next.

### 1:50–2:20 · Why this is not "just CV in a drone" — Dan  *(slide: 19.6% → 86.4%)*

> A stock detector finds one person in five on these photos: people are just too small.
> We cut every photo into tiles and trained on real labelled search photos.
> On a hundred and one test photos we never trained on, we find eighty-six percent of people at
> eighty percent precision, after correcting a label error in four of them.
> The published human baseline is sixty-eight and fifty-nine, at thirty-three seconds a photo.
> We take a quarter of a second.

### 2:20–2:50 · Why a map, and honest limits — Harvir  *(slide: what is simulated + what it misses)*

> In our simulation, even when the drone flies right over a hiker, the photos miss them about half
> the time. So "not found" can't mean "clear". Inside the surveyed area, our map reaches the hiker
> in ninety-eight cells against a hundred and twenty-three for a naive map. With our canopy
> estimate's real error, it stays at least ten percent better on every seed. The flight path, the
> ten-metre uncertainty and that evaluation are simulated, and labelled on screen. And these are
> Croatian scrub photos, not BC rainforest.

### 2:50–3:00 · Close — Grace

> Sightline doesn't decide that anyone is safe or that any area is clear. It gives a searcher the
> right photo first, and the right place to walk next. We'd love to put it in front of a real team.

---

## Timing notes
- If short on time, cut Harvir's section to: "The search map is evaluated in simulation: with our
  canopy estimate's real error, it stays at least ten percent better than a naive map on every
  seed. Everything simulated is labelled on screen." Never cut the human-baseline comparison or the label-fix clause after 86%.
- Always say "about half" for the overflown-hiker miss rate, never an exact percentage; always pair
  98 vs 123 with "at least ten percent better" (98 vs 123 is the best of three seeds). Say
  "better", not "fewer cells": at one seed Sightline checks 9.2% fewer (`NUMBERS.md`).
- Don't say "photo 336 in flight order" on stage: it is one flight's order, not a baseline.
- The opener's pause only works if the haystack photo is full-screen with no circles. Reveal the
  circles on the next click.
- Check before stage: the Mount Seymour wording against the DroneXL / CBC article (`NUMBERS.md`).
