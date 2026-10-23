// The demo's radio voices (contract 15.7, `TimelineEntry.audio`): plays a radio line's clip when the
// line lands on the timeline. Teams speak in Magpie's speakers 1-4, the desk in speaker 0
// (scripts/make_voice_fixture.py). Mount it next to the timeline with the lines shown so far:
//
//   <RadioAudio entries={visibleTimeline} />
//
// - Lines already there when it mounts are history: they never play.
// - Nothing plays before the user has clicked, tapped or pressed a key on the page (browsers block
//   autoplay, and a page should not start talking on its own); lines that land before that stay silent.
// - One clip at a time, in the order the lines landed; the mute toggle stops the one playing.
// - Muted is remembered in this browser (localStorage, best effort).
import { useEffect, useRef, useState } from "react";
import type { TimelineEntry } from "../contract";

const MUTE_KEY = "sightline.radioAudio.muted";

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    // private window or blocked storage: the toggle still works for this visit
  }
}

/** The clip's URL under the site's base (`audio` is a path under web/public, e.g. "voices/demo/r0004.mp3"). */
export function audioUrl(audio: string, base: string = import.meta.env.BASE_URL ?? "/"): string {
  if (/^(https?:)?\/\//.test(audio) || audio.startsWith("/")) return audio;
  return `${base.endsWith("/") ? base : `${base}/`}${audio}`;
}

export interface RadioAudioProps {
  /** The timeline lines shown so far, oldest first. Only radio lines with `audio` can play. */
  entries: readonly TimelineEntry[];
  /** Site base for the clips (default: Vite's BASE_URL). */
  base?: string;
  className?: string;
}

export function RadioAudio({ entries, base, className }: RadioAudioProps) {
  const [muted, setMuted] = useState(readMuted);
  const [playing, setPlaying] = useState<string | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const gesture = useRef(false);
  const queue = useRef<TimelineEntry[]>([]);
  const current = useRef<HTMLAudioElement | null>(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  // A user gesture anywhere on the page unlocks playback (never before it).
  useEffect(() => {
    const unlock = () => {
      gesture.current = true;
    };
    window.addEventListener("pointerdown", unlock, { capture: true });
    window.addEventListener("keydown", unlock, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", unlock, { capture: true });
      window.removeEventListener("keydown", unlock, { capture: true });
    };
  }, []);

  const playNext = () => {
    if (current.current || mutedRef.current) return;
    const next = queue.current.shift();
    if (!next?.audio) {
      setPlaying(null);
      return;
    }
    const el = new Audio(audioUrl(next.audio, base));
    current.current = el;
    setPlaying(next.id);
    const done = () => {
      if (current.current === el) current.current = null;
      playNext();
    };
    el.addEventListener("ended", done);
    el.addEventListener("error", done);
    try {
      const p = el.play();
      if (p && typeof p.catch === "function") p.catch(done);
    } catch {
      done();
    }
  };

  useEffect(() => {
    if (seen.current === null) {
      seen.current = new Set(entries.map((e) => e.id)); // history: never played
      return;
    }
    const fresh = entries.filter((e) => !seen.current!.has(e.id));
    for (const e of fresh) seen.current.add(e.id);
    if (!gesture.current || mutedRef.current) return;
    const clips = fresh.filter((e) => e.kind === "radio" && e.audio);
    if (!clips.length) return;
    queue.current.push(...clips);
    playNext();
  }, [entries]);

  useEffect(
    () => () => {
      current.current?.pause();
      current.current = null;
      queue.current = [];
    },
    [],
  );

  const toggle = () => {
    gesture.current = true;
    const next = !muted;
    setMuted(next);
    mutedRef.current = next;
    writeMuted(next);
    if (next) {
      current.current?.pause();
      current.current = null;
      queue.current = [];
      setPlaying(null);
    }
  };

  return (
    <button
      type="button"
      className={className ?? "text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"}
      aria-pressed={!muted}
      aria-label={muted ? "Radio voices off: turn on" : "Radio voices on: mute"}
      title="Team voices are synthetic (Magpie TTS); the desk is Sightline's voice"
      onClick={toggle}
      data-playing={playing ?? undefined}
    >
      {muted ? "Voices off" : playing ? "Voices on (playing)" : "Voices on"}
    </button>
  );
}
