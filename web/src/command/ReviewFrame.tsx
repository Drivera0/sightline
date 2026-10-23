// The large review frame (V3 §3): when photos land and candidates arrive, the first waiting one opens here
// so the search manager knows they are being asked. The whole photo with the candidate's box, the crop
// large, the AI second look as a real button with its two model chips, and the three answers (P, N, U).
// An answer moves on to the next waiting candidate by itself; at the end it says so. Esc or Later closes it
// (the candidates stay in Needs you). The map pans to and pulses the candidate in view. Built by lane A.
import { useEffect, useRef } from "react";
import { isTyping } from "../lib/keys";
import { focusCandidate, reviewKeys, type LiveAnswer, type ReviewCard } from "../review/LiveReview";
import { SecondLook } from "../review/SecondLook";
import { KeyHint } from "../shell/components";
import { useConsole } from "./consoleStore";

const ANSWERS: { id: LiveAnswer; label: string; key: string }[] = [
  { id: "person", label: "Person", key: "P" },
  { id: "not_person", label: "Not a person", key: "N" },
  { id: "unsure", label: "Unsure", key: "U" },
];

/** The candidate the frame shows: the one asked for if it still waits, else the first waiting. */
export function frameCard(cards: readonly ReviewCard[], answers: Readonly<Record<string, LiveAnswer>>, want: string | null): ReviewCard | null {
  const waiting = cards.filter((c) => !answers[c.id]);
  return waiting.find((c) => c.id === want) ?? waiting[0] ?? null;
}

export function ReviewFrame({
  cards,
  answers,
  onAnswer,
}: {
  cards: readonly ReviewCard[];
  answers: Readonly<Record<string, LiveAnswer>>;
  onAnswer: (id: string, answer: LiveAnswer) => void;
}) {
  const { open, id } = useConsole((s) => s.review);
  const close = () => useConsole.getState().closeReview();
  const c = open ? frameCard(cards, answers, id) : null;
  const waiting = cards.filter((x) => !answers[x.id]).length;
  const done = cards.length - waiting;
  const box = useRef<HTMLDivElement>(null);
  const back = useRef<Element | null>(null);

  // while open the frame owns the review keys; focus comes back where it was
  useEffect(() => {
    if (!open) return undefined;
    reviewKeys.frameOpen = true;
    back.current = document.activeElement;
    box.current?.focus({ preventScroll: true });
    return () => {
      reviewKeys.frameOpen = false;
      (back.current as HTMLElement | null)?.focus?.({ preventScroll: true });
    };
  }, [open]);
  // the map shows the candidate in view
  useEffect(() => {
    if (c) focusCandidate(c.id);
  }, [c?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const answer = (a: LiveAnswer) => {
    if (!c) return;
    const next = cards.filter((x) => !answers[x.id] && x.id !== c.id)[0] ?? null;
    onAnswer(c.id, a);
    useConsole.getState().openReview(next?.id ?? null); // on to the next one by itself
  };
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        return close();
      }
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey || !c) return;
      const k = e.key.toLowerCase();
      if (k === "p" || k === "n" || k === "u") {
        e.preventDefault();
        answer(k === "p" ? "person" : k === "n" ? "not_person" : "unsure");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-bg/70 p-2 backdrop-blur-[2px] sm:p-6" onClick={close}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label="Review candidates"
        tabIndex={-1}
        data-review-frame=""
        onClick={(e) => e.stopPropagation()}
        className="sl-sheet flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-border bg-surface-solid shadow-[var(--shadow-pop)]"
      >
        <header className="sl-panel-head">
          <span>Review candidates</span>
          <span className="text-caption font-normal text-text-3">
            {c ? `${done + 1} of ${cards.length}` : `${done} of ${cards.length} answered`}
          </span>
          <button type="button" onClick={close} className="sl-tap ml-auto rounded-full border border-line px-2.5 py-0.5 text-caption font-normal text-text-2 hover:text-text">
            Later <KeyHint>Esc</KeyHint>
          </button>
        </header>
        {!c ? (
          <div className="flex flex-col items-start gap-3 p-6">
            <p className="text-title text-text">Every candidate has an answer.</p>
            <p className="text-body text-text-2">A Person is a pin on the map; the timeline has each answer.</p>
            <button type="button" onClick={close} className="sl-tap rounded-full border border-border px-4 py-1 text-small text-text">
              Back to the map
            </button>
          </div>
        ) : (
          <div key={c.id} className="sl-slide-in grid min-h-0 flex-1 gap-3 overflow-y-auto p-3 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <figure className="flex min-h-0 flex-col gap-1.5">
              <Photo c={c} />
              <figcaption className="flex flex-wrap items-baseline gap-x-3 text-caption text-text-3">
                <span>{c.frame}</span>
                <span className="font-mono">{c.id}</span>
                <span>detector {c.conf.toFixed(2)}</span>
              </figcaption>
            </figure>
            <div className="flex min-w-0 flex-col gap-3">
              <img src={c.crop} alt={`Crop of ${c.id}`} className="aspect-square w-full max-w-72 rounded-md object-cover" />
              <SecondLook c={c} large />
              {c.note && <p className="text-caption text-text-3">{c.note}</p>}
              <div role="group" aria-label="Answer" className="mt-auto flex flex-wrap gap-2">
                {ANSWERS.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => answer(a.id)}
                    className={`sl-tap inline-flex h-9 items-center gap-2 rounded-full border px-4 text-small text-text ${a.id === "person" ? "border-found bg-found/10 hover:bg-found/20" : "border-border hover:bg-surface-strong"}`}
                  >
                    {a.label} <KeyHint>{a.key}</KeyHint>
                  </button>
                ))}
              </div>
              <p className="text-caption text-text-3">{waiting > 1 ? `${waiting - 1} more after this one; each answer moves on by itself.` : "The last one waiting."}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The whole photo with the candidate's box on it; the crop alone when the photo is not known. */
function Photo({ c }: { c: ReviewCard }) {
  if (!c.photo || !c.size || !c.box) return <img src={c.crop} alt={`Crop of ${c.id}, large`} className="max-h-[60vh] w-full rounded-md object-contain" />;
  const [w, h] = c.size;
  const [x0, y0, x1, y1] = c.box;
  const pct = (v: number, of: number) => `${(100 * v) / of}%`;
  return (
    <div className="relative w-full overflow-hidden rounded-md bg-surface-strong" style={{ aspectRatio: `${w} / ${h}` }}>
      <img src={c.photo} alt={`${c.frame}, the whole photo`} className="absolute inset-0 h-full w-full object-cover" />
      <span
        aria-hidden
        className="sl-new absolute rounded-[3px] border-2 border-accent"
        style={{ ["--c" as string]: "var(--accent)", left: pct(x0, w), top: pct(y0, h), width: pct(x1 - x0, w), height: pct(y1 - y0, h) }}
      />
    </div>
  );
}
