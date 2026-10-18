import type { CacheBundle, Detection, Frame } from "../contract";
import { cacheUrl } from "../lib/cache";
import { Badge, Label } from "./components";

/** One stage of the schematic: x position, block heights (one per block), caption. */
const STAGES = [
  { key: "backbone", x: 78, blocks: [64, 50, 36], caption: "Backbone", sub: "3 scales" },
  { key: "neck", x: 166, blocks: [56, 56], caption: "Neck", sub: "merges scales" },
  { key: "head", x: 232, blocks: [44], caption: "Head", sub: "box + score" },
] as const;
const BLOCK_W = 16;
const BLOCK_GAP = 6;
const MID_Y = 52;

/** Where the training facts come from (not in the cache; quoted from lane A's release record). */
const TRAINING_SOURCE = "scripts/README.md and the weights-v2 release notes (lane A)";

interface Props {
  cache: CacheBundle;
  dir: string;
  /** The photo being scored, or undefined once the scan is done. */
  frame: Frame | undefined;
  /** Every box the model kept for that photo (at or above the save threshold). */
  boxes: Detection[];
  /** Changes on every photo, so the signal sweeps again. */
  pulseKey: string;
  done: boolean;
}

/**
 * "Inside the detector": a schematic of the network the scanner is running (YOLO11s, 1024 px
 * input, features at three scales, neck, detection head), with a signal sweeping through it for
 * each photo, and the real scores for that photo from detections.json against the flag
 * threshold. The diagram is a schematic, labelled as such: the model does not run in the browser.
 */
