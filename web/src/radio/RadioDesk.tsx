// The radio desk (LANE_E §8): Sightline on the secondary voice channel. The operator holds to talk
// (or types, with no microphone), Sightline answers by voice; approved briefings wait in the outbound
// queue until the operator presses Transmit. Nothing is ever transmitted that wasn't approved.

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { KeyHint, Label, Panel, StatusPill, type Tone } from "../shell/components";
import { useClock } from "../lib/time";
import * as defaultApi from "./api";
import { isStandby, type OutboundItem, type RadioApi, type RadioTurn, type TurnResponse, type TurnStandby } from "./api";
import { playChunks as defaultPlay } from "./player";
import { MicDenied, startRecording as defaultRecord, type Recording } from "./recorder";
import { DEMO_TEAMS, useRadio, type LoggedTurn, type Team } from "./store";

/** Shown on the screen and in both reports (LANE_E §8.1). */
export const SAFETY_FRAME =
  "Sightline's radio desk runs on a secondary channel under the comms operator. It never initiates orders and never transmits unsupervised: it relays only information the search manager has approved, and the operator presses Transmit. Teams can ask it questions and report clues; a clue is committed only after Sightline reads it back and the team confirms. Every exchange is logged in the mission record.";

const STATE_WORDS: Record<RadioTurn["state"], string> = {
  answered: "Answered",
  awaiting_confirm: "Awaiting confirmation",
  committed: "Clue logged",
  discarded: "Clue discarded",
  transmitted: "Transmitted",
  say_again: "Say again",
};

const STATE_TONE: Record<RadioTurn["state"], Tone> = {
  answered: "neutral",
  awaiting_confirm: "caution",
  committed: "ok",
  discarded: "muted",
  transmitted: "ok",
  say_again: "caution",
};

const POLL_MS = 300;
const POLL_LIMIT_MS = 60_000;

export interface RadioDeps {
  postTurn: typeof defaultApi.postTurn;
  pollTurn: typeof defaultApi.pollTurn;
  getOutbound: typeof defaultApi.getOutbound;
  transmit: typeof defaultApi.transmit;
  skip: typeof defaultApi.skip;
  startRecording: () => Promise<Recording>;
  playChunks: (urls: string[], radioSound: boolean) => Promise<void>;
}

const DEFAULT_DEPS: RadioDeps = {
  postTurn: defaultApi.postTurn,
  pollTurn: defaultApi.pollTurn,
  getOutbound: defaultApi.getOutbound,
  transmit: defaultApi.transmit,
  skip: defaultApi.skip,
  startRecording: defaultRecord,
  playChunks: defaultPlay,
};

const ms = (v: number | null | undefined) => (v == null ? "–" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);
/** The reply's first sentence: 0 ms means its voice came from the cache of common openers. */
const voice = (v: number | null) => (v === 0 ? "cached" : ms(v));
/** Below this peak level the clip is silence (wrong input device, muted mic). */
const SILENT = 0.03;
const isTyping = (el: Element | null) => !!el && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);

