export interface ShortcutGroup {
  title: string;
  shortcuts: { keys: string[]; description: string }[];
}

/** Shown by the `?` overlay on the console. Review keys are specified in LANE_D_PIPELINE section 9.2. */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "The story",
    shortcuts: [
      { keys: ["→"], description: "Next checkpoint" },
      { keys: ["←"], description: "Previous checkpoint" },
      { keys: ["Space"], description: "Pause or play the mission clock" },
      { keys: ["Esc"], description: "Leave the story (the console stays at that mission time), or close" },
    ],
  },
  {
    title: "Views",
    shortcuts: [
      { keys: ["1", "2", "3", "4", "5", "6"], description: "Map, Photos, Review, Trace, Debrief, Radio" },
      { keys: ["C"], description: "Back to the map" },
    ],
  },
  {
    title: "Console",
    shortcuts: [
      { keys: ["Tab"], description: "Move to the next proposal, sector or team" },
      { keys: ["A"], description: "Approve the focused proposal" },
      { keys: ["X"], description: "Reject the focused proposal (asks for a one-line reason)" },
      { keys: ["W"], description: "Open or close the Conditions panel: sources, quotes, the flyability gate" },
      { keys: ["L"], description: "Open or close the map legend" },
    ],
  },
  {
    title: "Review",
    shortcuts: [
      { keys: ["J", "↓"], description: "Next candidate" },
      { keys: ["K", "↑"], description: "Previous candidate" },
      { keys: ["P"], description: "Person" },
      { keys: ["N"], description: "Not a person" },
      { keys: ["U"], description: "Unsure" },
    ],
  },
  {
    title: "Everywhere",
    shortcuts: [{ keys: ["?"], description: "Show or hide this list" }],
  },
];
