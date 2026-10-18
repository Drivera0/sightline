import { useId } from "react";
import {
  detectorSpec,
  formatShape,
  inputsOf,
  pyramidLevels,
  stageOf,
  type DetectorSpec,
  type SpecLayer,
} from "../metrics/detectorSpec";

/*
 * The architecture graph: every layer of our weights drawn as an isometric stack of feature maps
 * (footprint on a log scale of the grid size, depth by channels), linked exactly as the layer table
 * says. Positions are presentation only; shapes, types and links come from detectorSpec.json.
 */

export const VIEW_W = 460;
export const VIEW_H = 244;
const R1 = 54; // backbone row
const R2 = 126; // neck, top-down
const R3 = 190; // neck, bottom-up

/** Where each layer sits. Index -1 is the input. Columns line up by grid size (512² … 32²). */
const POS: Record<number, readonly [number, number]> = {
  [-1]: [26, R1],
  0: [58, R1],
  1: [80, R1],
  2: [100, R1],
  3: [142, R1],
  4: [168, R1],
  5: [220, R1],
  6: [246, R1],
  7: [286, R1],
  8: [310, R1],
  9: [334, R1],
  10: [358, R1],
  11: [258, R2],
  12: [233, R2],
  13: [208, R2],
  14: [180, R2],
  15: [155, R2],
  16: [130, R2],
  17: [208, R3],
  18: [233, R3],
  19: [258, R3],
  20: [300, R3],
  21: [330, R3],
  22: [358, R3],
};
/** The three Detect branches (P3, P4, P5) and the score they merge into. */
const HEADS: readonly (readonly [number, number])[] = [
  [402, 218],
  [402, 190],
  [402, 162],
];
const SCORE: readonly [number, number] = [440, 190];

/** The grid-size bands behind the graph: the head's three strides. */
const BANDS = [
  { x: 118, w: 74, size: 128 },
  { x: 196, w: 74, size: 64 },
  { x: 274, w: 100, size: 32 },
] as const;

/** Geometry of one stack: plates standing side by side, receding up and to the right. */
export interface StackGeom {
  /** Plate polygons, back to front. */
  plates: string[];
  front: { x: number; y: number; w: number; s: number; k: number };
  top: number;
  bottom: number;
}

export function stackGeom(cx: number, cy: number, size: number, channels: number, input = false): StackGeom {
  const s = 12 + (Math.log2(Math.max(2, size)) - 5) * 6.4;
  const w = s * (input ? 0.62 : 0.42);
  const k = s * 0.28;
  const n = channels <= 4 ? channels : Math.min(7, Math.max(1, Math.round(Math.log2(channels) - 3)));
  const gap = input ? 3 : 2.2;
  const lift = gap * 0.6;
  const totalW = w + (n - 1) * gap;
  const totalH = s + k + (n - 1) * lift;
  const x0 = cx - totalW / 2;
  const y0 = cy - totalH / 2 + (n - 1) * lift;
  const plates: string[] = [];
  for (let j = 0; j < n; j++) {
    const back = n - 1 - j;
    const x = x0 + back * gap;
    const y = y0 - back * lift;
    plates.push(`${x},${y + k} ${x + w},${y} ${x + w},${y + s} ${x},${y + k + s}`);
  }
  return { plates, front: { x: x0, y: y0, w, s, k }, top: cy - totalH / 2, bottom: cy + totalH / 2 };
}

/** A path through `points` with rounded corners. */
function roundedPath(points: readonly (readonly [number, number])[], r = 6): string {
  const [first, ...rest] = points;
  if (!first) return "";
  let d = `M${first[0]},${first[1]}`;
  for (let i = 0; i < rest.length; i++) {
    const p = rest[i] as readonly [number, number];
    const prev = (i === 0 ? first : rest[i - 1]) as readonly [number, number];
    const next = rest[i + 1];
    if (!next) {
      d += ` L${p[0]},${p[1]}`;
      break;
    }
    const inLen = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    const outLen = Math.hypot(next[0] - p[0], next[1] - p[1]);
    const rr = Math.min(r, inLen / 2, outLen / 2);
    const a = [p[0] - ((p[0] - prev[0]) / inLen) * rr, p[1] - ((p[1] - prev[1]) / inLen) * rr];
    const b = [p[0] + ((next[0] - p[0]) / outLen) * rr, p[1] + ((next[1] - p[1]) / outLen) * rr];
    d += ` L${a[0]},${a[1]} Q${p[0]},${p[1]} ${b[0]},${b[1]}`;
  }
  return d;
}

