export interface ShortcutGroup {
  title: string;
  shortcuts: { keys: string[]; description: string }[];
}

/** Shown by the `?` overlay. Review keys are specified in LANE_D_PIPELINE section 9.2. */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Review",
    shortcuts: [
      { keys: ["J", "↓"], description: "Next crop" },
      { keys: ["K", "↑"], description: "Previous crop" },
      { keys: ["P"], description: "Person" },
      { keys: ["N"], description: "Not a person" },
      { keys: ["U"], description: "Unsure" },
      { keys: ["Z"], description: "Undo" },
      { keys: ["Enter"], description: "Full frame view" },
      { keys: ["M"], description: "Show on map" },
    ],
  },
  {
    title: "Command console",
    shortcuts: [
      { keys: ["Tab"], description: "Move to the next proposal, sector or team" },
      { keys: ["A"], description: "Approve the focused proposal" },
      { keys: ["X"], description: "Reject the focused proposal (asks for a one-line reason)" },
      { keys: ["W"], description: "Open or close the Conditions panel: sources, quotes, the flyability gate" },
      { keys: ["C"], description: "Back to the Command tab from another tab" },
    ],
  },
  {
    title: "Everywhere",
    shortcuts: [
      { keys: ["1", "2", "3", "4", "5", "6"], description: "Jump to a step: Survey, Rank, Review, Search next, Command, Results" },
      { keys: ["C"], description: "Command view (the demo's Command step, or this mission's Command tab)" },
      { keys: ["T"], description: "Watch the guided tour (any key or click stops it)" },
      { keys: ["?"], description: "Show or hide this list" },
      { keys: ["Esc"], description: "Close" },
    ],
  },
];
