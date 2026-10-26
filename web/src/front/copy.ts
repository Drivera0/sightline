// The site's words (first LANE_E §6.2's front door): the home page's hero and sections (front/Home.tsx),
// its About section (#about) and the Debrief's footer. Propose changes to Dan, don't improvise. Built by lane A for lane E (issue #70).

export const HERO = {
  title: "Sightline",
  eyebrow: "Drone search and rescue",
  tagline: "The brain of a drone search.",
  body: "Drones and ground teams feed one probability map. The map tells both where to look next — on screen at the command post, and by voice over the radio.",
  honesty:
    "The demo uses real aerial search-and-rescue photos (HERIDAL) placed on a simulated flight over Mount Seymour. Everything simulated is labelled.",
} as const;

/**
 * How photos get in, and whether it is live: three paths, one line each, with an icon from the shared
 * set (shell/icons.tsx). `short` is the one-line form. The 70 px / 15 px line is the README's.
 */
export const INTAKE = [
  {
    icon: "base",
    title: "After landing",
    body: "Pull the card and drop the photos onto the console, or into a folder the command-post laptop watches:",
    code: "python -m sightline.client watch FOLDER",
    short: "After landing: the card's photos, dropped on the console or into a watched folder.",
  },
  {
    icon: "drone",
    title: "During the flight, when there is signal",
    body: "The same client watches the controller's download folder and sends each photo as it lands, so the map moves while the drone is still up.",
    short: "During the flight, with signal: each photo is sent as it lands.",
  },
  {
    icon: "detection",
    title: "Not live video",
    body: "Sightline reads geotagged stills, not a video feed: a hiker is about 70 px wide in a still and about 15 px in a video frame.",
    short: "Not live video: geotagged stills, where a hiker is about 70 px wide instead of 15.",
  },
] as const;

export const WHO_ITS_FOR = [
  {
    title: "Search manager",
    body: "“Where do I send drones and teams next, and why?” Sees the map, the proposals and the reasons, and approves every move.",
  },
  {
    title: "Image reviewer",
    body: "“Show me the likeliest person first.” Reviews ranked crops instead of scrolling through hundreds of photos.",
  },
  {
    title: "Ground team leader",
    body: "“Where do I go, what am I looking for, what changed?” Gets an assignment card and GPS file, and talks to Sightline over the radio.",
  },
] as const;

export const PRINCIPLES = [
  {
    title: "Assists, never decides.",
    body: "Sightline never marks an area clear. A searched sector says how well it was searched (“searched at POD 60%”), and every move needs a person’s approval.",
  },
  {
    title: "Works at the command post.",
    body: "Batch mode needs no internet. Near-live mode is a bonus when there is a connection.",
  },
  {
    title: "Drones and people are both sensors.",
    body: "A backpack a team finds moves the map as much as a photo does.",
  },
  {
    title: "Every decision is logged.",
    body: "Proposals, approvals, radio traffic and reviews become the mission debrief.",
  },
  {
    title: "Honest about limits.",
    body: "It struggles with groups, clothing that matches rock, and people lying down. Simulated parts are labelled.",
  },
] as const;

export const ROADMAP_LABEL = "Next";
export const ROADMAP = [
  "Thermal cameras for night searches",
  "Direct connection to the drone maker's cloud so photos arrive automatically",
  "Several drones on one search (try it in the demo)",
  "Runs on an NVIDIA Jetson field kit with no internet",
  "Field trials with a SAR team",
] as const;

export const FOOTER = {
  data: "Photos: HERIDAL (Božić-Štulić, Marušić & Gotovac, 2019), CC BY 3.0. Basemap © OpenStreetMap contributors.",
  code: "Code on GitHub",
  codeUrl: "https://github.com/Drivera0/sightline",
} as const;

/** One standard briefing in Sightline's voice: NVIDIA Magpie TTS multilingual 357M, speaker 0 (E-13),
 *  generated offline with `sightline/radio/tts.py` and served from public/front/ (works with Wi-Fi off). In About and the Debrief. */
export const RADIO_CLIP = {
  label: "Hear Sightline on the radio",
  detail: "NVIDIA Magpie TTS, 12 s",
  src: "/front/briefing.mp3",
  transcript:
    "Team Two, Sightline. New assignment, sector Bravo Three. Enter from the east ridge, bearing two seven zero, six hundred metres. Looking for a red jacket, possibly lying down. Two hours forty of daylight. Over.",
} as const;
