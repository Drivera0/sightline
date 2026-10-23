// The toast stack (V3 §2): bottom right, over the console's right column and the timeline, never the map's
// centre; each toast stays 5 s (longer while the pointer or focus is on the stack), stacks newest at the
// bottom, says what happened in the colour of its kind, and has one action ("Show me"). Screen readers hear
// each one once (a polite live region). Built by lane A.
import { useEffect, useRef, useState } from "react";
import { TOAST_MS, useNotify, type Note, type NoteTone, type ShowTarget } from "./notify";

/** The tone's colour token (theme.css, the v3 colour block). */
export const TONE_VAR: Record<NoteTone, string> = {
  team: "var(--team)",
  drone: "var(--drone)",
  clue: "var(--clue)",
  proposal: "var(--proposal)",
  found: "var(--found)",
  alert: "var(--alert)",
  review: "var(--accent)",
  note: "var(--text-2)",
};

export function ToastStack({ onShow }: { onShow: (target: ShowTarget | null | undefined) => void }) {
  const toasts = useNotify((s) => s.toasts);
  const [held, setHeld] = useState(false);
  return (
    <div
      aria-live="polite"
      aria-label="Notifications"
      role="region"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      // above the phone's bottom tabs; on a desktop over the right column's foot
      className="pointer-events-none fixed right-3 bottom-20 z-40 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-2 lg:right-4 lg:bottom-4"
    >
      {toasts.map((t) => (
        <Toast key={t.id} note={t} held={held} onShow={onShow} />
      ))}
    </div>
  );
}

function Toast({ note, held, onShow }: { note: Note; held: boolean; onShow: (target: ShowTarget | null | undefined) => void }) {
  const dismiss = () => useNotify.getState().dismiss(note.id);
  // the clock restarts when the toast comes again (merged) and while it is held
  const left = useRef(TOAST_MS);
  useEffect(() => {
    left.current = TOAST_MS;
  }, [note.at]);
  useEffect(() => {
    if (held) return undefined;
    const start = Date.now();
    const timer = window.setTimeout(dismiss, left.current);
    return () => {
      window.clearTimeout(timer);
      left.current = Math.max(1200, left.current - (Date.now() - start));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held, note.at]);
  return (
    <div
      role="status"
      data-toast={note.key}
      style={{ ["--c" as string]: TONE_VAR[note.tone] }}
      className="sl-toast-rise pointer-events-auto flex items-start gap-2 rounded-md border border-border border-l-[3px] border-l-[var(--c)] bg-surface-solid/95 px-2.5 py-2 pr-1.5 shadow-[var(--shadow-pop)] backdrop-blur"
    >
      <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-[var(--c)]" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-small font-medium text-text">
          {note.title}
          {note.count > 1 && <span className="ml-1.5 text-caption font-normal text-text-3">×{note.count}</span>}
        </p>
        {note.body && <p className="line-clamp-2 text-caption text-text-2">{note.body}</p>}
        {note.target && (
          <button
            type="button"
            onClick={() => {
              onShow(note.target);
              dismiss();
            }}
            className="sl-tap mt-0.5 self-start rounded-full border border-[color-mix(in_srgb,var(--c)_55%,transparent)] px-2.5 py-0.5 text-caption text-text hover:bg-[color-mix(in_srgb,var(--c)_14%,transparent)]"
          >
            {note.action ?? "Show me"}
          </button>
        )}
      </div>
      <button type="button" aria-label="Dismiss" onClick={dismiss} className="sl-tap -mt-0.5 rounded-full px-1.5 text-small text-text-3 hover:text-text">
        ×
      </button>
    </div>
  );
}
