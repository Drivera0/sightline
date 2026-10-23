// The drone feed tile (PR #215's feed clips): while a drone leg flies, a small tile at the bottom left of the
// map plays the fixture's clip for that leg (web/public/feed/), with its poster, muted and looping. The clips
// are public-domain U.S. Forest Service footage, never this flight, and the tile says so in its label.
// - A phone never starts it before the visitor has tapped or pressed a key on the page; until then it shows
//   the poster with a play button (and so does reduced motion).
// - Hidden with prefers-reduced-data (the clips are about a megabyte each).
// Built by lane A.
import { useEffect, useRef, useState } from "react";
import type { FleetState } from "../contract";
import { publicUrl, type DroneFeedClip } from "../lib/fixtureExtras";
import { prefersReducedMotion } from "../metrics/motion";

/** The words under the clip, exactly (the fixture's own label says the same in other punctuation). */
export const FEED_LABEL = "drone feed · public-domain footage, not this flight";

/**
 * The clip to show: the leg the selected drone flies, else the first leg flying; its own clip, else (a leg the
 * visitor sent, which the fixture has no clip for) the clip of another leg over the same sector. Null when no
 * leg flies or none has a clip.
 */
export function activeFeed(feeds: readonly DroneFeedClip[] | undefined, fleet: FleetState | null, selectedDrone: string | null = null): { feed: DroneFeedClip; drone: string; sector: string | null } | null {
  if (!feeds?.length || !fleet) return null;
  const flying = fleet.legs.filter((l) => l.status === "flying" && fleet.drones.some((d) => d.id === l.drone_id && d.status === "flying"));
  const legs = [...flying.filter((l) => l.drone_id === selectedDrone), ...flying.filter((l) => l.drone_id !== selectedDrone)];
  for (const l of legs) {
    const feed = feeds.find((f) => f.leg === l.id) ?? feeds.find((f) => f.sector !== null && f.sector === l.sector_id);
    const name = fleet.drones.find((d) => d.id === l.drone_id)?.name ?? l.drone_id;
    if (feed) return { feed, drone: name, sector: l.sector_id };
  }
  return null;
}

const media = (q: string) => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(q).matches;
/** A phone: a coarse pointer, or a narrow screen. */
export const isPhone = () => media("(pointer: coarse)") || media("(max-width: 767.98px)");
export const reducedData = () => media("(prefers-reduced-data: reduce)");

/** Whether the visitor has tapped, clicked or pressed a key on the page yet (the clip may start after that). */
let gestured = false;
function useGesture(): boolean {
  const [on, setOn] = useState(gestured);
  useEffect(() => {
    if (on) return undefined;
    const unlock = () => {
      gestured = true;
      setOn(true);
    };
    window.addEventListener("pointerdown", unlock, { capture: true });
    window.addEventListener("keydown", unlock, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", unlock, { capture: true });
      window.removeEventListener("keydown", unlock, { capture: true });
    };
  }, [on]);
  return on;
}

/** `raised`: something sits along the bottom of the map (the guided search's strip): the tile goes above it. */
export function DroneFeed({ feeds, fleet, selectedDrone = null, raised = false }: { feeds: readonly DroneFeedClip[] | undefined; fleet: FleetState | null; selectedDrone?: string | null; raised?: boolean }) {
  const now = activeFeed(feeds, fleet, selectedDrone);
  const gesture = useGesture();
  const [asked, setAsked] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const [hidden] = useState(reducedData);
  // folded to a pill by its own button (the map under it stays reachable); a phone starts folded
  const [folded, setFolded] = useState(isPhone);
  // a desktop plays it at once (muted); a phone, or reduced motion, waits for a gesture or the play button
  const waits = isPhone() || prefersReducedMotion();
  const play = !!now && (asked || (!waits ? true : gesture && !prefersReducedMotion()));
  const clip = now?.feed.clip;
  useEffect(() => {
    const el = video.current;
    if (!el || !play) return;
    const p = el.play?.();
    if (p && typeof p.catch === "function") p.catch(() => undefined);
  }, [play, clip]);
  if (hidden || !now) return null;
  const f = now.feed;
  const at = `pointer-events-auto absolute left-2 z-10 sm:left-3 ${raised ? "bottom-24" : "bottom-2 sm:bottom-3"}`;
  if (folded)
    return (
      <button type="button" onClick={() => setFolded(false)} aria-label="Show the drone feed" className={`${at} sl-tap inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-bg/90 px-2.5 text-caption text-text`}>
        <span aria-hidden className="size-1.5 rounded-full bg-[var(--drone)]" />
        Drone feed
      </button>
    );
  return (
    <figure
      aria-label="Drone feed"
      data-feed={f.leg}
      className={`${at} flex w-36 flex-col overflow-hidden rounded-md border border-line bg-bg/90 shadow-[var(--shadow-pop)] sm:w-52`}
    >
      <div className="flex items-center gap-1.5 px-2 py-1 text-caption text-text">
        <span aria-hidden className="size-1.5 rounded-full bg-[var(--drone)]" />
        <span className="shrink-0 font-medium whitespace-nowrap">Drone feed</span>
        <span className="hidden truncate text-text-3 sm:inline">
          {now.drone}
          {now.sector ? ` · ${now.sector}` : ""}
        </span>
        <button type="button" onClick={() => setFolded(true)} aria-label="Fold the drone feed" title="Fold" className="sl-tap ml-auto shrink-0 px-1 text-text-3 hover:text-text">
          ×
        </button>
      </div>
      <div className="relative aspect-video w-full bg-surface-strong">
        {play ? (
          <video
            key={f.clip}
            ref={video}
            src={publicUrl(f.clip)}
            poster={publicUrl(f.poster)}
            muted
            loop
            playsInline
            autoPlay
            preload="metadata"
            onLoadedMetadata={(e) => {
              if (f.start_s > 0 && f.start_s < (e.currentTarget.duration || Infinity)) e.currentTarget.currentTime = f.start_s;
            }}
            aria-label={`${FEED_LABEL}: ${f.credit}`}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <>
            <img src={publicUrl(f.poster)} alt="" className="absolute inset-0 h-full w-full object-cover" />
            <button type="button" onClick={() => setAsked(true)} className="sl-tap absolute inset-0 m-auto inline-flex h-8 w-fit items-center rounded-full border border-border bg-bg/85 px-3 text-caption text-text">
              Play
            </button>
          </>
        )}
      </div>
      <figcaption className="px-2 py-1 text-[0.6875rem] leading-tight text-text-3" title={f.credit}>
        {FEED_LABEL}
      </figcaption>
    </figure>
  );
}
