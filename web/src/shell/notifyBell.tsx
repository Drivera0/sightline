// The bell in the status line (V3 §2): how many notifications came in that nobody has looked at, and the
// last ones behind it, newest first, each with its "Show me". Opening it marks them read. The list is
// fixed to the window (the status line scrolls sideways on a phone and would clip it). Built by lane A.
import { useEffect, useRef, useState } from "react";
import { unreadCount, useNotify, type ShowTarget } from "./notify";
import { TONE_VAR } from "./toasts";

const ago = (at: number, now: number) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

export function NotifyBell({ onShow }: { onShow: (target: ShowTarget | null | undefined) => void }) {
  const log = useNotify((s) => s.log);
  const unread = unreadCount(log);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    useNotify.getState().markRead();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);
  const toggle = () => {
    const r = button.current?.getBoundingClientRect();
    if (r) setAt({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    setOpen((o) => !o);
  };
  const now = Date.now();
  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-label={unread ? `Notifications, ${unread} new` : "Notifications"}
        title="Notifications"
        className="sl-tap relative inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-line px-2 text-caption text-text-2 hover:border-border hover:text-text"
      >
        <svg aria-hidden="true" width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z" />
          <path d="M10 21h4" />
        </svg>
        {unread > 0 ? (
          <span data-testid="bell-count" className="min-w-4 rounded-full bg-text px-1 text-center text-caption font-medium text-bg">
            {unread}
          </span>
        ) : (
          <span className="text-text-3">0</span>
        )}
      </button>
      {open && at && (
        <div
          ref={panel}
          role="dialog"
          aria-label="Notifications"
          style={{ top: at.top, right: at.right }}
          className="sl-slide-in fixed z-50 flex max-h-[60vh] w-[min(24rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-md border border-border bg-surface-solid shadow-[var(--shadow-pop)]"
        >
          <p className="sl-panel-head">Notifications</p>
          {log.length === 0 ? (
            <p className="p-3 text-small text-text-3">Nothing yet. New proposals, candidates, clues and radio calls show here.</p>
          ) : (
            <ol className="flex min-h-0 flex-col overflow-y-auto">
              {log.map((n) => (
                <li key={n.id} style={{ ["--c" as string]: TONE_VAR[n.tone] }} className="flex items-start gap-2 border-b border-line px-3 py-2 last:border-b-0">
                  <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-[var(--c)]" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-small text-text">
                      {n.title}
                      {n.count > 1 && <span className="ml-1 text-caption text-text-3">×{n.count}</span>}
                    </span>
                    {n.body && <span className="truncate text-caption text-text-2" title={n.body}>{n.body}</span>}
                    <span className="text-caption text-text-3">{ago(n.at, now)}</span>
                  </span>
                  {n.target && (
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        onShow(n.target);
                      }}
                      className="sl-tap shrink-0 rounded-full border border-line px-2 py-0.5 text-caption text-text-2 hover:text-text"
                    >
                      {n.action ?? "Show me"}
                    </button>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </>
  );
}
