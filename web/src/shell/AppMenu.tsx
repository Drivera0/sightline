import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { KeyHint } from "./components";

export interface MenuItem {
  label: string;
  /** A short second line under the label. */
  detail?: string;
  hint?: string;
  onSelect: () => void;
}

/**
 * The app bar's one menu: 32 px visible, 40 px to hit. Arrow keys move between items, Escape or a
 * click outside closes it, and focus goes back to the button.
 */
export function AppMenu({ items, children }: { items: readonly MenuItem[]; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    // Keys typed in the menu never reach the app's own shortcuts.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const entries = [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const next = (at + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length;
    entries[next]?.focus();
  };

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-label="Menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        // 40 px hit area around a 32 px visible button.
        className="group -m-1 inline-flex size-10 items-center justify-center rounded-full"
      >
        <span
          className={
            "inline-flex size-8 items-center justify-center rounded-full border transition-colors " +
            (open ? "border-text-2 bg-surface-strong text-text" : "border-border text-text-2 group-hover:bg-surface-strong group-hover:text-text")
          }
        >
          <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
            <path d="M3 4.5h10M3 8h10M3 11.5h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </span>
      </button>
      {open && (
        <div
          ref={list}
          role="menu"
          aria-label="Menu"
          onKeyDown={onKeyDown}
          className="sl-fade absolute right-0 top-11 z-50 flex w-72 flex-col gap-0.5 rounded-lg border border-border bg-bg/95 p-1.5 shadow-[0_24px_60px_-24px_rgba(0,0,0,0.9)] backdrop-blur-[16px]"
        >
          {children}
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                close(false);
                item.onSelect();
              }}
              className="flex items-center justify-between gap-3 rounded-sm px-3 py-2.5 text-left text-body text-text hover:bg-surface-strong focus-visible:bg-surface-strong focus-visible:outline-none"
            >
              <span className="flex flex-col">
                {item.label}
                {item.detail && <span className="text-small text-text-3">{item.detail}</span>}
              </span>
              {item.hint && <KeyHint>{item.hint}</KeyHint>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
