# 3-minute pitch (draft)

About 430 spoken words at ~150 words a minute. Every number is in `NUMBERS.md`.
Speaker names are suggestions; swap freely. Click steps live in `DEMO_60S.md` (Dan sends the final UI flow).

---

### 0:00–0:25 · Opener — Grace  *(slide: the "two people in this photo" haystack image)*

> On Mount Seymour, a hypothermic hiker was found two kilometres from where searchers expected,
> on the drone's last battery.
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

### 0:55–1:55 · Demo — Grace drives, the team narrates  *(live site; see `DEMO_60S.md`)*

> Sightline is one loop: rank, pin, search next.
>
> *(Review)* These are the same five hundred photos. Our detector has already read all of them,
> in a quarter of a second each, and put the likeliest crops first. All six people are within the
> first fifteen photos. In flight order, the sixth one is photo four hundred and sixty-two.
>
> *(Press P on a person)* A searcher confirms it, and the pin drops on the map, with its uncertainty
> circle.
>
> *(Press N on a false alarm, open the map)* Saying "not a person" updates the map live.
> *(Scrub)* Open ground the drone could see fades. Forest it could not see into stays bright.
> That is where the ground team goes next.

### 1:55–2:35 · Why this is not "just CV in a drone" — Dan  *(slide: 19.6% → 76.9%)*

> A stock detector finds one person in five on these photos: people are just too small.
> We cut every photo into tiles and trained on real labelled search photos.
> On the hundred and one test photos we never trained on, we find seventy-seven percent of people
> with seventy-one percent precision. The published human baseline is sixty-eight and fifty-nine,
> at thirty-three seconds a photo. We take a quarter of a second.

### 2:35–2:50 · Honest limits — Harvir  *(slide: what is simulated)*

> Three things are simulated, and the app labels them every time: the flight path, the ten-metre
> position uncertainty, and the search evaluation. In thirty thousand simulated searches,
> our map sends the ground team to the right cell in a hundred and two cells instead of a
> hundred and twenty-two. The photos are Croatian scrub, not BC rainforest.

### 2:50–3:00 · Close — Grace

> Sightline doesn't decide that anyone is safe or that any area is clear. It gives a searcher the
> right photo first, and the right place to walk next. We'd love to put it in front of a real team.

---

## Timing notes
- If short on time, cut "Honest limits" to one line: "Everything simulated is labelled on screen."
  Never cut the human-baseline comparison.
- The opener's pause only works if the haystack photo is full-screen with no circles. Reveal the
  circles on the next click.
- Check before stage: the Mount Seymour wording against the DroneXL / CBC article (`NUMBERS.md`).
