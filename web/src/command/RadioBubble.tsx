// Two voices, never mixed up (V3 §3): what goes out on the air (a briefing the agent wrote for the radio,
// a call from the desk) is a radio-styled bubble in the drone/radio teal with the callsigns in mono,
// headed "Desk → Team One"; what the agent tells the search manager (its reason) is a plain violet note,
// headed "Agent → you". Built by lane A.
import type { ReactNode } from "react";
import { Icon } from "../shell/icons";

/** The callsigns ("Team One", "Sightline", "all teams") in a radio line, set in mono. */
export function withCallsigns(text: string, callsigns: readonly string[]): ReactNode[] {
  const names = [...new Set(["Sightline", ...callsigns.filter(Boolean)])].sort((a, b) => b.length - a.length);
  if (!names.length) return [text];
  const re = new RegExp(`(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
  return text.split(re).map((part, i) =>
    names.includes(part) ? (
      <span key={i} className="font-mono text-[0.95em] text-text">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

/** A line for the air: who it goes to, the words, in a radio bubble. */
export function RadioBubble({ to, text, callsigns = [], from = "Desk", children }: { to: string; text: string; callsigns?: readonly string[]; from?: string; children?: ReactNode }) {
  return (
    <figure aria-label={`${from} to ${to}, on the radio`} className="flex flex-col gap-1">
      <figcaption className="flex items-center gap-1.5 text-caption text-[var(--c-drone)]">
        <Icon name="radio" size={12} />
        <span>
          {from} → <span className="font-mono">{to}</span>
        </span>
        <span className="text-text-3">on the radio</span>
      </figcaption>
      <blockquote className="relative rounded-md rounded-tl-sm border border-[color-mix(in_srgb,var(--c-drone)_45%,transparent)] bg-[color-mix(in_srgb,var(--c-drone)_9%,var(--bg))] px-2.5 py-1.5 text-small text-text-2">
        {withCallsigns(text, [to, ...callsigns])}
        {children}
      </blockquote>
    </figure>
  );
}

/** What the agent says to the search manager: plain, violet, never styled as radio. */
export function AgentNote({ children, label = "Agent → you" }: { children: ReactNode; label?: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-l-2 border-[var(--c-proposal)] pl-2">
      <span className="text-caption font-medium text-[var(--c-proposal)]">{label}</span>
      <div className="text-small text-text-2">{children}</div>
    </div>
  );
}
