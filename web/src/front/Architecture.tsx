// How Sightline fits together, in the colour system: photos to the detector, the second look and a
// person's answer; the field's reports; both into the probability map; the agent's proposals; the search
// manager's approval, which sends drones and teams out again. Redrawn from docs/architecture/system.png and
// agent.png for people, not engineers: one plain line per step, the model named small. An SVG on wide
// screens, where a photo travels the loop (9 s, paused off screen, none under reduced motion), and the
// same steps as a list on a phone.
import { useEffect, useRef, useState } from "react";
import { ICONS, type IconName } from "../shell/icons";
import { canAnimate, useOnScreen } from "./motion";

interface Node {
  id: string;
  col: number;
  row: number;
  /** A semantic colour token (theme.css) for the outline and the icon. */
  tone: string;
  icon: IconName;
  title: string;
  /** What happens here, in plain words. */
  plain: string;
  /** The model or tool doing it, named small; none where a person does the work. */
  model?: string;
}

export const NODES: readonly Node[] = [
  { id: "photos", col: 0, row: 0, tone: "--drone", icon: "drone", title: "Drone photos", plain: "Stills, off the card or live" },
  { id: "detect", col: 1, row: 0, tone: "--text-2", icon: "detection", title: "Detector", plain: "Ranks every photo", model: "YOLO11s on OpenCV 5 cv2.dnn" },
  { id: "relook", col: 2, row: 0, tone: "--text-2", icon: "detection", title: "Second look", plain: "Looks again when unsure", model: "OpenCV re-look, Nemotron VL" },
  { id: "review", col: 3, row: 0, tone: "--found", icon: "decision", title: "A person confirms", plain: "Answers each candidate" },
  { id: "field", col: 0, row: 1, tone: "--team", icon: "team", title: "Teams and clues", plain: "Radio reports, finds on foot", model: "Parakeet speech to text" },
  { id: "map", col: 1, row: 1, tone: "--prob-3", icon: "lkp", title: "Probability map", plain: "Where the person may be", model: "search theory, per photo" },
  { id: "agent", col: 2, row: 1, tone: "--proposal", icon: "note", title: "Agent proposes", plain: "Next drone leg and team", model: "planner, Nemotron 3 Nano" },
  { id: "manager", col: 3, row: 1, tone: "--found", icon: "decision", title: "Manager approves", plain: "Nothing moves until then" },
];

const W = 216;
const H = 84;
const GAP = 32;
const X = (col: number) => 12 + col * (W + GAP);
const Y = (row: number) => 16 + row * 150;
const VIEW_W = X(3) + W + 12;
const VIEW_H = Y(1) + H + 64;
const MID_Y = Y(0) + H + 33;
const LOOP_Y = Y(1) + H + 36;

/** One loop of the photo's trip, in seconds: slow enough to follow, short enough to see whole. */
export const LOOP_S = 9;
/** The share of the loop the photo is moving; for the rest it is out of sight. */
const MOVING = 0.86;

const node = (id: string) => NODES.find((n) => n.id === id)!;
const right = (id: string) => [X(node(id).col) + W, Y(node(id).row) + H / 2] as const;
const left = (id: string) => [X(node(id).col), Y(node(id).row) + H / 2] as const;
const centre = (id: string) => [X(node(id).col) + W / 2, Y(node(id).row) + H / 2] as const;

/** The nodes a photo passes, in order (teams and clues feed the map from the side). */
export const TRIP = ["photos", "detect", "relook", "review", "map", "agent", "manager"] as const;

/**
 * A photo's trip, centre to centre: the drone, the detector, the second look, the person; down to the
 * map; the agent; the manager. Returns the path and each node's moment in the loop (0..1).
 */
