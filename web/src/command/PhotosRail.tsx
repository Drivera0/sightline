// The Photos view: the console's right rail while photos come in. On the demo mission, the survey's
// photos as they land (the mission clock decides how many); on a live mission, the upload and the watch
// command. Both end with Try a photo: the detector on a photo of your own, its result in the Review rail.

import type { ReactNode } from "react";
import type { Frame } from "../contract";
import { Badge, Label } from "../shell/components";

/** How many of the newest photos are shown as pictures (each is a full survey photo). */
export const PHOTO_TILES = 12;

/** How many of the newest photos the phone strip shows. */
export const STRIP_TILES = 5;

/**
 * The Photos view on a phone, above the map: the count, the bar and the newest few photos in one strip,
 * so the map stays on screen while they land (the full rail is further down the page). Hidden at 1024 px
 * and up, where the rail sits beside the map.
 */
export function PhotoStrip({
  landed,
  total,
  candidates,
  playing,
  imageUrl,
}: {
  landed: readonly Frame[];
  total: number;
  candidates: number;
  playing: boolean;
  imageUrl: (rel: string) => string;
}) {
  const newest = [...landed].slice(-STRIP_TILES).reverse();
  const share = total ? landed.length / total : 0;
  return (
    <section aria-label="Photos landing" data-tour="photos" className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface-solid p-2 lg:hidden">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-small text-text">
          {landed.length} <span className="text-text-3">of {total} placed</span>
        </span>
        <span className="font-mono text-caption text-text-2">
          {candidates} {candidates === 1 ? "candidate" : "candidates"}
        </span>
      </div>
      <div className="relative h-1 overflow-hidden rounded-full bg-surface-strong">
        <div className="absolute inset-y-0 left-0 rounded-full bg-ok" style={{ width: `${Math.round(share * 100)}%` }} />
        <progress className="sr-only" max={total} value={landed.length} aria-label="Photos placed on the map" />
      </div>
      {newest.length === 0 ? (
        <p className="text-caption text-text-3">No photos yet: the drone is still flying.</p>
      ) : (
        <ul className="grid grid-cols-5 gap-1" aria-label="Newest photos">
          {newest.map((f) => (
            <li key={f.id} className="relative aspect-[4/3] overflow-hidden rounded-sm bg-surface-strong">
              {!playing && <img src={imageUrl(f.file)} alt={`Survey photo ${f.id}`} loading="lazy" className="absolute inset-0 h-full w-full object-cover" />}
              <span className="absolute bottom-0 left-0.5 font-mono text-[10px] leading-tight text-text-2">{f.id}</span>
              {f.n_candidates > 0 && <span aria-label="Has a candidate" className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-accent ring-1 ring-bg" />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function PhotosRail({
  landed,
  total,
  candidates,
  playing,
  imageUrl,
  live,
  tryPanel,
  tryOpen,
  onTry,
}: {
  /** The demo's survey photos that have landed, in flight order (null on a live mission). */
  landed: readonly Frame[] | null;
  total: number;
  /** Candidates so far (detections at or above the review threshold). */
  candidates: number;
  /** The mission clock is running: tiles show ids, not pictures (no image requests while it streams). */
  playing: boolean;
  imageUrl: (rel: string) => string;
  /** A live mission's progress and upload panels. */
  live?: ReactNode;
  tryPanel: ReactNode;
  tryOpen: boolean;
  onTry: () => void;
}) {
  const newest = landed ? [...landed].slice(-PHOTO_TILES).reverse() : [];
  const share = landed && total ? landed.length / total : 0;
  return (
    <section aria-label="Photos" data-tour="photos" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2 px-1">
        <span className="text-caption font-medium text-text-2">Photos</span>
        <button type="button" onClick={onTry} aria-expanded={tryOpen} className="sl-tap rounded-full border border-border px-3 py-0.5 text-caption text-text-2 hover:text-text">
          {tryOpen ? "Hide Try a photo" : "Try a photo of your own"}
        </button>
      </div>
      {tryOpen && tryPanel}
      {landed && (
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface-solid p-3">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-small text-text">
                {landed.length} <span className="text-text-3">of {total} placed</span>
              </span>
              <span className="font-mono text-caption text-text-2">
                {candidates} {candidates === 1 ? "candidate" : "candidates"}
              </span>
            </div>
            <div className="relative h-1.5 overflow-hidden rounded-full bg-surface-strong">
              <div className="absolute inset-y-0 left-0 rounded-full bg-ok" style={{ width: `${Math.round(share * 100)}%` }} />
              <progress className="sr-only" max={total} value={landed.length} aria-label="Photos placed on the map" />
            </div>
          </div>
          <p className="text-caption text-text-3">
            One survey flight, its photos off the card after landing. Each one is ranked by the detector and placed on the map, which updates where
            the person could still be.
          </p>
          <span className="flex flex-wrap gap-1.5">
            <Badge kind="simulated">Simulated flight path</Badge>
            <Badge kind="info">Real HERIDAL photos</Badge>
          </span>
          {newest.length === 0 ? (
            <p className="text-small text-text-3">No photos yet: the drone is still flying.</p>
          ) : (
            <>
              <Label>Newest first</Label>
              <ul className="grid grid-cols-3 gap-1.5" aria-label="Newest photos">
                {newest.map((f) => (
                  <li key={f.id} className="relative aspect-[4/3] overflow-hidden rounded-sm bg-surface-strong">
                    {!playing && <img src={imageUrl(f.file)} alt={`Survey photo ${f.id}`} loading="lazy" className="absolute inset-0 h-full w-full object-cover" />}
                    <span className="absolute bottom-0.5 left-1 rounded-sm bg-bg/80 px-1 font-mono text-caption text-text-2">{f.id}</span>
                    {f.n_candidates > 0 && <span aria-label="Has a candidate" className="absolute right-1 top-1 size-2 rounded-full bg-accent ring-2 ring-bg" />}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {live}
    </section>
  );
}