export function RadioDesk({
  api,
  teams = DEMO_TEAMS,
  operator = "Comms operator",
  channel = "Channel 2",
  deps = DEFAULT_DEPS,
}: {
  api: RadioApi;
  teams?: Team[];
  operator?: string;
  channel?: string;
  deps?: RadioDeps;
}) {
  const { stage, turns, outbound, speakingAs, radioSound, error, micDenied } = useRadio();
  const r = useRadio.getState;
  const { time } = useClock();
  const [text, setText] = useState("");
  const recording = useRef<Recording | null>(null);
  const [level, setLevel] = useState(0);
  const peak = useRef(0);
  // When the operator sent the turn and when the first sound (reply or standby) started playing.
  const sentAt = useRef<number | null>(null);
  const heardAt = useRef<number | null>(null);
  const callsign = useCallback((id: string | null) => teams.find((t) => t.id === id)?.callsign ?? id ?? "Unknown", [teams]);

  const refreshOutbound = useCallback(async () => {
    try {
      r().setOutbound(await deps.getOutbound(api));
    } catch (e) {
      r().setError(`Outbound queue: ${(e as Error).message}`);
    }
  }, [api, deps, r]);

  useEffect(() => {
    void refreshOutbound();
    const id = setInterval(() => void refreshOutbound(), 10_000);
    return () => clearInterval(id);
  }, [refreshOutbound]);

  /** Show the turn, then play its reply. */
  const received = useCallback(
    async (res: TurnResponse, skipOpener = false) => {
      const { clue: _clue, audio_chunks, ...turn } = res;
      heardAt.current ??= performance.now();
      const heard_ms = sentAt.current == null ? null : Math.round(heardAt.current - sentAt.current);
      r().addTurn({ ...turn, heard_ms });
      r().setStage("speaking");
      // After "<Callsign>, Sightline. Standby." the answer's own opening chunk would repeat it.
      const chunks = skipOpener ? audio_chunks.slice(1) : audio_chunks;
      try {
        await deps.playChunks(chunks.map((p) => defaultApi.chunkUrl(api, p)), r().radioSound);
      } catch (e) {
        r().setError(`Playback: ${(e as Error).message}`);
      }
      r().setStage("idle");
    },
    [api, deps, r],
  );

  /** The model is slow: play "standby" now, then wait for the answer and play that. */
  const standby = useCallback(
    async (res: TurnStandby) => {
      r().setStage("standby");
      heardAt.current = performance.now();
      const playing = deps
        .playChunks(res.audio_chunks.map((p) => defaultApi.chunkUrl(api, p)), r().radioSound)
        .catch(() => {});
      const started = Date.now();
      let answer: TurnResponse | null = null;
      while (!answer) {
        if (Date.now() - started > POLL_LIMIT_MS) throw new Error("No answer from the model after 60 s.");
        await new Promise((ok) => setTimeout(ok, POLL_MS));
        answer = await deps.pollTurn(api, res.poll);
      }
      await playing;
      const opener = res.reply.replace(/\s*Standby\.$/, "");
      await received(answer, !!answer.reply && answer.audio_chunks.length > 1 && answer.reply.startsWith(opener));
    },
    [api, deps, r, received],
  );

  const send = useCallback(
    async (input: { audio: Blob } | { text: string }) => {
      r().setError(null);
      r().setStage("sending");
      sentAt.current = performance.now();
      heardAt.current = null;
      try {
        const res = await deps.postTurn(api, input, r().speakingAs);
        await (isStandby(res) ? standby(res) : received(res));
      } catch (e) {
        r().setError((e as Error).message);
        r().setStage("idle");
      }
    },
    [api, deps, r, received, standby],
  );

  const pressTalk = useCallback(async () => {
    if (r().stage !== "idle" || recording.current) return;
    try {
      recording.current = await deps.startRecording();
      peak.current = 0;
      r().setStage("recording");
    } catch (e) {
      if (e instanceof MicDenied) r().setMicDenied(true);
      r().setError((e as Error).message);
    }
  }, [deps, r]);

  const releaseTalk = useCallback(async () => {
    const rec = recording.current;
    recording.current = null;
    if (!rec) return;
    setLevel(0);
    const audio = await rec.stop();
    await send({ audio });
    // After send: it clears errors first. The clip still goes out (Sightline will ask to say again).
    if (rec.level && peak.current < SILENT) r().setError("No sound from the microphone: check the input device.");
  }, [send, r]);

  // Level meter while recording.
  useEffect(() => {
    if (stage !== "recording") return;
    let frame = 0;
    const tick = () => {
      const v = recording.current?.level?.() ?? 0;
      peak.current = Math.max(peak.current, v);
      setLevel(v);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [stage]);

  // Hold V to talk (not T: that's the tour key), unless typing in a field.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.key === "v" || e.key === "V") && !e.repeat && !isTyping(document.activeElement)) void pressTalk();
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "v" || e.key === "V") void releaseTalk();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [pressTalk, releaseTalk]);

  const submitText = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || stage !== "idle") return;
    void send({ text: text.trim() });
    setText("");
  };

  const doTransmit = async (item: OutboundItem) => {
    r().setError(null);
    r().setStage("sending");
    sentAt.current = performance.now();
    heardAt.current = null;
    try {
      await received(await deps.transmit(api, item.id));
    } catch (e) {
      r().setError((e as Error).message);
      r().setStage("idle");
    }
    await refreshOutbound();
  };

  const doSkip = async (item: OutboundItem) => {
    await deps.skip(api, item.id);
    await refreshOutbound();
  };

  const pending = [...turns].reverse().find((t) => t.direction === "in" && t.callsign);
  const awaiting = pending?.state === "awaiting_confirm" ? pending : null;
  const stageWord = {
    idle: "Ready",
    recording: "Recording…",
    sending: "Transcribing and thinking…",
    standby: "Standby sent · thinking…",
    speaking: "Speaking…",
  }[stage];

  return (
    <Panel className="flex flex-col gap-4" aria-label="Radio desk">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <Label>Radio desk</Label>
          <span className="text-body text-text">
            {channel} · Sightline relay · Operator: {operator}
          </span>
        </div>
        <label className="flex items-center gap-2 text-small text-text-2">
          <input type="checkbox" checked={radioSound} onChange={(e) => r().setRadioSound(e.target.checked)} />
          Radio sound
        </label>
      </header>
      <p className="text-small text-text-3">{SAFETY_FRAME}</p>

      <section className="flex flex-wrap items-center gap-3" aria-label="Talk">
        <button
          type="button"
          className="rounded-full border border-accent bg-accent/15 px-6 py-3 text-body text-text disabled:opacity-50"
          disabled={stage === "sending" || stage === "standby" || stage === "speaking"}
          onMouseDown={() => void pressTalk()}
          onMouseUp={() => void releaseTalk()}
          onMouseLeave={() => stage === "recording" && void releaseTalk()}
          onTouchStart={(e) => {
            e.preventDefault();
            void pressTalk();
          }}
          onTouchEnd={() => void releaseTalk()}
        >
          {stage === "recording" ? "Release to send" : "Hold to talk"} <KeyHint>V</KeyHint>
        </button>
        <label className="flex items-center gap-2 text-small text-text-2">
          Speaking as
          <select
            className="rounded-sm border border-border bg-surface-strong px-2 py-1 text-small text-text"
            value={speakingAs}
            onChange={(e) => r().setSpeakingAs(e.target.value)}
          >
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.callsign}
              </option>
            ))}
          </select>
        </label>
        {stage === "recording" && (
          <span
            role="meter"
            aria-label="Microphone level"
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={Number(level.toFixed(2))}
            className="h-2 w-24 overflow-hidden rounded-full bg-surface-strong"
          >
            <span className="block h-full bg-accent transition-[width] duration-75" style={{ width: `${Math.round(level * 100)}%` }} />
          </span>
        )}
        <span role="status" className="font-mono text-small text-text-2">
          {stageWord}
        </span>
      </section>

      <form onSubmit={submitText} className="flex gap-2" aria-label="Type instead of speaking">
        <input
          className="min-w-0 flex-1 rounded-sm border border-border bg-surface-strong px-3 py-2 text-body text-text"
          placeholder={micDenied ? "No microphone: type what the team says" : "Or type what the team says"}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="rounded-full border border-border px-4 py-2 text-small text-text" disabled={stage !== "idle"}>
          Send
        </button>
      </form>

      {error && (
        <p role="alert" className="text-small text-caution">
          {error}
        </p>
      )}

      {awaiting && (
        <div className="rounded-sm border border-caution/40 bg-surface-solid p-3" aria-label="Awaiting confirmation">
          <Label className="text-caution!">Awaiting confirmation from {callsign(awaiting.callsign)}</Label>
          <p className="text-body text-text">{awaiting.reply}</p>
          <p className="text-small text-text-3">Nothing is logged until the team says "affirmative".</p>
        </div>
      )}

      <section aria-label="Outbound queue" className="flex flex-col gap-2">
        <Label>Outbound · approved by the search manager</Label>
        {outbound.length === 0 && <p className="text-small text-text-3">Nothing waiting to be transmitted.</p>}
        {outbound.map((o) => (
          <div key={o.id} className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-line bg-surface-solid p-3">
            <div className="flex min-w-0 flex-col">
              <span className="text-small text-text-2">
                To {o.target.team === "all" ? "all teams" : callsign(o.target.team ?? null)} · {o.summary}
              </span>
              <span className="text-body text-text">{o.briefing}</span>
            </div>
            <div className="flex gap-2">
              <button type="button" className="rounded-full border border-accent px-4 py-1.5 text-small text-text" disabled={stage !== "idle"} onClick={() => void doTransmit(o)}>
                Transmit
              </button>
              <button type="button" className="rounded-full border border-border px-4 py-1.5 text-small text-text-2" onClick={() => void doSkip(o)}>
                Skip
              </button>
            </div>
          </div>
        ))}
      </section>

      <section aria-label="Radio log" className="flex flex-col gap-2">
        <Label>Log · newest first</Label>
        {turns.length === 0 && <p className="text-small text-text-3">No radio traffic yet.</p>}
        {[...turns].reverse().map((t: LoggedTurn) => (
          <div key={t.id} className="flex flex-col gap-1 rounded-sm border border-line bg-surface-solid p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-small text-text-3">{time(t.at, true)}</span>
              <StatusPill tone={STATE_TONE[t.state]} dot={t.state === "awaiting_confirm"}>{STATE_WORDS[t.state]}</StatusPill>
              <span className="font-mono text-caption text-text-3">
                ASR {ms(t.asr_ms)} · model {ms(t.llm_ms)} · voice {voice(t.tts_ms)}
                {t.heard_ms != null && <> · first sound {ms(t.heard_ms)}</>}
              </span>
            </div>
            {t.direction === "in" && t.transcript && (
              <p className="text-body text-text-2">
                <span className="text-text">{callsign(t.callsign)}:</span> {t.transcript}
              </p>
            )}
            {t.reply && (
              <p className="text-body text-text">
                <span className="font-medium text-text-2">Sightline:</span> {t.reply}
              </p>
            )}
          </div>
        ))}
      </section>
    </Panel>
  );
}
