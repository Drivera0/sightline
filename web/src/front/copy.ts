// The front door's words (LANE_E §6.2): exactly as written there; propose changes to Dan, don't
// improvise. Tests read these constants. Built by lane A for lane E (issue #70).

export const HERO = {
  title: "Sightline",
  tagline: "The brain of a drone search.",
  body: "Drones and ground teams feed one probability map. The map tells both where to look next — on screen at the command post, and by voice over the radio.",
  start: "Start a new search",
  demo: "Watch a demo search",
  honesty:
    "The demo uses real aerial search-and-rescue photos (HERIDAL) placed on a simulated flight over Mount Seymour. Everything simulated is labelled.",
} as const;

export const HOW_IT_WORKS = [
  {
    title: "The drone flies a grid",
    body: "It takes geotagged still photos, not video: a hiker is about 70 pixels wide in a still and about 15 in a video frame.",
  },
  {
    title: "Photos arrive",
    body: "After each landing, straight from the SD card — no signal needed. Or during the flight, when the command post has a connection.",
  },
  {
    title: "Sightline flags, people confirm",
    body: "The detector ranks every photo in a quarter of a second. A reviewer confirms each candidate; uncertain ones get a second look by AI before a person decides.",
  },
  {
    title: "The map directs the search",
    body: "Every photo and every ground report updates where the person could still be. Sightline proposes the next drone leg and the next team assignment. The search manager approves.",
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
  "Direct connection to DJI FlightHub 2 so photos arrive automatically",
  "Several drones on one search (try it in the demo)",
  "Runs on an NVIDIA Jetson field kit with no internet",
  "Field trials with a SAR team",
] as const;

export const FOOTER = {
  data: "Photos: HERIDAL (Božić-Štulić, Marušić & Gotovac, 2019), CC BY 3.0. Basemap © OpenStreetMap contributors.",
  results: "Results",
  code: "Code on GitHub",
  codeUrl: "https://github.com/Drivera0/sightline",
} as const;

/** One standard briefing in Sightline's voice: NVIDIA Magpie TTS multilingual 357M, speaker 0 (E-13),
 *  generated offline with `sightline/radio/tts.py` and served from public/front/ (works with Wi-Fi off). */
export const RADIO_CLIP = {
  label: "Hear Sightline on the radio",
  detail: "NVIDIA Magpie TTS, 12 s",
  src: "/front/briefing.mp3",
  transcript:
    "Team Two, Sightline. New assignment, sector Bravo Three. Enter from the east ridge, bearing two seven zero, six hundred metres. Looking for a red jacket, possibly lying down. Two hours forty of daylight. Over.",
} as const;

/** The one place the front door says "clear": a negation in Principle 1 (LANE_E §9 test 1 allowlist). */
export const CLEAR_ALLOWLIST = ["Sightline never marks an area clear."] as const;