function curve(a: readonly [number, number], b: readonly [number, number]): string {
  const dy = b[1] - a[1];
  if (Math.abs(dy) < 1) return `M${a[0]},${a[1]} L${b[0]},${b[1]}`;
  return `M${a[0]},${a[1]} C${a[0]},${a[1] + dy * 0.55} ${b[0]},${b[1] - dy * 0.55} ${b[0]},${b[1]}`;
}

export interface GraphEdge {
  key: string;
  from: number;
  /** Target layer index; 23 + branch / 100 for the Detect branches, and "score" as 999. */
  to: number;
  d: string;
  /** A link that skips ahead (concat input or a pyramid level), drawn dashed. */
  skip: boolean;
}

export const SCORE_NODE = 999;
const headNode = (branch: number) => 23 + branch / 10;

/** Every link in the graph, from the spec's `from` fields. */
export function graphEdges(spec: DetectorSpec = detectorSpec): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const detect = spec.layers[spec.layers.length - 1];
  for (const layer of spec.layers) {
    if (layer === detect) continue;
    const to = POS[layer.index];
    if (!to) continue;
    for (const src of inputsOf(layer)) {
      const from = POS[src];
      if (!from) continue;
      edges.push({ key: `${src}-${layer.index}`, from: src, to: layer.index, d: curve(from, to), skip: src !== layer.index - 1 });
    }
  }
  if (detect) {
    inputsOf(detect).forEach((src, branch) => {
      const from = POS[src];
      const head = HEADS[branch];
      if (!from || !head) return;
      // P3 and P4 run in lanes under the bottom row, so they never cross a stack.
      const d =
        branch === 0
          ? roundedPath([from, [from[0], 234], [390, 234], [390, head[1]], head])
          : branch === 1
            ? roundedPath([from, [from[0], 211], [382, 211], [382, head[1]], head])
            : curve(from, head);
      edges.push({ key: `${src}-head${branch}`, from: src, to: headNode(branch), d, skip: true });
      edges.push({ key: `head${branch}-score`, from: headNode(branch), to: SCORE_NODE, d: curve(head, SCORE), skip: false });
    });
  }
  return edges;
}

/** Order in which the wave reaches each node: input, layers 0–22, heads, score. */
export function waveStep(node: number): number {
  if (node === SCORE_NODE) return 26;
  if (node >= 23) return 24.5;
  return node + 1;
}

interface Props {
  /** The photo being scored, drawn on the input plate. */
  photo: string | undefined;
  /** Top score of the photo, or undefined for none. */
  top: number | undefined;
  threshold: number;
  /** Changes on every photo, so the wave plays again. Undefined: no wave (reduced motion, done). */
  pulseKey: string | undefined;
  /** Length of the wave, in milliseconds. */
  waveMs: number;
  onHover: (layer: SpecLayer | "input" | undefined) => void;
  spec?: DetectorSpec;
}

