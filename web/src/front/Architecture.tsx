// How Sightline fits together, in the colour system: photos to the detector, the second look and a
// person's answer; the field's reports; both into the probability map; the agent's proposals; the search
// manager's approval, which sends drones and teams out again. Redrawn from docs/architecture/system.png and
// agent.png for people, not engineers. An SVG on wide screens, the same steps as a list on a phone.
import { ICONS, type IconName } from "../shell/icons";

interface Node {
  id: string;
  col: number;
  row: number;
  /** A semantic colour token (theme.css) for the outline and the icon. */
  tone: string;
  icon: IconName;
  title: string;
  lines: [string, string];
}

const NODES: readonly Node[] = [
  { id: "photos", col: 0, row: 0, tone: "--drone", icon: "drone", title: "Drone photos", lines: ["geotagged stills, off the card", "or live when there is signal"] },
  { id: "detect", col: 1, row: 0, tone: "--text-2", icon: "detection", title: "Detector", lines: ["YOLO11s on OpenCV 5 cv2.dnn", "ranks every photo"] },
  { id: "relook", col: 2, row: 0, tone: "--text-2", icon: "detection", title: "Second look", lines: ["OpenCV re-look tools and", "Nemotron VL, if unsure"] },
  { id: "review", col: 3, row: 0, tone: "--found", icon: "decision", title: "A person confirms", lines: ["the image reviewer answers", "each candidate"] },
  { id: "field", col: 0, row: 1, tone: "--team", icon: "team", title: "Teams and clues", lines: ["radio reports (Parakeet) and", "clues found on the ground"] },
  { id: "map", col: 1, row: 1, tone: "--prob-3", icon: "lkp", title: "Probability map", lines: ["where the person could be,", "after every photo and report"] },
  { id: "agent", col: 2, row: 1, tone: "--proposal", icon: "note", title: "Agent proposes", lines: ["the next drone leg and team", "assignment, with reasons"] },
  { id: "manager", col: 3, row: 1, tone: "--found", icon: "decision", title: "Manager approves", lines: ["the search manager decides;", "nothing moves until then"] },
];

const W = 196;
const H = 84;
const GAP = 44;
const X = (col: number) => 12 + col * (W + GAP);
const Y = (row: number) => 16 + row * 150;
const VIEW_W = X(3) + W + 12;
const VIEW_H = Y(1) + H + 64;

function Box({ n }: { n: Node }) {
  const x = X(n.col);
  const y = Y(n.row);
  const c = `var(${n.tone})`;
  const icon = ICONS[n.icon];
  return (
    <g>
      <rect x={x} y={y} width={W} height={H} rx={12} fill="var(--surface-solid)" stroke={c} strokeWidth={1.5} />
      {n.id === "map" && (
        <rect x={x + 12} y={y + H - 10} width={W - 24} height={4} rx={2} fill="url(#sl-arch-prob)" />
      )}
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
      {n.lines.map((l, i) => (
        <text key={l} x={x + 12} y={y + 52 + i * 17} fontSize={12} fill="var(--text-2)">
          {l}
        </text>
      ))}
    </g>
  );
}

const node = (id: string) => NODES.find((n) => n.id === id)!;
const right = (id: string) => [X(node(id).col) + W, Y(node(id).row) + H / 2] as const;
const left = (id: string) => [X(node(id).col), Y(node(id).row) + H / 2] as const;

function Arrow({ d, tone = "--text-3", dashed = false }: { d: string; tone?: string; dashed?: boolean }) {
  return <path d={d} fill="none" stroke={`var(${tone})`} strokeWidth={1.5} strokeDasharray={dashed ? "5 4" : undefined} markerEnd="url(#sl-arch-head)" />;
}

const straight = (a: string, b: string) => {
  const [x1, y1] = right(a);
  const [x2] = left(b);
  return `M${x1} ${y1} H${x2 - 2}`;
};

/** The diagram (wide screens) and the same steps as a list (phones). */
export function Architecture() {
  const rev = node("review");
  const map = node("map");
  const mgr = node("manager");
  const fld = node("field");
  const midY = Y(0) + H + 33;
  const loopY = Y(1) + H + 36;
  return (
    <figure aria-label="How Sightline fits together" className="flex flex-col gap-3">
      <svg role="img" aria-labelledby="sl-arch-title" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="hidden h-auto w-full font-sans lg:block">
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
        <Arrow d={`M${X(rev.col) + W / 2} ${Y(0) + H} V${midY} H${X(map.col) + W / 2} V${Y(1) - 2}`} />
        <Arrow d={straight("field", "map")} />
        <Arrow d={straight("map", "agent")} />
        <Arrow d={straight("agent", "manager")} tone="--proposal" />
        {/* approved: drones fly, teams go out, and new photos and reports come back */}
        <Arrow d={`M${X(mgr.col) + W / 2} ${Y(1) + H} V${loopY} H${X(fld.col) + W / 2} V${Y(1) + H + 2}`} dashed />
        {NODES.map((n) => (
          <Box key={n.id} n={n} />
        ))}
        <text x={X(rev.col) + W / 2 - 8} y={midY - 8} fontSize={12} textAnchor="end" fill="var(--text-2)">
          answers: person, or not
        </text>
        <text x={(X(fld.col) + X(mgr.col) + W) / 2} y={loopY - 8} fontSize={12} textAnchor="middle" fill="var(--text-2)">
          approved: the drone flies the leg, the team goes out; new photos and reports come back
        </text>
      </svg>
      <ol className="flex flex-col gap-2 lg:hidden">
        {NODES.map((n) => (
          <li key={n.id} className="flex items-start gap-3 rounded-md border border-line bg-surface-solid p-3" style={{ borderLeft: `3px solid var(${n.tone})` }}>
            <span className="flex flex-col">
              <span className="text-small font-medium text-text">{n.title}</span>
              <span className="text-caption text-text-2">{n.lines.join(" ")}</span>
            </span>
          </li>
        ))}
      </ol>
      <figcaption className="text-caption text-text-3">Nothing the agent proposes happens until a person approves it. Every model and tool call is in the mission's trace.</figcaption>
    </figure>
  );
}
