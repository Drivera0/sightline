import { STEPS, type StepId } from "./flow";

/** Survey -> Rank -> Review -> Search next -> Results. Always shows where you are; every step is clickable. */
export function StepBar({ value, onChange }: { value: StepId; onChange: (id: StepId) => void }) {
  const currentIndex = STEPS.findIndex((s) => s.id === value);
  return (
    <nav aria-label="Demo steps" className="max-w-full">
      <ol className="flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full border border-border bg-surface p-0.5">
        {STEPS.map((step, index) => {
          const isCurrent = step.id === value;
          const isDone = index < currentIndex;
          return (
            <li key={step.id} className="flex items-center">
              {index > 0 && (
                <span
                  aria-hidden="true"
                  className={`h-px w-2 lg:w-3 ${isDone || isCurrent ? "bg-accent" : "bg-border"}`}
                />
              )}
              <button
                type="button"
                aria-current={isCurrent ? "step" : undefined}
                onClick={() => onChange(step.id)}
                title={step.hint}
                className={
                  "inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-2 text-small transition-colors lg:px-3 " +
                  (isCurrent
                    ? "bg-accent text-bg"
                    : isDone
                      ? "text-text hover:bg-surface-strong"
                      : "text-text-3 hover:bg-surface-strong hover:text-text-2")
                }
              >
                <span
                  className={
                    "inline-flex size-5 items-center justify-center rounded-full font-mono text-label " +
                    (isCurrent ? "bg-bg/20" : isDone ? "bg-accent/20 text-accent-soft" : "bg-surface-strong")
                  }
                >
                  {isDone ? "✓" : index + 1}
                </span>
                <span className={isCurrent ? "" : "sr-only lg:not-sr-only"}>{step.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