export function ModelPanel({ cache, dir, frame, boxes, pulseKey, done }: Props) {
  const { detections, metrics } = cache;
  const threshold = detections.candidate_threshold;
  const top = boxes.reduce((m, d) => Math.max(m, d.conf), 0);
  const flagged = boxes.filter((d) => d.conf >= threshold).length;
  const allBoxes = Object.values(detections.frames).flat();
  const allFlagged = allBoxes.filter((d) => d.conf >= threshold).length;
  const flaggedPhotos = Object.values(detections.frames).filter((ds) => ds.some((d) => d.conf >= threshold)).length;
  const seconds = metrics.detector.seconds_per_image;

  return (
    <section
      aria-label="Inside the detector"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 [box-shadow:inset_0_1px_0_0_var(--surface-strong)]"
    >
      <div className="flex items-center justify-between gap-3">
        <Label>Inside the detector</Label>
        <span className="font-mono text-label text-text-3">{detections.model}</span>
      </div>

      {/* The schematic. Re-keyed per photo so the sweep plays once for each. */}
      <svg key={pulseKey} viewBox="0 0 320 112" className="mx-auto h-auto max-h-[190px] w-full" role="img" aria-label="Schematic of the detector: input, backbone, neck, head, score">
        <defs>
          <clipPath id="sl-model-input">
            <rect x="2" y="24" width="56" height="56" rx="6" />
          </clipPath>
        </defs>
        {/* Wires */}
        {[
          [58, 78],
          [78 + 3 * BLOCK_W + 2 * BLOCK_GAP, 166],
          [166 + 2 * BLOCK_W + BLOCK_GAP, 232],
          [232 + BLOCK_W, 284],
        ].map(([x1, x2], i) => (
          <g key={i}>
            <line x1={x1} y1={MID_Y} x2={x2} y2={MID_Y} stroke="var(--border)" strokeWidth="1.5" />
            {!done && (
              <line
                x1={x1}
                y1={MID_Y}
                x2={x2}
                y2={MID_Y}
                stroke="var(--accent)"
                strokeWidth="2"
                strokeLinecap="round"
                pathLength={1}
                className="sl-wire"
                style={{ animationDelay: `${120 + i * 170}ms` }}
              />
            )}
          </g>
        ))}

        {/* Input: the photo being scored */}
        {frame ? (
          <image href={cacheUrl(dir, frame.file)} x="2" y="24" width="56" height="56" preserveAspectRatio="xMidYMid slice" clipPath="url(#sl-model-input)" />
        ) : (
          <rect x="2" y="24" width="56" height="56" rx="6" fill="var(--surface-strong)" />
        )}
        <rect x="2" y="24" width="56" height="56" rx="6" fill="none" stroke="var(--border)" />
        <text x="30" y="96" textAnchor="middle" className="fill-[var(--text-2)] font-mono" fontSize="8">
          1024 px
        </text>

        {/* Backbone, neck, head */}
        {STAGES.map((stage, s) => (
          <g key={stage.key}>
            {stage.blocks.map((h, b) => (
              <rect
                key={b}
                x={stage.x + b * (BLOCK_W + BLOCK_GAP)}
                y={MID_Y - h / 2}
                width={BLOCK_W}
                height={h}
                rx="3"
                fill="var(--surface-strong)"
                stroke="var(--border)"
                className={done ? undefined : "sl-node"}
                style={{ animationDelay: `${200 + s * 170 + b * 60}ms` }}
              />
            ))}
            <text
              x={stage.x + (stage.blocks.length * (BLOCK_W + BLOCK_GAP) - BLOCK_GAP) / 2}
              y="96"
              textAnchor="middle"
              className="fill-[var(--text)]"
              fontSize="8.5"
            >
              {stage.caption}
            </text>
            <text
              x={stage.x + (stage.blocks.length * (BLOCK_W + BLOCK_GAP) - BLOCK_GAP) / 2}
              y="106"
              textAnchor="middle"
              className="fill-[var(--text-3)]"
              fontSize="7"
            >
              {stage.sub}
            </text>
          </g>
        ))}

        {/* Score */}
        <circle
          cx="300"
          cy={MID_Y}
          r="16"
          fill="var(--surface-strong)"
          stroke={!done && top >= threshold ? "var(--accent)" : "var(--border)"}
          strokeWidth="1.5"
          className={done ? undefined : "sl-node"}
          style={{ animationDelay: "760ms" }}
        />
        <text x="300" y={MID_Y + 3} textAnchor="middle" className="fill-[var(--text)] font-mono" fontSize="9">
          {done ? "✓" : boxes.length ? top.toFixed(2) : "–"}
        </text>
        <text x="300" y="96" textAnchor="middle" className="fill-[var(--text)]" fontSize="8.5">
          Score
        </text>
      </svg>

      {/* Real numbers for this photo (or the whole survey once done). */}
      {done ? (
        <p className="text-small text-text-2">
          <span className="font-mono text-text">{allBoxes.length}</span> boxes scored across all{" "}
          {cache.survey.frames.length} photos; <span className="font-mono text-accent-soft">{allFlagged}</span> above{" "}
          {threshold}, in {flaggedPhotos} photos. Those are the review queue.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between text-small">
            <span className="text-text-2">Boxes scored in this photo</span>
            <span className="font-mono text-text">{boxes.length}</span>
          </div>
          <Gauge key={pulseKey} value={top} threshold={threshold} hasBox={boxes.length > 0} />
          <div className="flex items-baseline justify-between text-small">
            <span className="text-text-2">Verdict</span>
            {flagged > 0 ? (
              <span className="text-accent-soft">Flagged for review</span>
            ) : boxes.length > 0 ? (
              <span className="text-text-3">Below {threshold}: not flagged</span>
            ) : (
              <span className="text-text-3">Nothing to score</span>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3 text-label text-text-3">
        <Badge kind="info">Schematic</Badge>
        <span title={TRAINING_SOURCE}>
          YOLO11s fine-tuned 80 epochs on 1024 px tiles from 890 labelled HERIDAL photos.
        </span>
        <span title="metrics.detector.seconds_per_image">{seconds.toFixed(2)} s per full photo.</span>
      </div>
    </section>
  );
}

/** 0–1 confidence bar with a tick at the flag threshold; fills to the photo's top score. */
function Gauge({ value, threshold, hasBox }: { value: number; threshold: number; hasBox: boolean }) {
  const above = value >= threshold;
  return (
    <div className="flex flex-col gap-1">
      <div className="relative h-2 rounded-full bg-surface-strong" role="meter" aria-label="Top score" aria-valuemin={0} aria-valuemax={1} aria-valuenow={value}>
        {hasBox && (
          <span
            className={"sl-gauge absolute inset-y-0 left-0 rounded-full " + (above ? "bg-accent" : "bg-text-3/70")}
            style={{ width: `${Math.round(value * 100)}%` }}
          />
        )}
        <span className="absolute -top-1 h-4 w-px bg-text" style={{ left: `${threshold * 100}%` }} aria-hidden="true" />
      </div>
      <div className="relative h-3 font-mono text-[10px] text-text-3">
        <span className="absolute" style={{ left: `${threshold * 100}%`, transform: "translateX(-50%)" }}>
          flag at {threshold}
        </span>
        <span className="absolute right-0">top {hasBox ? value.toFixed(2) : "–"}</span>
      </div>
    </div>
  );
}