/** The graph with its wave overlay. */
export function ModelGraph({ photo, top, threshold, pulseKey, waveMs, onHover, spec = detectorSpec }: Props) {
  const uid = useId().replace(/:/g, "");
  const edges = graphEdges(spec);
  const levels = pyramidLevels(spec);
  const levelOf = new Map(levels.map((l) => [l.layer.index, l.name] as const));
  const flagged = top !== undefined && top >= threshold;
  const inputGeom = stackGeom(POS[-1]![0], POS[-1]![1], spec.imgsz, 3, true);
  const geoms = new Map<number, StackGeom>();
  for (const layer of spec.layers) {
    const p = POS[layer.index];
    const [c, h] = layer.out_shape;
    if (p && c !== undefined && h !== undefined) geoms.set(layer.index, stackGeom(p[0], p[1], h, c));
  }
  const f = inputGeom.front;

  return (
    <div className="relative h-full w-full">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="absolute inset-0 h-full w-full"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Schematic of the detector's ${spec.n_layers} layers: backbone, neck (top-down and bottom-up), and three detection heads at strides ${spec.strides.join(", ")}`}
        onMouseLeave={() => onHover(undefined)}
      >
        <defs>
          <clipPath id={`${uid}-photo`}>
            <polygon points={inputGeom.plates[inputGeom.plates.length - 1]} />
          </clipPath>
        </defs>

        {/* Grid-size bands: the head's three strides. */}
        {BANDS.map((b, i) => (
          <g key={b.size}>
            <rect x={b.x} y={20} width={b.w} height={VIEW_H - 24} rx={8} fill="color-mix(in srgb, var(--text) 3%, transparent)" />
            <text x={b.x + b.w / 2} y={11} textAnchor="middle" fontSize={9.5} className="fill-[var(--text-2)] font-mono">
              {b.size}²
              <tspan className="fill-[var(--text-3)]" fontSize={8}>
                {"  "}stride {spec.strides[i]}
              </tspan>
            </text>
          </g>
        ))}
        <text x={6} y={11} fontSize={8.5} letterSpacing={0.6} className="fill-[var(--text-3)] font-mono">
          BACKBONE →
        </text>
        <RowLabel y={R2} title="NECK · TOP-DOWN" sub="upsample + concat" />
        <RowLabel y={R3} title="NECK · BOTTOM-UP" sub="stride-2 conv + concat" />
        {/* Legend */}
        {["footprint = grid size (log)", "depth = channels", "dashed = no weights"].map((t, i) => (
          <text key={t} x={6} y={215 + i * 9.5} fontSize={7.5} className="fill-[var(--text-3)]">
            {t}
          </text>
        ))}

        {/* Links */}
        {edges.map((e) => (
          <path
            key={e.key}
            d={e.d}
            fill="none"
            stroke={e.to >= 23 && e.to < SCORE_NODE ? "color-mix(in srgb, var(--accent) 35%, var(--border))" : "var(--border)"}
            strokeWidth={1}
            strokeDasharray={e.skip ? "2.5 2" : undefined}
          />
        ))}

        {/* Input: the photo on the front plate */}
        <g onMouseEnter={() => onHover("input")}>
          <title>{`Input · ${spec.imgsz}²×3 (the photo, letterboxed to ${spec.imgsz} px)`}</title>
          {inputGeom.plates.map((pts, j) => (
            <polygon key={j} points={pts} fill="color-mix(in srgb, var(--text) 9%, var(--bg))" stroke="var(--border)" strokeWidth={0.75} />
          ))}
          {photo && (
            // The clip sits on a wrapper so it stays in the graph's coordinates, not the skewed image's.
            <g clipPath={`url(#${uid}-photo)`}>
              <image
                href={photo}
                width={f.w}
                height={f.s}
                preserveAspectRatio="xMidYMid slice"
                transform={`matrix(1 ${-f.k / f.w} 0 1 ${f.x} ${f.y + f.k})`}
              />
            </g>
          )}
          <text x={POS[-1]![0]} y={inputGeom.bottom + 10} textAnchor="middle" fontSize={8.5} className="fill-[var(--text-2)] font-mono">
            {spec.imgsz}²×3
          </text>
        </g>

        {/* Layers */}
        {spec.layers.map((layer) => {
          const g = geoms.get(layer.index);
          if (!g) return null;
          const level = levelOf.get(layer.index);
          const noWeights = layer.params === 0;
          return (
            <g key={layer.index} onMouseEnter={() => onHover(layer)} className="cursor-default">
              <title>{layerTitle(layer, spec)}</title>
              {g.plates.map((pts, j) => (
                <polygon
                  key={j}
                  points={pts}
                  fill={`color-mix(in srgb, var(--text) ${j === g.plates.length - 1 ? 13 : 7}%, var(--bg))`}
                  stroke={level && j === g.plates.length - 1 ? "color-mix(in srgb, var(--accent-soft) 70%, transparent)" : "var(--border)"}
                  strokeWidth={0.75}
                  strokeDasharray={noWeights ? "1.5 1.2" : undefined}
                />
              ))}
              {level && (
                <text x={POS[layer.index]![0]} y={g.top - 4} textAnchor="middle" fontSize={9.5} className="fill-[var(--accent-soft)] font-mono">
                  {level}
                </text>
              )}
              {(layer.type === "SPPF" || layer.type === "C2PSA") && (
                <text
                  x={POS[layer.index]![0]}
                  y={g.bottom + (layer.type === "SPPF" ? 9 : 18)}
                  textAnchor="middle"
                  fontSize={7.5}
                  className="fill-[var(--text-3)] font-mono"
                >
                  {layer.type}
                </text>
              )}
            </g>
          );
        })}

        {/* Detect: three branches, one per pyramid level */}
        <text x={HEADS[2]![0] + 6} y={HEADS[2]![1] - 12} textAnchor="middle" fontSize={8} letterSpacing={0.6} className="fill-[var(--text-3)] font-mono">
          DETECT
        </text>
        {HEADS.map(([x, y], i) => (
          <g key={i} onMouseEnter={() => onHover(spec.layers[spec.layers.length - 1])}>
            <title>{`Detect branch ${levels[i]?.name ?? ""} (stride ${spec.strides[i]}): 4 box values + ${spec.nc} class score per cell`}</title>
            <rect x={x} y={y - 6} width={13} height={12} rx={3} fill="color-mix(in srgb, var(--text) 10%, var(--bg))" stroke="color-mix(in srgb, var(--accent) 45%, var(--border))" strokeWidth={0.75} />
          </g>
        ))}

        {/* Score */}
        <g>
          <title>Top score for this photo (from detections.json)</title>
          <circle
            cx={SCORE[0]}
            cy={SCORE[1]}
            r={13}
            fill="color-mix(in srgb, var(--text) 8%, var(--bg))"
            stroke={flagged ? "var(--accent)" : "var(--border)"}
            strokeWidth={flagged ? 1.5 : 1}
            className="transition-[stroke] duration-500"
          />
          <text x={SCORE[0]} y={SCORE[1] + 3} textAnchor="middle" fontSize={8.5} className="fill-[var(--text)] font-mono">
            {top === undefined ? "–" : top.toFixed(2)}
          </text>
          <text x={SCORE[0]} y={SCORE[1] + 24} textAnchor="middle" fontSize={7.5} className="fill-[var(--text-3)] font-mono">
            score
          </text>
        </g>
      </svg>

      {pulseKey !== undefined && (
        <Wave key={pulseKey} edges={edges} geoms={geoms} inputPlate={inputGeom.plates[inputGeom.plates.length - 1] ?? ""} waveMs={waveMs} flagged={flagged} />
      )}
    </div>
  );
}

