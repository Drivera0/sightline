import { useReview } from "./store";

/**
 * "Reset review": answers are saved per survey in this browser, so a judge on a shared machine
 * would otherwise inherit someone else's. No confirm dialog; the reset can be undone until the
 * next answer.
 */
export function ResetReview({ className = "" }: { className?: string }) {
  const count = useReview((s) => s.history.length);
  const cleared = useReview((s) => s.cleared);
  const reset = useReview((s) => s.reset);
  const undoReset = useReview((s) => s.undoReset);
  const base =
    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-small transition-colors hover:bg-surface-strong ";

  if (cleared !== null) {
    return (
      <span className={`sl-fade inline-flex items-center gap-2 text-small text-text-3 ${className}`} role="status">
        Review cleared
        <button type="button" onClick={undoReset} className={base + "text-accent-soft hover:text-text"}>
          Undo
        </button>
      </span>
    );
  }
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={reset}
      title="Clear the answers saved in this browser for this survey"
      className={base + `text-text-3 hover:text-text ${className}`}
    >
      <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
        <path
          d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v3h3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      Reset review
    </button>
  );
}
