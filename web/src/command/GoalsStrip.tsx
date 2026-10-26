// The Mission goals strip, above the map on a guided or free run (goals.ts): four goals with where each
// stands, read live from the run. A tick when a goal is met, a cross when it can no longer be, an open
// circle while it is still to play for; the full goal and its progress on hover and for screen readers.
// Built by lane A.

import type { Goal, GoalState } from "./goals";

const MARK: Record<GoalState, { glyph: string; tone: string; word: string }> = {
  done: { glyph: "✓", tone: "text-ok", word: "met" },
  open: { glyph: "○", tone: "text-text-3", word: "to play for" },
  missed: { glyph: "✕", tone: "text-caution", word: "missed" },
};

export function GoalsStrip({ goals }: { goals: readonly Goal[] }) {
  const met = goals.filter((g) => g.state === "done").length;
  return (
    <section aria-label="Mission goals" data-goals className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-1 gap-y-1 overflow-hidden rounded-lg border border-line bg-surface-solid px-2 py-1 text-caption lg:flex-nowrap">
      <span className="mr-0.5 shrink-0 whitespace-nowrap font-medium text-text-2" title="Your goals for this search. The end screen scores them.">
        <span className="2xl:hidden">Goals</span><span className="max-2xl:hidden">Mission goals</span> <span className="font-normal text-text-3">{met}/{goals.length}</span>
      </span>
      {goals.map((g) => {
        const m = MARK[g.state];
        return (
          <span
            key={g.id}
            data-goal={g.id}
            data-state={g.state}
            title={`${g.label}: ${g.progress}`}
            className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 ${g.state === "done" ? "border-ok/40" : g.state === "missed" ? "border-caution/50" : "border-line"}`}
          >
            <span aria-hidden className={m.tone}>
              {m.glyph}
            </span>
            <span className="text-text">{g.short}</span>
            {g.brief ? <span className="text-text-2 tabular-nums">{g.brief}</span> : null}
            <span className="sr-only">
              {g.label}: {g.progress}, {m.word}.
            </span>
          </span>
        );
      })}
    </section>
  );
}
