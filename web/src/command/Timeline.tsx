// The timeline (COMMAND_POST.md §5, along the bottom): one stream of what happened, newest first, with
// filter chips (All, Radio, Clues, Drone, Decisions). Radio turns with Reply (it addresses the talk bar to
// that team), clues awaiting read-back with Confirm, a clue's Show on map, detections, decisions (the
// agent's and the search manager's direct actions alike), check-ins, drone legs. The talk bar under it is
// the radio desk: hold V to talk to the team picked, or type. Add a clue is here too. Built by lane A.
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { ClueDraft, MissionEvent, Team, TimelineEvent } from "../contract";
import { useClock } from "../lib/time";
import { useSelection } from "../lib/selection";
import { Button, KeyHint } from "../shell/components";
import { Icon, type IconName } from "../shell/icons";
import { useConsole } from "./consoleStore";
import { withCallsigns } from "./RadioBubble";
import { buildTimeline, FILTERS, inFilter, type Entry, type EntryKind } from "./timeline";

const ICON: Record<EntryKind, IconName> = {
  radio: "radio", clue: "clue", detection: "detection", decision: "decision", checkin: "checkin", drone: "drone", found: "found", note: "note",
};
const btn = "sl-tap inline-flex h-6 items-center rounded-full border border-line px-2 text-caption text-text-2 hover:border-border hover:text-text";
/** The newest this many; the Trace view's event log has them all. */
export const TIMELINE_LIMIT = 120;
/** Each kind's colour (theme.css, the v3 colour block): a new row's highlight is in it. */
const KIND_COLOUR: Record<EntryKind, string> = {
  radio: "var(--team)", checkin: "var(--team)", clue: "var(--clue)", detection: "var(--accent)", decision: "var(--proposal)",
  drone: "var(--drone)", found: "var(--found)", note: "var(--text-2)",
};
/** How long a new row stays highlighted (ms; theme.css --motion-row). */
export const ROW_NEW_MS = 3000;

/**
 * Which rows are new: those that came after the timeline first drew (not the ones it opened with), each
 * for ROW_NEW_MS; `mark` highlights one on demand ("Show me").
 */
function useFreshRows(all: readonly Entry[]): { has: (id: string) => boolean; mark: (id: string) => void } {
  const known = useRef<Set<string> | null>(null);
  const since = useRef(new Map<string, number>());
  const [, tick] = useState(0);
  const now = Date.now();
  if (known.current === null) known.current = new Set(all.map((e) => e.id));
  else
    for (const e of all)
      if (!known.current.has(e.id)) {
        known.current.add(e.id);
        since.current.set(e.id, now);
      }
  const newest = Math.max(0, ...since.current.values());
  useEffect(() => {
    // drop the highlight once it has faded (reduced motion shows it still, so it must go)
    const left = newest + ROW_NEW_MS - Date.now();
    if (left <= 0) return undefined;
    const timer = window.setTimeout(() => tick((n) => n + 1), left + 20);
    return () => window.clearTimeout(timer);
  }, [newest]);
  return {
    has: (id) => now - (since.current.get(id) ?? -Infinity) < ROW_NEW_MS,
    mark: (id) => {
      since.current.set(id, Date.now());
      tick((n) => n + 1);
    },
  };
}

