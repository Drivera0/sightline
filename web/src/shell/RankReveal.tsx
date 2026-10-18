import { useEffect, useMemo, useState } from "react";
import type { CacheBundle } from "../contract";
import { cacheUrl } from "../lib/cache";
import { prefersReducedMotion } from "../metrics/motion";
import { reviewItems } from "../review/items";
import { Badge, Label } from "./components";

const SWEEP_MS = 1400;

function ordinal(n: number): string {
  return n === 1 ? "first" : `#${n}`;
}

/**
 * Step 2: the rank moment. Every photo is a tile; the flagged ones light up while the rest fall
 * away, then the queue appears with the top candidate large. Numbers come from metrics.ranking.
 */
export function RankReveal({
  cache,
  dir,
  onStart,
}: {
  cache: CacheBundle;
  dir: string;
  onStart: () => void;
}) {
  const { survey, metrics } = cache;
  const items = useMemo(() => reviewItems(cache), [cache]);
  const flagged = useMemo(
    () => new Set(survey.frames.filter((f) => f.n_candidates > 0).map((f) => f.id)),
    [survey.frames],
  );
  const [revealed, setRevealed] = useState(prefersReducedMotion);

  useEffect(() => {
    if (revealed) return;
    const timer = window.setTimeout(() => setRevealed(true), SWEEP_MS);
    return () => window.clearTimeout(timer);
  }, [revealed]);

  const ranking = metrics.ranking;
  const firstHit = ranking.ranked.frames_to_first_hit;
  const top = items.slice(0, 5);
  const lead = top[0];
  const source = `Demo survey, ${ranking.n_frames} frames (metrics.ranking)`;

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      {/* Every photo in flight order. */}
      <div className="flex min-h-0 flex-col gap-3 self-center rounded-lg border border-border bg-surface p-5">
        <div className="flex items-center justify-between">
          <Label>{survey.frames.length} photos, in flight order</Label>
          <span className="flex items-center gap-2 text-small text-text-3">
            <span className="inline-block size-2.5 rounded-[2px] bg-accent" /> flagged
          </span>
        </div>
        <div
          className="grid min-h-0 content-start gap-[3px] overflow-hidden"
          style={{ gridTemplateColumns: `repeat(${survey.frames.length > 100 ? 25 : 10}, minmax(0, 1fr))` }}
          aria-hidden="true"
        >
          {survey.frames.map((frame, i) => {
            const isFlagged = flagged.has(frame.id);
            const delay = Math.round((i / survey.frames.length) * (SWEEP_MS - 500));
            return (
              <span
                key={frame.id}
                className={
                  "aspect-square rounded-[2px] bg-surface-strong " + (isFlagged ? "sl-flag" : "sl-dim")
                }
                style={{ animationDelay: `${delay}ms` }}
              />
            );
          })}
        </div>
      </div>

      {/* The answer. */}
      <div className="flex min-h-0 flex-col justify-center gap-5">
        {revealed && lead ? (
          <>
            <div className="sl-rise flex flex-col gap-2">
              <Label>Ranked review queue</Label>
              <h2 className="text-[40px] font-semibold leading-[1.05]" title={source}>
                {firstHit === 1 ? "Person in the first photo you see" : `First person at photo ${ordinal(firstHit)}`}
              </h2>
              <p className="text-title text-text-2" title={source}>
                {flagged.size} of {survey.frames.length} photos flagged for review. In random order you
                would expect to look at about{" "}
                <span className="font-mono text-text">{Math.round(ranking.expected_first_hit_random_order)}</span>{" "}
                before the first person.
              </p>
            </div>
            <div className="sl-pop flex items-end gap-3" style={{ animationDelay: "120ms" }}>
              {lead.detection.crop && (
                <figure className="flex flex-col gap-1.5">
                  <img
                    src={cacheUrl(dir, lead.detection.crop)}
                    alt={`Top candidate, frame ${lead.frame.id}`}
                    className="size-48 rounded-md border-2 border-accent object-cover"
                  />
                  <figcaption className="font-mono text-label text-accent-soft">
                    #1 · {lead.detection.conf.toFixed(2)}
                  </figcaption>
                </figure>
              )}
              {top.slice(1).map((item, i) =>
                item.detection.crop ? (
                  <figure key={item.id} className="sl-pop flex flex-col gap-1.5" style={{ animationDelay: `${200 + i * 70}ms` }}>
                    <img
                      src={cacheUrl(dir, item.detection.crop)}
                      alt={`Candidate ${i + 2}, frame ${item.frame.id}`}
                      className="size-24 rounded-sm border border-border object-cover"
                    />
                    <figcaption className="font-mono text-label text-text-3">
                      #{i + 2} · {item.detection.conf.toFixed(2)}
                    </figcaption>
                  </figure>
                ) : null,
              )}
            </div>
            <div className="sl-rise flex items-center gap-4" style={{ animationDelay: "320ms" }}>
              <button
                type="button"
                onClick={onStart}
                autoFocus
                className="rounded-full bg-accent px-6 py-3 text-body font-medium text-bg transition-transform hover:scale-[1.03]"
              >
                Start review
              </button>
              {cache.detections.model === "SAMPLE" && <Badge kind="placeholder">Sample data</Badge>}
            </div>
          </>
        ) : (
          <p className="sl-fade text-title text-text-2" role="status">
            Scoring every photo…
          </p>
        )}
      </div>
    </div>
  );
}