export function trip(): { d: string; at: Record<string, number> } {
  const [x0, y0] = centre("photos");
  const [xr] = centre("review");
  const [xm, ym] = centre("map");
  const [xg] = centre("manager");
  const pts: (readonly [number, number])[] = [
    [x0, y0],
    [xr, y0],
    [xr, MID_Y],
    [xm, MID_Y],
    [xm, ym],
    [xg, ym],
  ];
  const seg = pts.slice(1).map(([x, y], i) => Math.abs(x - pts[i]![0]) + Math.abs(y - pts[i]![1]));
  const total = seg.reduce((a, b) => a + b, 0);
  const along = ([x, y]: readonly [number, number]) => {
    let d = 0;
    for (let i = 0; i < seg.length; i++) {
      const [ax, ay] = pts[i]!;
      const [bx, by] = pts[i + 1]!;
      const on = (ax === bx && x === ax && (y - ay) * (y - by) <= 0) || (ay === by && y === ay && (x - ax) * (x - bx) <= 0);
      if (on) return d + Math.abs(x - ax) + Math.abs(y - ay);
      d += seg[i]!;
    }
    return total;
  };
  const at: Record<string, number> = {};
  for (const id of TRIP) at[id] = (along(centre(id)) / total) * MOVING;
  return { d: `M${pts.map(([x, y]) => `${x} ${y}`).join(" L")}`, at };
}

/** The opacity keyframes of a node that lights as the photo reaches it (`at`, its moment in the loop). */
export function glowFrames(at: number): { values: string; keyTimes: string } {
  const raw: [number, number][] = [
    [0, 0],
    [at - 0.035, 0],
    [at, 1],
    [at + 0.06, 1],
    [at + 0.11, 0],
    [1, 0],
  ];
  const keep: [number, number][] = [];
  for (const [t, v] of raw) {
    const tt = Math.min(1, Math.max(0, t));
    const last = keep[keep.length - 1];
    if (last && tt <= last[0]) {
      last[1] = Math.max(last[1], v);
      continue;
    }
    keep.push([tt, v]);
  }
  return { values: keep.map(([, v]) => v).join(";"), keyTimes: keep.map(([t]) => Number(t.toFixed(4))).join(";") };
}

function Glow({ n, at }: { n: Node; at: number }) {
  const c = `var(${n.tone})`;
  const f = glowFrames(at);
  return (
    <rect x={X(n.col)} y={Y(n.row)} width={W} height={H} rx={12} fill={c} fillOpacity={0.1} stroke={c} strokeWidth={3} opacity={0} pointerEvents="none">
      <animate attributeName="opacity" dur={`${LOOP_S}s`} repeatCount="indefinite" values={f.values} keyTimes={f.keyTimes} />
    </rect>
  );
}

function Box({ n }: { n: Node }) {
  const x = X(n.col);
  const y = Y(n.row);
  const c = `var(${n.tone})`;
  const icon = ICONS[n.icon];
  return (
    <g>
      <rect x={x} y={y} width={W} height={H} rx={12} fill="var(--surface-solid)" stroke={c} strokeWidth={1.5} />
      {n.id === "map" && <rect x={x + 12} y={y + H - 8} width={W - 24} height={3} rx={1.5} fill="url(#sl-arch-prob)" />}
      <g transform={`translate(${x + 12} ${y + 12}) scale(0.75)`} fill="none" stroke={c} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
        {icon.d.map((d) => (
          <path key={d} d={d} />
        ))}
        {icon.c.map(([cx, cy, r]) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} />
        ))}
      </g>
      <text x={x + 38} y={y + 26} fontSize={14} fontWeight={600} fill="var(--text)">
        {n.title}
      </text>
      <text x={x + 12} y={y + 50} fontSize={12} fill="var(--text)">
        {n.plain}
      </text>
      {n.model && (
        <text x={x + 12} y={y + 68} fontSize={11} fill="var(--text-3)" fontFamily="var(--mono)">
          {n.model}
        </text>
      )}
    </g>
  );
}

function Arrow({ d, tone = "--text-3", dashed = false }: { d: string; tone?: string; dashed?: boolean }) {
  return <path d={d} fill="none" stroke={`var(${tone})`} strokeWidth={1.5} strokeDasharray={dashed ? "5 4" : undefined} markerEnd="url(#sl-arch-head)" />;
}

const straight = (a: string, b: string) => {
  const [x1, y1] = right(a);
  const [x2] = left(b);
  return `M${x1} ${y1} H${x2 - 2}`;
};