export function Timeline({
  events,
  server = [],
  teams,
  onConfirmClue,
  talk,
  clueForm,
}: {
  events: readonly MissionEvent[];
  server?: readonly TimelineEvent[];
  teams: readonly Team[];
  onConfirmClue: (clueId: string) => void;
  /** The talk bar (TalkBar), under the stream. */
  talk: ReactNode;
  /** The Add a clue form, opened from the header. */
  clueForm: (close: () => void, at: { lat: number; lon: number } | null) => ReactNode;
}) {
  const filter = useConsole((s) => s.filter);
  // Add clue: the header's button, the map's right-click or long-press, a hint's action (consoleStore.clue)
  const clue = useConsole((s) => s.clue);
  const adding = clue.open;
  const setAdding = (open: boolean) => (open ? useConsole.getState().openClue(null) : useConsole.getState().closeClue());
  const { time } = useClock();
  const all = useMemo(() => buildTimeline(events, teams, server), [events, teams, server]);
  const shown = all.filter((e) => inFilter(e, filter)).slice(0, TIMELINE_LIMIT);
  const fresh = useFreshRows(all);
  const callsigns = useMemo(() => teams.map((t) => t.callsign), [teams]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f, all.filter((e) => inFilter(e, f)).length])) as Record<(typeof FILTERS)[number], number>, [all]);
  const list = useRef<HTMLOListElement>(null);
  // "Show me" on a radio call: its row, brought into view and highlighted
  const row = useConsole((s) => s.row);
  useEffect(() => {
    if (!row) return;
    const e = all.find((x) => x.id === row.ref || x.refs.includes(row.ref));
    if (!e) return;
    fresh.mark(e.id);
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(e.id)}"]`)?.scrollIntoView?.({ block: "nearest" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row]);
  const reply = (e: Entry) => {
    if (!e.team) return;
    const cs = teams.find((t) => t.id === e.team)?.callsign ?? e.team;
    useConsole.getState().talk(e.team, `${cs}, Sightline. `);
  };
  return (
    <section aria-label="Timeline" data-tour="timeline" className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-surface-solid">
      <div className="sl-panel-head">
        <h2>Timeline</h2>
        <div role="group" aria-label="Show" className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => useConsole.getState().setFilter(f)}
              className={`sl-tap h-6 rounded-full px-2.5 text-caption font-normal ${filter === f ? "bg-surface-strong text-text shadow-[inset_0_0_0_1px_var(--border)]" : "text-text-2 hover:text-text"}`}
            >
              {f}
              {f !== "All" && (
                <span aria-hidden className="ml-1 text-text-3">
                  {counts[f]}
                </span>
              )}
            </button>
          ))}
        </div>
        <Button
          aria-expanded={adding}
          onClick={() => setAdding(!adding)}
          title="Add a clue: what was found, who reported it, how reliable. Or right-click (long-press) the map where it was."
          className="ml-auto h-7! gap-1.5! border-[color-mix(in_srgb,var(--clue)_60%,transparent)]! px-3! text-caption! font-normal"
        >
          <Icon name="clue" size={13} className="text-[var(--clue)]" />
          Add clue
        </Button>
      </div>
      {adding && (
        <div key={clue.n} className="sl-slide-in border-b border-line p-2">
          {clueForm(() => setAdding(false), clue.at)}
        </div>
      )}
      <ol ref={list} aria-label="Timeline entries" className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {shown.length === 0 && <li className="px-2 py-2 text-small text-text-3">Nothing here yet.</li>}
        {shown.map((e) => (
          <li
            key={e.id}
            data-kind={e.kind}
            data-entry={e.id}
            data-new={fresh.has(e.id) || undefined}
            style={{ ["--c" as string]: KIND_COLOUR[e.kind] }}
            className={`group flex items-start gap-3 rounded-sm border-b border-line px-2 py-1.5 last:border-b-0 hover:bg-surface ${fresh.has(e.id) ? "sl-row-new" : ""}`}
          >
            <span className="w-12 shrink-0 pt-0.5 text-caption text-text-3" title={e.at}>
              {time(e.at)}
            </span>
            <Icon name={ICON[e.kind]} size={15} className="mt-[3px] shrink-0 text-[var(--c)]" />
            <span className="min-w-0 flex-1">
              {e.kind === "radio" ? (
                // the air: a radio line, callsigns in mono; the desk's own calls in a teal bubble
                <span
                  className={`text-small text-text ${e.turn?.direction === "out" ? "rounded-sm rounded-tl-none border border-[color-mix(in_srgb,var(--drone)_40%,transparent)] bg-[color-mix(in_srgb,var(--drone)_8%,transparent)] px-1.5 py-px" : ""}`}
                >
                  {withCallsigns(e.text, callsigns)}
                </span>
              ) : (
                <span className={`text-small ${e.kind === "note" ? "text-text-2" : "text-text"}`}>{e.text}</span>
              )}
              {e.repeats > 1 && <span className="ml-1.5 text-caption text-text-3" title={`${e.repeats} times; the newest shown`}>×{e.repeats}</span>}
              {e.detail && <span className="block line-clamp-2 text-caption text-text-3" title={e.detail}>{e.detail}</span>}
            </span>
            <span className="flex shrink-0 gap-1">
              {e.kind === "radio" && e.team && (
                <button type="button" className={btn} onClick={() => reply(e)}>
                  Reply
                </button>
              )}
              {e.clue && (
                <button type="button" className={btn} onClick={() => onConfirmClue(e.clue!.id)}>
                  Confirm
                </button>
              )}
              {e.kind === "clue" && e.refs[0] && (
                <button type="button" className={btn} onClick={() => useSelection.getState().selectClue(e.refs[0]!)}>
                  Show on map
                </button>
              )}
            </span>
          </li>
        ))}
      </ol>
      {talk}
    </section>
  );
}

/** Hold-to-talk for a live radio desk (null on the demo, which has no radio server: typing works there). */
export interface TalkVoice {
  /** Start recording; resolves when the microphone is open. */
  press: (team: string) => Promise<void>;
  /** Stop and send; resolves when the reply has played. */
  release: () => Promise<void>;
  stage: "idle" | "recording" | "sending" | "speaking";
  error: string | null;
}

