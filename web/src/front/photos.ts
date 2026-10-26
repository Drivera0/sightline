// The four photographs on the home page: a real search (Eagle Peak, Yellowstone National Park),
// public domain, by NPS / Jacob W. Frank. Served from public/front/ (no request leaves the site); sources
// and licences in public/front/CREDITS.md. They show the work Sightline supports, not Sightline itself.

export interface Photo {
  src: string;
  alt: string;
  caption: string;
}

export const PHOTOS: readonly Photo[] = [
  { src: "/front/drone-launch.webp", alt: "A small quadcopter drone lifting off a landing pad on a grassy ridge below a snowy peak", caption: "A drone goes up from the ridge" },
  { src: "/front/aerial-search.webp", alt: "A red helicopter flying low past a cliff band over a forested valley", caption: "Ground to cover: cliffs, scree and timber" },
  { src: "/front/ground-team.webp", alt: "A searcher in a yellow shirt scanning a mountain valley with binoculars from a rocky outcrop", caption: "Ground teams search on foot" },
  { src: "/front/briefing.webp", alt: "Searchers gathered in a parking lot at dawn for a morning briefing", caption: "The command post: one briefing, one plan" },
];

export const PHOTO_CREDIT = "Photos: NPS / Jacob W. Frank, Eagle Peak search and rescue, Yellowstone National Park (public domain).";
export const CREDITS_URL = "https://github.com/Drivera0/sightline/blob/main/web/public/front/CREDITS.md";
