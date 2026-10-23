import { useEffect, useRef } from "react";
import { KeyHint, Label, Panel } from "./components";
import { SHORTCUT_GROUPS, type ShortcutGroup } from "./shortcuts";

/** The `?` menu: About and the home page, then the console's keys. */
export function ShortcutOverlay({ onClose, groups = SHORTCUT_GROUPS }: { onClose: () => void; groups?: readonly ShortcutGroup[] }) {
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    return () => previous?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <Panel
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="w-full max-w-md"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-title">Keyboard shortcuts</h2>
          <button
            ref={closeButton}
            type="button"
            onClick={onClose}
            className="rounded-sm px-2 py-1 text-small text-text-2 hover:text-text"
          >
            Close
          </button>
        </div>
        <nav aria-label="Sightline" className="mb-4 flex flex-wrap gap-2">
          <a href="#about" onClick={onClose} className="sl-tap inline-flex h-8 items-center rounded-full border border-line px-3 text-small text-text hover:bg-surface-strong">
            About Sightline
          </a>
          <a href="#" onClick={onClose} className="sl-tap inline-flex h-8 items-center rounded-full border border-line px-3 text-small text-text hover:bg-surface-strong">
            Home: choose a search
          </a>
        </nav>
        {groups.map((group) => (
          <section key={group.title} className="mb-4 last:mb-0">
            <Label>{group.title}</Label>
            <ul className="mt-2 flex flex-col gap-1.5">
              {group.shortcuts.map((s) => (
                <li key={s.description} className="flex items-center justify-between gap-4">
                  <span className="text-body text-text-2">{s.description}</span>
                  <span className="flex gap-1">
                    {s.keys.map((k) => (
                      <KeyHint key={k}>{k}</KeyHint>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </Panel>
    </div>
  );
}