export function TalkBar({ teams, onSend, voice = null }: { teams: readonly Team[]; onSend: (team: string, text: string) => void | Promise<void>; voice?: TalkVoice | null }) {
  const { talkTo, talkFocus, talkDraft } = useConsole();
  const to = talkTo && teams.some((t) => t.id === talkTo) ? talkTo : (teams[0]?.id ?? "");
  const [text, setText] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const holding = useRef(false);
  // Call on a card: the bar says who it is calling, in the team colour, for a moment
  const [calling, setCalling] = useState(false);
  useEffect(() => {
    if (!talkFocus) return undefined;
    setText(talkDraft);
    field.current?.focus();
    setCalling(true);
    const timer = window.setTimeout(() => setCalling(false), 2400);
    return () => window.clearTimeout(timer);
  }, [talkFocus, talkDraft]);
  // Hold V to talk, unless typing in a field
  useEffect(() => {
    const typing = (el: Element | null) => !!el && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
    const down = (e: KeyboardEvent) => {
      if ((e.key !== "v" && e.key !== "V") || e.repeat || e.ctrlKey || e.metaKey || e.altKey || typing(document.activeElement)) return;
      e.preventDefault();
      start();
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "v" || e.key === "V") void stop();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  });
  const start = () => {
    if (holding.current || !to) return;
    holding.current = true;
    if (voice) void voice.press(to);
    else setHint("Talking needs the radio server; on the demo, type the call.");
  };
  const stop = async () => {
    if (!holding.current) return;
    holding.current = false;
    if (voice) await voice.release();
    else field.current?.focus();
  };
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || !to) return;
    void onSend(to, text.trim());
    setText("");
    setHint(null);
  };
  const recording = voice?.stage === "recording";
  return (
    <form
      onSubmit={send}
      aria-label="Talk"
      style={{ ["--c" as string]: "var(--team)" }}
      className={`flex shrink-0 flex-wrap items-center gap-2 border-t border-line p-2 transition-colors ${calling ? "bg-[color-mix(in_srgb,var(--team)_10%,transparent)]" : ""}`}
    >
      <button
        type="button"
        aria-pressed={recording}
        onPointerDown={(e) => {
          e.preventDefault();
          start();
        }}
        onPointerUp={() => void stop()}
        onPointerLeave={() => void stop()}
        className={`sl-tap inline-flex h-8 items-center gap-2 rounded-full border px-3 text-small ${recording ? "border-accent bg-accent/20 text-text" : "border-border text-text hover:border-text-2"}`}
      >
        <Icon name="radio" size={14} />
        {recording ? "Release to send" : voice?.stage === "sending" ? "Sending…" : voice?.stage === "speaking" ? "Speaking…" : "Hold to talk"} <KeyHint>V</KeyHint>
      </button>
      <label className="flex items-center gap-1.5 text-caption text-text-2">
        {calling ? <span className="font-medium text-[var(--team)]">Calling</span> : "to"}
        <select aria-label="Recipient" value={to} onChange={(e) => useConsole.getState().setTalkTo(e.target.value)} className={`h-8 rounded-sm border bg-surface-strong px-2 font-mono text-small text-text ${calling ? "sl-new border-[var(--team)]" : "border-border"}`}>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.callsign}
            </option>
          ))}
        </select>
      </label>
      <input
        ref={field}
        aria-label="Message"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="or type the call…"
        className="h-8 min-w-40 flex-1 rounded-sm border border-border bg-surface-strong px-2.5 text-small text-text placeholder:text-text-3"
      />
      <Button type="submit" variant="secondary" className="h-8! px-3!" disabled={!text.trim()}>
        Send
      </Button>
      {(hint || voice?.error) && (
        <p role="status" className="basis-full text-caption text-text-3">
          {voice?.error ?? hint}
        </p>
      )}
    </form>
  );
}

const KINDS: ClueDraft["kind"][] = ["object", "track", "sighting", "sound", "other"];

/** What's wrong with a clue before it's sent (LANE_E §9 test 5), or null. */
export function clueProblem(text: string, where: "team" | "latlon", lat: string, lon: string, radius: string): string | null {
  if (!text.trim()) return "Say what was found.";
  if (where === "latlon") {
    const [a, o] = [Number(lat), Number(lon)];
    if (lat.trim() === "" || !Number.isFinite(a) || a < -90 || a > 90) return "Latitude must be a number from -90 to 90.";
    if (lon.trim() === "" || !Number.isFinite(o) || o < -180 || o > 180) return "Longitude must be a number from -180 to 180.";
  }
  if (radius.trim() !== "" && !(Number(radius) > 0)) return "The radius must be more than 0 m (or empty for the default).";
  return null;
}

