// "Hear Sightline on the radio": one standard briefing in Sightline's voice (NVIDIA Magpie TTS, speaker 0,
// E-13), generated offline and served from this site, with its transcript. In the About sheet and the Debrief.
// Built by lane A.
import { useEffect, useRef, useState } from "react";
import { RADIO_CLIP } from "./copy";

/** HTMLMediaElement.HAVE_ENOUGH_DATA (4): enough is buffered to play to the end without stopping. */
const HAVE_ENOUGH_DATA = 4;

export function RadioClip({ className = "" }: { className?: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const a = audio.current;
    if (!a) return undefined;
    const on = () => setPlaying(true);
    const off = () => setPlaying(false);
    a.addEventListener("play", on);
    a.addEventListener("pause", off);
    a.addEventListener("ended", off);
    return () => {
      a.removeEventListener("play", on);
      a.removeEventListener("pause", off);
      a.removeEventListener("ended", off);
    };
  }, []);
  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (!a.paused) {
      a.pause();
      return;
    }
    // from the start each time it has ended (never part-way in), and only once enough is loaded to play
    // through, so the first word is not cut; play() can reject (autoplay rules, a missing file): the
    // button just stays on Play
    if (a.ended) a.currentTime = 0;
    let started = false;
    const go = () => {
      if (started) return;
      started = true;
      a.removeEventListener("canplaythrough", go);
      void Promise.resolve(a.play()).catch(() => setPlaying(false));
    };
    if (a.readyState >= HAVE_ENOUGH_DATA) return go();
    a.addEventListener("canplaythrough", go, { once: true });
    a.preload = "auto";
    if (a.networkState === 0 /* NETWORK_EMPTY */) a.load();
    window.setTimeout(go, 2500); // a slow network: play what has come rather than wait for ever
  };
  return (
    <div aria-label="Sightline on the radio" role="group" className={`flex flex-col gap-1.5 ${className}`}>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={toggle}
          aria-pressed={playing}
          aria-label={playing ? "Pause the radio briefing" : "Play the radio briefing"}
          className="sl-tap inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-accent bg-accent/15 text-text hover:bg-accent/25"
        >
          <svg viewBox="0 0 16 16" className="size-4" aria-hidden fill="currentColor">
            {playing ? <path d="M4 3h3v10H4zM9 3h3v10H9z" /> : <path d="M5 3l8 5-8 5z" />}
          </svg>
        </button>
        <span className="text-body text-text">
          {RADIO_CLIP.label} <span className="text-small text-text-3">· {RADIO_CLIP.detail}</span>
        </span>
      </div>
      <audio ref={audio} src={RADIO_CLIP.src} preload="none" />
      <details className="text-small text-text-2">
        <summary className="sl-tap inline-flex cursor-pointer items-center text-text-3 hover:text-text-2">Transcript</summary>
        <p className="mt-1 rounded-sm border border-line bg-surface-solid px-3 py-2 font-mono text-small text-text-2">{RADIO_CLIP.transcript}</p>
      </details>
    </div>
  );
}
