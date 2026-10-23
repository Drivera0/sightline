// "New scenario" (the demo's status line, on the right, out of the story's way): pick one of the four
// presets or shuffle for a new seed; the demo mission reloads as that scenario (`#m/demo?s=<seed>`).
import { useEffect, useRef, useState } from "react";
import { presetFor, PRESETS, shuffleSeed } from "./scenarios";

export function ScenarioMenu({ seed, onPick, disabled = false }: { seed: string | null; onPick: (seed: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const off = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", off);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", off);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  const current = presetFor(seed);
  const pick = (s: string) => {
    setOpen(false);
    onPick(s);
  };
  return (
    <span ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={disabled ? "Leave the story to change the scenario" : "Load another scenario on the same ground and photos"}
        onClick={() => setOpen(!open)}
        className="sl-tap inline-flex h-6 items-center gap-1.5 rounded-full border border-line px-2.5 text-caption text-text-2 hover:border-border hover:text-text disabled:opacity-40"
      >
        <span className="text-text-3">Scenario</span> {current.name}
      </button>
      {open && (
        <ul role="menu" aria-label="New scenario" className="fixed right-3 z-50 mt-1 w-64 rounded-lg border border-line bg-surface-solid p-1 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.9)]">
          {PRESETS.map((p) => (
            <li key={p.seed} role="none">
              <button role="menuitemradio" aria-checked={p.seed === current.seed} type="button" onClick={() => pick(p.seed)} className="sl-tap flex w-full flex-col rounded-sm px-3 py-1.5 text-left hover:bg-surface-strong">
                <span className="text-small text-text">{p.name}</span>
                <span className="text-caption text-text-3">{p.subject}</span>
              </button>
            </li>
          ))}
          <li role="none" className="mt-1 border-t border-line pt-1">
            <button role="menuitem" type="button" onClick={() => pick(shuffleSeed())} className="sl-tap w-full rounded-sm px-3 py-1.5 text-left text-small text-text hover:bg-surface-strong">
              Shuffle: a new seed
            </button>
          </li>
        </ul>
      )}
    </span>
  );
}
