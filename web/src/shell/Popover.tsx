import { useEffect, useId, useRef, useState, type ReactNode } from "react";

type Side = "top" | "bottom";
type Align = "start" | "center" | "end";

const ALIGN: Record<Align, string> = {
  start: "left-0",
  center: "left-1/2 -translate-x-1/2",
  end: "right-0",
};

/**
 * A small note that opens on hover, on keyboard focus and on tap (so it works without a mouse),
 * and closes on Escape, on a tap elsewhere or when the pointer leaves.
 */
export function Popover({
  trigger,
  children,
  label,
  side = "top",
  align = "center",
  triggerClassName = "",
}: {
  trigger: ReactNode;
  children: ReactNode;
  /** Accessible name for the trigger when its content is not text (an (i) icon). */
  label?: string;
  side?: Side;
  align?: Align;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span
      ref={root}
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className={
            "sl-fade absolute z-50 w-64 max-w-[80vw] rounded-sm border border-border bg-bg/95 px-3 py-2 text-left text-small font-normal normal-case tracking-normal text-text-2 shadow-[0_16px_40px_-16px_rgba(0,0,0,0.9)] backdrop-blur-[16px] " +
            ALIGN[align] +
            (side === "top" ? " bottom-full mb-2" : " top-full mt-2")
          }
        >
          {children}
        </span>
      )}
    </span>
  );
}

/**
 * A number with its source, reachable without a mouse: a dotted underline that opens the source on
 * hover, keyboard focus or tap. Replaces `title=` tooltips, which touch screens never show.
 */
export function Sourced({
  source,
  children,
  side = "top",
  align = "start",
}: {
  source: string;
  children: ReactNode;
  side?: Side;
  align?: Align;
}) {
  return (
    <Popover
      side={side}
      align={align}
      trigger={children}
      triggerClassName="cursor-help text-left [font:inherit] [color:inherit] underline decoration-text-3 decoration-dotted decoration-1 underline-offset-[0.2em] hover:decoration-text-2"
    >
      <span className="block text-caption font-medium text-text-3">Source</span>
      {source}
    </Popover>
  );
}

/** A round (i) that opens a longer explanation. */
export function InfoTip({ label, children, side, align }: { label: string; children: ReactNode; side?: Side; align?: Align }) {
  return (
    <Popover
      label={label}
      side={side}
      align={align}
      triggerClassName="inline-flex size-5 items-center justify-center rounded-full border border-border text-caption leading-none text-text-3 hover:border-text-2 hover:text-text"
      trigger={<span aria-hidden="true">i</span>}
    >
      {children}
    </Popover>
  );
}
