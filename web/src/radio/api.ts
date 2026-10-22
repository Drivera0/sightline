// The radio desk's calls to the radio API (sightline/radio/api.py). Mounted by lane D under the
// mission API (D-R4); until then `uvicorn sightline.radio.dev:app --port 8010` serves it alone.
// Writes carry the API's write token the same way as ../lib/api.ts (VITE_API_TOKEN, private builds only).

import type { RadioTurn } from "../contract";
import { authHeaders } from "../lib/api";

/** Contract §12.2 RadioTurn (generated in ../contract.ts). */
export type { RadioTurn };

/** What /turn and /transmit return: the turn, the clue it committed (if any), and the reply's audio
 * chunk URLs in order (chunk 0 ready now, later ones may 404 for a moment while they are generated). */
export interface TurnResponse extends RadioTurn {
  clue: Record<string, unknown> | null;
  audio_chunks: string[];
}

/** What /turn returns when the model is slow (over ~2 s): "<Callsign>, Sightline. Standby." to play
 * now, and where to collect the answer (`pollTurn`). */
export interface TurnStandby {
  standby: true;
  reply: string;
  audio_chunks: string[];
  poll: string;
}

export const isStandby = (r: TurnResponse | TurnStandby): r is TurnStandby => "standby" in r && r.standby === true;

/** An approved proposal with a briefing, waiting to be transmitted (contract §12.2 Proposal, subset). */
export interface OutboundItem {
  id: string;
  kind: string;
  summary: string;
  briefing: string;
  target: Record<string, string>;
  decided_by?: string | null;
  decided_at?: string | null;
}

export interface RadioApi {
  base: string; // e.g. "http://127.0.0.1:8010" in dev, "" when mounted on the same origin
  missionId: string;
  /** The write token; undefined = VITE_API_TOKEN, null = none. */
  token?: string | null;
}

const root = (a: RadioApi) => `${a.base}/missions/${encodeURIComponent(a.missionId)}/radio`;

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      detail = ((await res.json()) as { detail?: string }).detail ?? detail;
    } catch {
      /* not JSON */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

/** One inbound turn: recorded audio, or text (the fallback when there is no microphone). */
export async function postTurn(
  a: RadioApi,
  input: { audio: Blob; mime?: string } | { text: string },
  callsignHint?: string,
): Promise<TurnResponse | TurnStandby> {
  const form = new FormData();
  if ("audio" in input) {
    form.append("audio", input.audio, "turn.webm");
    form.append("mime", input.mime ?? input.audio.type ?? "audio/webm");
  } else {
    form.append("text", input.text);
  }
  if (callsignHint) form.append("callsign_hint", callsignHint);
  return json<TurnResponse | TurnStandby>(await fetch(`${root(a)}/turn`, { method: "POST", headers: authHeaders(a, "POST"), body: form }));
}

/** Collect a standby turn's answer: `null` while it is still running (202). */
export async function pollTurn(a: RadioApi, path: string): Promise<TurnResponse | null> {
  const res = await fetch(chunkUrl(a, path));
  if (res.status === 202) return null;
  return json<TurnResponse>(res);
}

export async function getOutbound(a: RadioApi): Promise<OutboundItem[]> {
  return json<OutboundItem[]>(await fetch(`${root(a)}/outbound`));
}

export async function transmit(a: RadioApi, proposalId: string): Promise<TurnResponse> {
  return json<TurnResponse>(await fetch(`${root(a)}/outbound/${encodeURIComponent(proposalId)}/transmit`, { method: "POST", headers: authHeaders(a, "POST") }));
}

export async function skip(a: RadioApi, proposalId: string): Promise<void> {
  await json(await fetch(`${root(a)}/outbound/${encodeURIComponent(proposalId)}/skip`, { method: "POST", headers: authHeaders(a, "POST") }));
}

/** A chunk URL from the API is a path; resolve it against the API base. */
export const chunkUrl = (a: RadioApi, path: string) => (path.startsWith("http") ? path : `${a.base}${path}`);