/** The diagram (wide screens) and the same steps as a list (phones). The photo's trip loops while on screen. */
export function Architecture({ animate = true }: { animate?: boolean }) {
  const [box, onScreen] = useOnScreen<HTMLElement>();
  const svg = useRef<SVGSVGElement>(null);
  const [motion] = useState(() => animate && canAnimate());
  useEffect(() => {
    const el = svg.current;
    if (!motion || !el || typeof el.pauseAnimations !== "function") return;
    if (onScreen) el.unpauseAnimations();
    else el.pauseAnimations();
  }, [motion, onScreen]);
  const rev = node("review");
  const map = node("map");
  const mgr = node("manager");
  const fld = node("field");
  const path = trip();
  return (
    <figure ref={box} aria-label="How Sightline fits together" className="flex flex-col gap-3">
      <svg ref={svg} role="img" aria-labelledby="sl-arch-title" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="hidden h-auto w-full font-sans lg:block">
        <title id="sl-arch-title">Drone photos go to the detector, the second look and a person; teams and clues come in by radio; both update the probability map; the agent proposes; the search manager approves, and drones and teams go out again.</title>
        <defs>
          <marker id="sl-arch-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="var(--text-3)" />
          </marker>
          <linearGradient id="sl-arch-prob" x1="0" x2="1" y1="0" y2="0">
            {[1, 2, 3, 4, 5].map((i) => (
              <stop key={i} offset={`${(i - 1) * 25}%`} stopColor={`var(--prob-${i})`} />
            ))}
          </linearGradient>
        </defs>
        <Arrow d={straight("photos", "detect")} />
        <Arrow d={straight("detect", "relook")} />
        <Arrow d={straight("relook", "review")} />
        {/* the reviewer's answers into the map */}
        <Arrow d={`M${X(rev.col) + W / 2} ${Y(0) + H} V${MID_Y} H${X(map.col) + W / 2} V${Y(1) - 2}`} />
        <Arrow d={straight("field", "map")} />
        <Arrow d={straight("map", "agent")} />
        <Arrow d={straight("agent", "manager")} tone="--proposal" />
        {/* approved: drones fly, teams go out, and new photos and reports come back */}
        <Arrow d={`M${X(mgr.col) + W / 2} ${Y(1) + H} V${LOOP_Y} H${X(fld.col) + W / 2} V${Y(1) + H + 2}`} dashed />
        {/* the photo travels under the boxes: seen on the arrows, hidden while a node works on it */}
        {motion && (
          <circle data-testid="arch-trip" r={5} fill="var(--accent)" opacity={0}>
            <animateMotion dur={`${LOOP_S}s`} repeatCount="indefinite" path={path.d} keyPoints="0;1;1" keyTimes={`0;${MOVING};1`} calcMode="linear" />
            <animate attributeName="opacity" dur={`${LOOP_S}s`} repeatCount="indefinite" values="0;1;1;0;0" keyTimes={`0;0.03;${MOVING - 0.02};${MOVING};1`} />
          </circle>
        )}
        {NODES.map((n) => (
          <Box key={n.id} n={n} />
        ))}
        {motion && TRIP.map((id) => <Glow key={id} n={node(id)} at={path.at[id]!} />)}
        <text x={X(rev.col) + W / 2 - 8} y={MID_Y - 8} fontSize={12} textAnchor="end" fill="var(--text-2)">
          answers: person, or not
        </text>
        <text x={(X(fld.col) + X(mgr.col) + W) / 2} y={LOOP_Y - 8} fontSize={12} textAnchor="middle" fill="var(--text-2)">
          approved: the drone flies the leg, the team goes out; new photos and reports come back
        </text>
      </svg>
      <ol className="flex flex-col gap-2 lg:hidden">
        {NODES.map((n) => (
          <li key={n.id} className="flex items-start gap-3 rounded-md border border-line bg-surface-solid p-3" style={{ borderLeft: `3px solid var(${n.tone})` }}>
            <span className="flex flex-col gap-0.5">
              <span className="text-small font-medium text-text">{n.title}</span>
              <span className="text-small text-text-2">{n.plain}</span>
              {n.model && <span className="font-mono text-caption text-text-3">{n.model}</span>}
            </span>
          </li>
        ))}
      </ol>
      <figcaption className="text-caption text-text-3">Every model and tool call goes into the mission's trace, with who approved what and when.</figcaption>
    </figure>
  );
}
