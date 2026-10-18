import { STEPS, type StepId } from "./flow";

/** Survey -> Rank -> Review -> Search next -> Results. Always shows where you are; every step is clickable. */
export function StepBar({ value, onChange }: { value: StepId; onChange: (id: StepId) => void }) {
  const currentIndex = STEPS.findIndex((s) => s.id === value);
  return (
    <nav aria-label="Demo steps">
      <ol className="flex items-center gap-1 rounded-full border border-border bg-surface p-1">
        {STEPS.map((step, index) => {
          const isCurrent = step.id === value;
          const isDone = index < currentIndex;
          return (
            <li key={step.id} className="flex items-center">
              {index > 0 && (
                <span
                  aria-hidden="true"
                  className={`mx-0.5 h-px w-3 ${isDone || isCurrent ? "bg-accent" : "bg-border"}`}
                />
              )}
              <button
                type="button"
                aria-current={isCurrent ? "step" : undefined}
                onClick={() => onChange(step.id)}
                title={step.hint}
                className={
                  "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-small transition-colors " +
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
                {step.label}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
