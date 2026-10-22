// Lane C's live map in TypeScript (LANE_C §5.5, C-H1): a live mission's state from `mapBase` plus the
// `map.updated` log, the same math as sightline/search/live.py `LiveMap.apply` (checked against its
// vectors in live.test.ts, 1e-9). `LiveHeat` applies new updates incrementally and keeps a checkpoint
// every CHECKPOINT_EVERY updates, so a late or replaced log only replays from the nearest one.
// Built by lane A for lane C (issue #64); lane C owns this file.
import type { MapBase, MapUpdate } from "../contract";
import { applyStep, type MapState } from "./update";

/** Contract §12.3 invariant 2: a reweight factor is in (0, MAX_FACTOR]. */
export const MAX_FACTOR = 20;
export const CHECKPOINT_EVERY = 25;

/** A reweight (clue, ground evidence, conditions): p_i *= factor_i, then renormalise with outside. */
export function applyReweight(s: MapState, cells: [number, number][]): MapState {
  const p = new Float64Array(s.p);
  if (cells.length === 0) return { p, outside: s.outside };
  for (const [idx, f] of cells) {
    if (!(f > 0 && f <= MAX_FACTOR)) throw new Error(`every factor must be in (0, ${MAX_FACTOR}]`);
    if (!Number.isInteger(idx) || idx < 0 || idx >= p.length) throw new Error(`cell index ${idx} outside grid of ${p.length} cells`);
    p[idx] = (p[idx] as number) * f;
  }
  let total = s.outside;
  for (let i = 0; i < p.length; i++) total += p[i] as number;
  for (let i = 0; i < p.length; i++) p[i] = (p[i] as number) / total;
  return { p, outside: s.outside / total };
}

export function applyUpdate(s: MapState, u: Pick<MapUpdate, "kind" | "cells">): MapState {
  return u.kind === "step" ? applyStep(s, u.cells) : applyReweight(s, u.cells);
}

export function baseState(base: MapBase): MapState {
  return { p: new Float64Array(base.prior.p), outside: base.prior.outside };
}

/** The state after every update with seq <= upToSeq (all of them by default). Never mutates. */
export function replayLive(base: MapBase, updates: readonly MapUpdate[], upToSeq = Infinity): MapState {
  let s = baseState(base);
  for (const u of updates) if (u.seq <= upToSeq) s = applyUpdate(s, u);
  return s;
}

/** Cells some photo has looked at: canopy known from the base, or a frame step touched them. */
export function lookedAt(base: MapBase, updates: readonly MapUpdate[]): Uint8Array {
  const out = new Uint8Array(base.prior.p.length);
  base.canopy.forEach((c, i) => {
    if (c !== null) out[i] = 1;
  });
  for (const u of updates) if (u.kind === "step" && u.source === "frame") for (const [i] of u.cells) out[i] = 1;
  return out;
}

/**
 * The live state, updated as `map.updated` events arrive. `sync(updates)` takes the whole log each
 * time (useMission's `mapUpdates`): only updates past the last one seen are applied; if the log was
 * replaced (a reconnect, another mission), it restarts from the nearest checkpoint that still holds.
 */
export class LiveHeat {
  private checkpoints = new Map<number, MapState>(); // seq -> state after it
  private applied: MapUpdate[] = [];
  state: MapState;

  constructor(readonly base: MapBase) {
    this.state = baseState(base);
  }

  get seq(): number {
    return this.applied.at(-1)?.seq ?? 0;
  }

  sync(updates: readonly MapUpdate[]): MapState {
    let keep = 0; // how many applied updates the new log still starts with
    while (keep < this.applied.length && keep < updates.length && updates[keep] === this.applied[keep]) keep++;
    if (keep < this.applied.length) this.rewind(keep);
    for (const u of updates.slice(this.applied.length)) {
      this.state = applyUpdate(this.state, u);
      this.applied.push(u);
      if (this.applied.length % CHECKPOINT_EVERY === 0) this.checkpoints.set(u.seq, this.state);
    }
    return this.state;
  }

  private rewind(keep: number): void {
    const at = Math.floor(keep / CHECKPOINT_EVERY) * CHECKPOINT_EVERY;
    for (const seq of [...this.checkpoints.keys()]) if (seq > (this.applied[at - 1]?.seq ?? 0)) this.checkpoints.delete(seq);
    this.applied = this.applied.slice(0, at);
    this.state = at === 0 ? baseState(this.base) : (this.checkpoints.get(this.applied[at - 1]!.seq) as MapState);
  }
}
