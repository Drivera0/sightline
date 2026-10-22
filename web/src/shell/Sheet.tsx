import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, audio[controls], [tabindex]:not([tabindex="-1"])';

/**
 * A sheet over the console (About, the mission form): it slides in from the right on a desktop and up
 * from the bottom on a phone, the console stays mounted behind it. Esc, the close button or a click on
 * the dim closes it; focus goes in, and back where it was on close.
 */
export function Sheet({ label, onClose, children, width = "max-w-xl" }: { label: string; onClose: () => void; children: ReactNode; width?: string }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "Tab" && panel.current) {
        // a modal sheet: Tab and Shift+Tab go round its own controls, never into the console behind it
        const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
        if (items.length === 0) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        const at = document.activeElement;
        const inside = at instanceof Node && panel.current.contains(at);
        if (e.shiftKey && (!inside || at === first || at === panel.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (!inside || at === last)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-bg/60 backdrop-blur-[2px]" onClick={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={`sl-sheet flex h-full w-full ${width} flex-col overflow-y-auto border-l border-line bg-surface-solid shadow-[0_24px_80px_-12px_rgba(0,0,0,0.9)]`}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-surface-solid px-5 py-3">
          <span className="text-small font-medium text-text-2">{label}</span>
          <button type="button" onClick={onClose} className="sl-tap rounded-full px-3 text-small text-text-2 hover:bg-surface-strong hover:text-text">
            Close <span className="text-text-3">Esc</span>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
