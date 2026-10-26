// What the demo fixtures carry beside the contract's mission records (scripts/make_command_fixtures.py,
// PR #215): a drone feed clip per leg, the server's after-action report, the distractor frames an image
// review is shown. A live mission has none of them; every reader treats them as optional.

/** One drone leg's feed clip (`fixture.feeds`): public-domain footage, never this flight. */
export interface DroneFeedClip {
  leg: string;
  drone: string;
  sector: string | null;
  /** Under web/public, e.g. "feed/forest-1.mp4". */
  clip: string;
  poster: string;
  start_s: number;
  loop_s: number;
  label: string;
  credit: string;
}

/** The server's after-action report (`fixture.report`, sightline report.py): the parts the console reads. */
export interface ServerReport {
  subject?: { profile?: string; last_seen_at?: string | null } | null;
  /** Every sector's final POD: cumulative from every look, prior-weighted. */
  sectors?: { sector: string; label?: string; poa: number; drone_coverage: number; pod: number; ground: number | null }[];
  /** The drone legs with their minutes and photos. */
  legs?: { leg: string; drone: string; sector: string | null; status: string; minutes: number; minutes_from: string; photos: number; from: string | null; to: string | null }[];
}

/** A distractor frame (`fixture.distractors`): a licensed ground-level photo of an object, placed in the flight. */
export interface DistractorFrame {
  kind: string;
  frame_id: string;
  /** The survey photo after which it lands. */
  near_frame: string;
  detection_id: string;
  /** Under web/public. */
  image: string;
  crop: string;
  box_px: [number, number, number, number];
  conf: number;
  lat: number;
  lon: number;
  person: "yes" | "no" | "unclear";
  object: "backpack" | "fire ring" | "shelter" | "other" | null;
  reason: string;
  model: string;
  /** The scenario's own reviewer's answer, and the clue candidate it made. */
  review: string;
  review_object: string | null;
  clue: string | null;
  credit: string;
}

/**
 * One Nemotron call on Nebius Token Factory that the mission's answers come from (`fixture.model_calls`,
 * scripts/make_command_fixtures.py --live): the model, its measured time and tokens, and the answer word for word.
 */
export interface ModelCall {
  /** "vl": a second look on a detection; "briefing": a radio briefing for an assignment. */
  kind: "vl" | "briefing" | string;
  model: string;
  ms: number;
  tokens_in: number;
  tokens_out: number;
  /** On the mission's clock. */
  at: string | null;
  /** When the call was made (UTC). */
  called_at: string | null;
  /** The script that made it. */
  source: string;
  detection: string | null;
  verdict: string | null;
  proposal: string | null;
  text: string;
}

/** A path under web/public as a URL under the site's base. */
export function publicUrl(rel: string, base: string = import.meta.env.BASE_URL ?? "/"): string {
  if (/^(https?:)?\/\//.test(rel) || rel.startsWith("/")) return rel;
  return `${base.endsWith("/") ? base : `${base}/`}${rel}`;
}
