// "Where to look, in order": the debrief's fold for judges (it was the #judges page; #judges opens it).
// Each row deep-links to a moment of the demo mission or a view of the console, says what it proves and
// how long it takes. External links are only followed when clicked. Built by lane A.

const REPO = "https://github.com/Drivera0/sightline";
export const REPORT_URL = `${REPO}/blob/main/docs/report/OPENCV_REPORT.md`;
export const REPO_URL = REPO;

export const JUDGES = {
  logline:
    "For search managers, Sightline turns drone photos and radio reports into one map that says where to look next, so teams are tasked in minutes.",
  built: "Built Oct 20–25 on a BCS Hackathon base",
  changedUrl: `${REPO}/blob/main/docs/submission/NEBIUS_WHAT_CHANGED.md`,
} as const;

export interface JudgeLink {
  label: string;
  time: string | null;
  proves: string;
  /** "#…" opens in the app; "https://…" opens the repo. */
  href: string;
}

export const JUDGE_LINKS: readonly JudgeLink[] = [
  { label: "Follow the search", time: "3 min", proves: "you make each decision while the clock waits: the survey, triage, the radio clue, the assignment, the lost link, the find; then your choices against the agent's", href: "#m/demo?guide=1" },
  { label: "Confirm", time: "1 min", proves: "a 0.17 detection on this flight the queue would have dropped, rescued by OpenCV 5's zoom and Nemotron VL, confirmed by a person", href: "#m/demo?t=2" },
  { label: "Trace", time: "1 min", proves: "OpenCV output changing the agent's next action, and which model did what", href: "#m/demo/trace" },
  { label: "Conditions", time: "30 s", proves: "live Tavily facts with the quote and the page each came from (W in the console)", href: "#m/demo/map/conditions" },
  { label: "Try a photo", time: "1 min", proves: "the same detector running in your browser on a photo you choose", href: "#m/demo/photos?try" },
  { label: "Report", time: null, proves: "method, evaluation, failure cases and limits", href: REPORT_URL },
  { label: "Architecture", time: null, proves: "photos → cv2.dnn on AWS → map → agent → human approval", href: `${REPO}/tree/main/docs/architecture` },
  { label: "Repo", time: null, proves: "the code, tests and how to run it", href: REPO },
];

/**
 * What breaks first: the three lines used word for word in both Devposts, docs/JUDGE_QA.md and the video
 * (docs/submission/WHAT_BREAKS_FIRST.md, with their sources in the report). Keep them in sync.
 */
export const WHAT_BREAKS_FIRST: readonly { lead: string; rest: string }[] = [
  {
    lead: "The detector misses 46 of the 337 people in the HERIDAL test set (recall 0.864, strict VOC), and 28 of those 46 are at two sites, MED and CAB:",
    rest: "groups, clothing that matches pale or dark rock, people sitting or lying down.",
  },
  {
    lead: "The second look is a small gain:",
    rest: "on test it finds 4 more of the 337 people for 15 more false alarms (95 % CI of the recall gain [+0.003, +0.023]), it is advice a person approves, and on people under 60 px it mostly answers “unclear”.",
  },
  {
    lead: "The fleet and the approvals in the demo are simulated:",
    rest: "the drones, their flights and their photos are simulated, and the human approvals in the recorded traces are scripted; both are labelled so on screen and in the trace.",
  },
];

export const HONESTY = {
  simulated: [
    "The flight path over Mount Seymour and the drone fleet",
    "The demo mission's teams, clues and proposals (pre-seeded fixtures, labelled DEMO), and its timeline",
    "Scripted approvals in recorded runs, shown in amber in the Trace",
  ],
  real: [
    "The aerial photos (HERIDAL) and every detection the detector makes on them",
    "The second look: OpenCV 5 re-look tools and Nemotron VL, recorded in the Trace",
    "Conditions from Tavily with verbatim quotes, and the radio desk's Nemotron turns",
  ],
} as const;
