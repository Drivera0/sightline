// The #judges page's words and links: what to look at first, what each link proves and how long it takes.
// Built by lane A. External links are only followed when clicked (the page fetches nothing but, when the
// site has a mission server, its /health).

const REPO = "https://github.com/Drivera0/sightline";

export const JUDGES = {
  logline:
    "For search managers, Sightline turns drone photos and radio reports into one map that says where to look next, so teams are tasked in minutes.",
  whatToLook: [
    "Start with the demo console: it is the screen a search manager runs, with the map in the middle, the agent's proposals on the right waiting for a person, and teams and clues around it.",
    "Then open the Trace: a 0.18 detection the review queue would have dropped gets a second look with OpenCV 5's native-resolution zoom, Nemotron VL says it is a person lying down, the agent proposes it for review, and a person approves.",
    "Everything simulated says so on screen, and every number comes with its caveat in the report.",
  ],
  built: "Built Oct 20–25 on a BCS Hackathon base",
  changedUrl: `${REPO}/blob/main/docs/submission/NEBIUS_WHAT_CHANGED.md`,
} as const;

export interface JudgeLink {
  label: string;
  time: string | null;
  proves: string;
  /** "#…" opens in the app; "https://…" opens the repo; null: not there yet. */
  href: string | null;
}

export const JUDGE_LINKS: readonly JudgeLink[] = [
  { label: "Demo console", time: "1 min", proves: "the map directs drones and teams; approve or reject the agent's proposals", href: "#m/demo/command" },
  { label: "Trace", time: "1 min", proves: "OpenCV output changing the agent's next action, and which model did what", href: "#m/demo/trace" },
  { label: "Conditions", time: "30 s", proves: "live Tavily facts with the quote and the page each came from (W on the console)", href: "#m/demo/command/conditions" },
  { label: "Guided demo", time: "3 min", proves: "500 drone photos to a ranked queue, a review, where to search next, and the results", href: "#survey" },
  { label: "Results", time: "1 min", proves: "the detector against people reviewing by eye, with sources", href: "#results" },
  { label: "Report", time: null, proves: "method, evaluation, failure cases and limits", href: `${REPO}/blob/main/docs/report/OPENCV_REPORT.md` },
  { label: "Architecture", time: null, proves: "photos → cv2.dnn on AWS → map → agent → human approval", href: `${REPO}/tree/main/docs/architecture` },
  { label: "Repo", time: null, proves: "the code, tests and how to run it", href: REPO },
];

/** The submission videos: placeholders until Dan adds the links. */
export const VIDEOS: readonly { label: string; href: string | null }[] = [
  { label: "OpenCV AI Competition video (5 min)", href: null },
  { label: "Nebius × NVIDIA video (3 min)", href: null },
];

export const HONESTY = {
  simulated: [
    "The flight path over Mount Seymour and the drone fleet",
    "The demo mission's teams, clues and proposals (pre-seeded fixtures, labelled DEMO)",
    "Scripted approvals in recorded runs, shown in amber in the Trace",
  ],
  real: [
    "The aerial photos (HERIDAL) and every detection the detector makes on them",
    "The second look: OpenCV 5 re-look tools and Nemotron VL, recorded in the Trace",
    "Conditions from Tavily with verbatim quotes, and the radio desk's Nemotron turns",
  ],
  principle: "Sightline never marks an area clear.",
  principleMore: "A searched sector says how well it was searched (its POD), and every move waits for a person's approval.",
} as const;