/** Add a clue: what, where (a team's position or a point, picked on the map), how far it could be, how reliable. */
export function ClueForm({
  teams,
  onAddClue,
  onPickOnMap,
  onDone,
  at = null,
}: {
  teams: readonly Team[];
  onAddClue: (draft: ClueDraft) => void | Promise<void>;
  onPickOnMap?: () => Promise<{ lat: number; lon: number } | null>;
  onDone: () => void;
  /** A point picked on the map (right-click, long-press): the clue is there. */
  at?: { lat: number; lon: number } | null;
}) {
  const [kind, setKind] = useState<ClueDraft["kind"]>("object");
  const [text, setText] = useState("");
  const [where, setWhere] = useState<"team" | "latlon">(at ? "latlon" : "team");
  const [team, setTeam] = useState(teams[0]?.id ?? "");
  const [lat, setLat] = useState(at ? at.lat.toFixed(6) : "");
  const [lon, setLon] = useState(at ? at.lon.toFixed(6) : "");
  // who reported it: the team whose position it is, else command, unless chosen
  const [reporter, setReporter] = useState<string | null>(null);
  const reportedBy = reporter ?? (where === "team" ? team : "command");
  const [reliability, setReliability] = useState<ClueDraft["reliability"]>("medium");
  const [radius, setRadius] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const field = "h-8 rounded-sm border border-border bg-surface-strong px-2 text-small text-text";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const why = clueProblem(text, where, lat, lon, radius);
    setProblem(why);
    if (why) return;
    try {
      await onAddClue({
        kind, text: text.trim(), lat: where === "latlon" ? Number(lat) : null, lon: where === "latlon" ? Number(lon) : null,
        at_team_position: where === "team", radius_m: radius.trim() ? Number(radius) : null, reliability,
        reported_by: reportedBy, source: "form", confirmed_by_turn: null,
      });
      setText("");
      onDone();
    } catch {
      /* the page shows the error */
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2" aria-label="Add clue">
      <select aria-label="Kind" className={field} value={kind} onChange={(e) => setKind(e.target.value as ClueDraft["kind"])}>
        {KINDS.map((k) => (
          <option key={k}>{k}</option>
        ))}
      </select>
      <input aria-label="What" autoFocus className={`${field} min-w-48 flex-1`} placeholder="What was found: blue backpack by the creek" value={text} onChange={(e) => setText(e.target.value)} />
      <label className="flex items-center gap-1.5 text-caption text-text-2">
        reported by
        <select aria-label="Reported by" className={field} value={reportedBy} onChange={(e) => setReporter(e.target.value)}>
          <option value="command">Command (entered here)</option>
          <option value="public">Public or family</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.callsign}
            </option>
          ))}
        </select>
      </label>
      <select aria-label="Where" className={field} value={where} onChange={(e) => setWhere(e.target.value as "team" | "latlon")}>
        <option value="team">at a team's position</option>
        <option value="latlon">at lat/lon</option>
      </select>
      {where === "team" ? (
        <select aria-label="Team" className={field} value={team} onChange={(e) => setTeam(e.target.value)}>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.callsign}
            </option>
          ))}
        </select>
      ) : (
        <>
          <input aria-label="Latitude" className={`${field} w-28 font-mono`} value={lat} onChange={(e) => setLat(e.target.value)} />
          <input aria-label="Longitude" className={`${field} w-28 font-mono`} value={lon} onChange={(e) => setLon(e.target.value)} />
          {onPickOnMap && (
            <button
              type="button"
              className="sl-tap h-8 rounded-full border border-border px-3 text-small text-text-2"
              onClick={async () => {
                const p = await onPickOnMap();
                if (p) {
                  setLat(p.lat.toFixed(6));
                  setLon(p.lon.toFixed(6));
                }
              }}
            >
              Pick on map
            </button>
          )}
        </>
      )}
      <input aria-label="Radius (m)" className={`${field} w-24`} inputMode="numeric" placeholder="radius m" title="How far from the point it could be. Empty: the default for its kind (object 30 m … sound 200 m)." value={radius} onChange={(e) => setRadius(e.target.value)} />
      <span role="radiogroup" aria-label="Reliability" className="inline-flex h-8 items-center gap-0.5 rounded-full border border-border p-0.5 text-caption">
        {(["low", "medium", "high"] as const).map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={reliability === r}
            onClick={() => setReliability(r)}
            className={`h-full rounded-full px-2.5 ${reliability === r ? "bg-surface-strong text-text shadow-[inset_0_0_0_1px_var(--clue)]" : "text-text-2 hover:text-text"}`}
          >
            {r}
          </button>
        ))}
      </span>
      <Button type="submit" className="h-8! px-3!">
        Add
      </Button>
      {problem && (
        <p role="alert" className="basis-full text-small text-warn">
          {problem}
        </p>
      )}
    </form>
  );
}
