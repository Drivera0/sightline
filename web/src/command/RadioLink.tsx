// The radio desk, folded into the console (COMMAND_POST.md §5): on a live mission whose server runs the
// radio (serve --radio), the talk bar's hold-to-talk records the operator, sends the turn to the radio API
// on the picked team's channel and plays Sightline's reply; approved briefings wait in Needs you as
// "Briefings to send" until the operator presses Transmit. Nothing is ever transmitted that a person did
// not approve. The turns themselves reach the timeline as the mission's radio events. Built by lane A.
import { useCallback, useEffect, useRef, useState } from "react";
import * as radio from "../radio/api";
import { isStandby, type OutboundItem, type RadioApi, type TurnResponse } from "../radio/api";
import { playChunks } from "../radio/player";
import { MicDenied, startRecording, type Recording } from "../radio/recorder";
import { useRadio } from "../radio/store";
import { Icon } from "../shell/icons";
import type { TalkVoice } from "./Timeline";

const POLL_MS = 300;
const POLL_LIMIT_MS = 60_000;

/** Hold-to-talk on a live radio desk; null when there is none (the demo). */
export function useRadioVoice(api: RadioApi | null): TalkVoice | null {
  const [stage, setStage] = useState<TalkVoice["stage"]>("idle");
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recording | null>(null);
  const team = useRef<string>("");
  const play = useCallback(async (res: TurnResponse) => {
    setStage("speaking");
    try {
      await playChunks(res.audio_chunks.map((p) => radio.chunkUrl(api!, p)), useRadio.getState().radioSound);
    } catch (e) {
      setError(`Playback: ${(e as Error).message}`);
    }
  }, [api]);
  const press = useCallback(async (to: string) => {
    if (!api || rec.current) return;
    setError(null);
    team.current = to;
    try {
      rec.current = await startRecording();
      setStage("recording");
    } catch (e) {
      setError(e instanceof MicDenied ? "No microphone: type the call instead." : (e as Error).message);
    }
  }, [api]);
  const release = useCallback(async () => {
    const r = rec.current;
    rec.current = null;
    if (!api || !r) return;
    setStage("sending");
    try {
      const res = await radio.postTurn(api, { audio: await r.stop() }, team.current);
      if (isStandby(res)) {
        const started = Date.now();
        let answer: TurnResponse | null = null;
        while (!answer) {
          if (Date.now() - started > POLL_LIMIT_MS) throw new Error("No answer from the model after 60 s.");
          await new Promise((ok) => setTimeout(ok, POLL_MS));
          answer = await radio.pollTurn(api, res.poll);
        }
        await play(answer);
      } else await play(res);
    } catch (e) {
      setError((e as Error).message);
    }
    setStage("idle");
  }, [api, play]);
  if (!api) return null;
  return { press, release, stage, error };
}

/** "Briefings to send": the approved briefings in the radio's outbound queue, each with Transmit and Skip. */
export function Briefings({ api, callsign }: { api: RadioApi; callsign: (id: string | null) => string }) {
  const [items, setItems] = useState<OutboundItem[]>([]);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => radio.getOutbound(api).then(setItems, () => undefined), [api]);
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(id);
  }, [refresh]);
  if (items.length === 0) return null;
  const act = (f: () => Promise<unknown>) => async () => {
    setBusy(true);
    try {
      const res = await f();
      if (res && typeof res === "object" && "audio_chunks" in res) await playChunks((res as TurnResponse).audio_chunks.map((p) => radio.chunkUrl(api, p)), useRadio.getState().radioSound);
    } finally {
      setBusy(false);
      void refresh();
    }
  };
  return (
    <>
      {items.map((o) => (
        <article key={o.id} aria-label={`Briefing ${o.id}`} className="flex flex-col gap-1.5 rounded-md border border-line border-l-2 border-l-accent bg-bg/40 p-2.5">
          <span className="flex items-center gap-2 text-small font-medium text-text">
            <Icon name="radio" className="text-accent" />
            Briefing to send: {o.target.team === "all" ? "all teams" : callsign(o.target.team ?? null)}
          </span>
          <span className="text-small text-text-2">{o.briefing}</span>
          <span className="flex gap-1.5">
            <button type="button" disabled={busy} onClick={act(() => radio.transmit(api, o.id))} className="sl-tap inline-flex h-7 items-center rounded-full border border-accent bg-accent/15 px-3 text-small text-text disabled:opacity-40">
              Transmit
            </button>
            <button type="button" disabled={busy} onClick={act(() => radio.skip(api, o.id))} className="sl-tap inline-flex h-7 items-center rounded-full border border-border px-3 text-small text-text-2">
              Skip
            </button>
          </span>
        </article>
      ))}
    </>
  );
}