function RowLabel({ y, title, sub }: { y: number; title: string; sub: string }) {
  return (
    <g>
      <text x={6} y={y - 2} fontSize={8.5} letterSpacing={0.5} className="fill-[var(--text-3)] font-mono">
        {title}
      </text>
      <text x={6} y={y + 9.5} fontSize={8} className="fill-[var(--text-3)]">
        {sub}
      </text>
    </g>
  );
}

export function layerTitle(layer: SpecLayer, spec: DetectorSpec = detectorSpec): string {
  const from = inputsOf(layer)
    .map((i) => (i < 0 ? "input" : `L${i}`))
    .join(" + ");
  const out = layer.type === "Detect" ? `${layer.out_shape.join(" values × ")} locations` : formatShape(layer.out_shape);
  return `L${layer.index} · ${layer.type} (${stageOf(layer, spec)}) · out ${out} · ${layer.params.toLocaleString("en-US")} params · from ${from}`;
}

/**
 * One pass of the signal: particles run along every link and each stack glows as they arrive, in
 * layer order. A separate SVG, re-mounted per photo, so its SMIL clock starts at zero each time.
 * Every glow fades back to the resting look, so a new photo never makes the graph jump.
 */
function Wave({
  edges,
  geoms,
  inputPlate,
  waveMs,
  flagged,
}: {
  edges: GraphEdge[];
  geoms: Map<number, StackGeom>;
  inputPlate: string;
  waveMs: number;
  flagged: boolean;
}) {
  const step = waveMs / 27;
  const at = (node: number) => waveStep(node) * step;
  const glowMs = Math.max(420, step * 9);
  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {edges.map((e) => {
        const end = at(e.to);
        const dur = Math.max(end - at(e.from), step * 2.5);
        const begin = Math.max(0, end - dur);
        return (
          <g key={e.key} opacity={0}>
            <circle r={3.4} fill="var(--accent)" opacity={0.28} />
            <circle r={1.5} fill="var(--accent-soft)" />
            <animateMotion path={e.d} begin={`${begin}ms`} dur={`${dur}ms`} fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.45 0 0.25 1" />
            <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.8;1" begin={`${begin}ms`} dur={`${dur}ms`} fill="freeze" />
          </g>
        );
      })}
      <polygon points={inputPlate} className="sl-lit" fill="var(--accent)" style={{ animationDuration: `${glowMs}ms` }} />
      {[...geoms.entries()].map(([index, g]) => (
        <polygon
          key={index}
          points={g.plates[g.plates.length - 1]}
          className="sl-lit"
          fill="var(--accent)"
          stroke="var(--accent-soft)"
          strokeWidth={0.75}
          style={{ animationDelay: `${at(index)}ms`, animationDuration: `${glowMs}ms` }}
        />
      ))}
      {HEADS.map(([x, y], i) => (
        <rect
          key={i}
          x={x}
          y={y - 6}
          width={13}
          height={12}
          rx={3}
          className="sl-lit"
          fill="var(--accent)"
          style={{ animationDelay: `${at(headNode(i))}ms`, animationDuration: `${glowMs}ms` }}
        />
      ))}
      <circle
        cx={SCORE[0]}
        cy={SCORE[1]}
        r={13}
        className={flagged ? "sl-lit-hold" : "sl-lit"}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={4}
        style={{ animationDelay: `${at(SCORE_NODE)}ms`, animationDuration: `${glowMs * 1.6}ms` }}
      />
    </svg>
  );
}
