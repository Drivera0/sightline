import { useEffect, useRef } from "react";
import { KeyHint, Label, Panel } from "./components";
import { SHORTCUT_GROUPS, type ShortcutGroup } from "./shortcuts";

/** `groups`: the ones that apply on this page (a mission page leaves out the guided demo's steps). */
export function ShortcutOverlay({ onClose, onTour, groups = SHORTCUT_GROUPS }: { onClose: () => void; onTour?: () => void; groups?: readonly ShortcutGroup[] }) {
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
        className="w-full max-w-md bg-bg/90"
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
        {onTour && (
          <button
            type="button"
            onClick={onTour}
            className="mb-5 flex w-full items-center justify-between gap-3 rounded-sm border border-accent/50 bg-accent/10 px-4 py-3 text-left hover:bg-accent/20"
          >
            <span className="flex flex-col">
              <span className="text-body text-text">Watch the 60-second tour</span>
              <span className="text-small text-text-2">The six steps, played for you with captions</span>
            </span>
            <KeyHint>T</KeyHint>
          </button>
        )}
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
