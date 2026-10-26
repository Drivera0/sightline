// "What the photo changes": the home page's account of the agent's loop, on one real chain from this
// flight (#192): f0273-d02, two people on a trail under the trees that the detector scored 0.17, below the
// 0.29 review line. OpenCV 5 cuts a zoom from the photo's native pixels, NVIDIA Nemotron VL answers from it on
// Nebius Token Factory, the agent proposes adding it to the review queue, and a person decides. Every number and every quoted word
// comes from the live run's fixture (command/__fixtures__/second_look/, written by
// scripts/make_second_look_fixture.py, the answer word for word) or the docs it cites. Then "Try your own
// photo": the same detector in the visitor's browser (detect/TryPhoto.tsx, at #try).
import type { ReactNode } from "react";
import secondLook from "../command/__fixtures__/second_look/verdict.json";
import zoomUrl from "../command/__fixtures__/second_look/f0273-d02-zoom_native.jpg?url";
import { Button, Label } from "../shell/components";
import { REPO_URL } from "./judges";
import { useSeenOnce } from "./motion";

const BLOB = `${REPO_URL}/blob/main`;
const det = secondLook.detection;
const verdict = secondLook.verdict;
const proposal = secondLook.proposals[0]!;
/** The review line the live run's trace states ("below the 0.29 review threshold"). */
const REVIEW_LINE = 0.29;
/** The box's long side in the frame, px (the trace's heuristics: 79). */
const BOX_PX = Math.max(det.box_px[2]! - det.box_px[0]!, det.box_px[3]! - det.box_px[1]!);

/** The frame the detection is in, as the hero's wall shows it (360 × 270 of the 1000 × 750 frame). */
const FRAME = { src: "/front/wall/f0273.webp", w: 1000, h: 750 } as const;

export interface AgentStep {
  /** The loop's verb: perceive, look again, reason, propose, decide. */
  verb: string;
  /** Who or what does it. */
  who: string;
  title: string;
  body: ReactNode;
  /** Where it lives in the product or the code. */
  link: { label: string; href: string } | null;
}

export const AGENTIC = {
  eyebrow: "Agentic vision",
  title: "What the photo changes",
  lead: `One detection from this flight that the review queue would have dropped. Each result decides the next step, and nothing moves until a person approves.`,
  steps: [
    {
      verb: "Perceive",
      who: "OpenCV 5 cv2.dnn",
      title: `The detector scores it ${det.conf.toFixed(2)}`,
      body: `Below the ${REVIEW_LINE} review line, so no reviewer would see ${det.id}. A near miss starts a second look.`,
      link: { label: "The survey photos", href: "#m/demo/photos" },
    },
    {
      verb: "Look again",
      who: "OpenCV 5",
      title: "A zoom from the native pixels",
      body: `A square 2.5 × the ${BOX_PX} px box, cut from the photo's own pixels and enlarged to 384 px (INTER_CUBIC). On low-contrast ground CLAHE lifts it too; here the zoom was enough.`,
      link: { label: "The code: relook.py", href: `${BLOB}/sightline/agent/relook.py` },
    },
    {
      verb: "Reason",
      who: "NVIDIA Nemotron VL, on Nebius Token Factory",
      title: `Person: ${verdict.person}, ${verdict.posture}, ${verdict.group_size} of them`,
      body: `“${verdict.reason}” (${(verdict.ms / 1000).toFixed(1)} s)`,
      link: { label: "Every call, in the Trace", href: "#m/demo/trace" },
    },
    {
      verb: "Propose",
      who: "The agent",
      title: "It proposes a review, and waits",
      body: `Its reason: confidence ${det.conf.toFixed(2)} is below the review line ${REVIEW_LINE}, and the second look says a person. It waits in Needs you.`,
      link: { label: "Open Needs you", href: "#m/demo/map?needs" },
    },
    {
      verb: "You decide",
      who: "The search manager",
      title: "Approve, and the plan changes",
      body: "Your approval is logged with your name and the time, and the detection joins the review queue. Confirm the person there and a sighting is pinned on the map; the agent re-plans and proposes an alert to all teams and the nearest team on standby, each waiting for you.",
      link: null,
    },
  ] satisfies readonly AgentStep[],
  /** Step 5's action: the guided simulation, whose triage has this same detection. */
  decide: "Decide it yourself, in the guided simulation",
  try: {
    title: "Try your own photo",
    body: "Drop in an aerial photo and the same detector runs on it in your browser, with ONNX Runtime Web: the same weights, slices and cut-off. The server runs that model on OpenCV 5 cv2.dnn. Your photo never leaves your device.",
    note: "Three survey photos from this flight are one tap away inside, with the pipeline's boxes to compare. It was trained on drone photos taken from about 30 to 60 m; on anything else its boxes mean nothing.",
    action: "Try your own photo",
    href: "#try",
  },
} as const;

/** Each step fades in this far after the one before it, the first time the flow scrolls into view. */
export const STEP_STAGGER_MS = 160;

/** The frame with the detector's box on it (step 1). */
function FrameWithBox() {
  const [x1, y1, x2, y2] = det.box_px as [number, number, number, number];
  const pad = 10;
  return (
    <div className="relative aspect-[4/3] overflow-hidden rounded-sm bg-surface-strong">
      <img src={FRAME.src} alt={`Survey photo ${det.id.slice(0, 5)}: trail and trees from above, with the detector's box on ${det.id}`} width={360} height={270} loading="lazy" decoding="async" className="h-full w-full object-cover" />
      <span
        aria-hidden="true"
        className="absolute rounded-[4px] border-[1.5px] border-accent"
        style={{
          left: `${((x1 - pad) / FRAME.w) * 100}%`,
          top: `${((y1 - pad) / FRAME.h) * 100}%`,
          width: `${((x2 - x1 + 2 * pad) / FRAME.w) * 100}%`,
          height: `${((y2 - y1 + 2 * pad) / FRAME.h) * 100}%`,
        }}
      >
        <span className="absolute -top-4 left-0 font-mono text-[10px] leading-none text-accent-soft">{det.conf.toFixed(2)}</span>
      </span>
    </div>
  );
}

/** A card the size of the pictures, for the steps that are words (the verdict, the proposal, the decision). */
function Card({ children }: { children: ReactNode }) {
  return <div className="flex flex-col justify-center gap-2 rounded-sm border border-line bg-surface-solid p-3 lg:aspect-[4/3]">{children}</div>;
}

const chip = "rounded-full border border-line px-2 py-0.5 text-caption text-text-2";

function StepPicture({ i }: { i: number }) {
  if (i === 0) return <FrameWithBox />;
  if (i === 1)
    return (
      <img
        src={zoomUrl}
        alt={`OpenCV's native-pixel zoom of ${det.id}: two people in red on a trail under the trees`}
        width={384}
        height={384}
        loading="lazy"
        decoding="async"
        className="aspect-[4/3] w-full rounded-sm object-cover"
      />
    );
  if (i === 2)
    return (
      <Card>
        <span className="font-mono text-caption text-text-3">{verdict.model.replace("nvidia/", "")}</span>
        <span className="flex flex-wrap gap-1.5">
          <span className={`${chip} border-[var(--found)] text-text`}>person: {verdict.person}</span>
          <span className={chip}>{verdict.posture}</span>
          <span className={chip}>{verdict.group_size} people</span>
        </span>
        <span className="text-caption text-text-2">{verdict.clothing}</span>
      </Card>
    );
  if (i === 3)
    return (
      <Card>
        <span className="font-mono text-caption text-text-3">
          {proposal.id} · {proposal.kind}
        </span>
        <span className="text-small font-medium text-text">{proposal.summary.split(":")[0]}</span>
        <span className="self-start rounded-full border border-line px-2 py-0.5 text-caption text-text-2">{proposal.status}: needs you</span>
      </Card>
    );
  return (
    <Card>
      <span className="font-mono text-caption text-text-3">decision · logged</span>
      <span className="text-small text-text">approved by your name, at the mission time</span>
      <span className="flex flex-col gap-0.5 text-caption text-text-2">
        <span>→ the review queue</span>
        <span>→ a sighting on the map</span>
        <span>→ new proposals: alert, nearest team</span>
      </span>
    </Card>
  );
}

function Step({ s, i, seen, onDecide }: { s: AgentStep; i: number; seen: boolean; onDecide?: () => void }) {
  const last = i === AGENTIC.steps.length - 1;
  return (
    <li data-seen={seen ? "true" : "false"} className="sl-step relative flex min-w-0 flex-col gap-2 pl-10 lg:pl-0" style={{ transitionDelay: `${i * STEP_STAGGER_MS}ms` }}>
      {/* the rail: down the left on phones and tablets, across the top on wide screens */}
      <span aria-hidden="true" className="absolute left-0 top-0 flex size-7 items-center justify-center rounded-full border border-text-3 bg-bg font-mono text-caption text-text lg:static">
        {i + 1}
      </span>
      {!last && <span aria-hidden="true" className="absolute bottom-[-12px] left-[13px] top-8 w-px bg-line lg:left-9 lg:right-[-20px] lg:top-[13px] lg:h-px lg:w-auto" />}
      <span className="text-label font-medium text-text-2">
        {s.verb} <span className="text-text-3">· {s.who}</span>
      </span>
      <StepPicture i={i} />
      <h3 className="text-small font-medium text-text">{s.title}</h3>
      <p className="text-small text-text-2">{s.body}</p>
      {s.link && (
        <a
          className="mt-auto self-start text-caption text-text-3 underline underline-offset-2 hover:text-text"
          href={s.link.href}
          {...(s.link.href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
        >
          {s.link.label}
          {s.link.href.startsWith("http") && <span aria-hidden="true"> ↗</span>}
        </a>
      )}
      {!s.link && onDecide && (
        <button type="button" onClick={onDecide} className="sl-tap mt-auto self-start text-left text-caption text-text-3 underline underline-offset-2 hover:text-text">
          {AGENTIC.decide}
        </button>
      )}
    </li>
  );
}

/** The section: the eyebrow, the title, the five steps of one real chain, and "Try your own photo". */
export function AgenticVision({ id = "home-agentic", onDecide }: { id?: string; onDecide?: () => void }) {
  const [ref, seen] = useSeenOnce<HTMLOListElement>(0.15);
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Label className="text-text-3">{AGENTIC.eyebrow}</Label>
        <h2 id={id} tabIndex={-1} className="text-headline font-medium tracking-[-0.01em] text-text">
          {AGENTIC.title}
        </h2>
      </div>
      <p className="-mt-1 max-w-[70ch] text-body text-text">{AGENTIC.lead}</p>
      <ol ref={ref} aria-label="One chain, step by step" className="grid gap-6 pt-2 lg:grid-cols-5 lg:gap-5">
        {AGENTIC.steps.map((s, i) => (
          <Step key={s.verb} s={s} i={i} seen={seen} onDecide={onDecide} />
        ))}
      </ol>
      <div role="group" aria-labelledby={`${id}-try`} className="mt-2 flex flex-col gap-4 rounded-lg border border-line bg-surface-solid p-4 sm:flex-row sm:items-center sm:justify-between lg:p-6">
        <div className="flex max-w-[72ch] flex-col gap-1">
          <h3 id={`${id}-try`} className="text-title font-medium text-text">
            {AGENTIC.try.title}
          </h3>
          <p className="text-small text-text-2">{AGENTIC.try.body}</p>
          <p className="text-small text-text-3">{AGENTIC.try.note}</p>
        </div>
        <Button href={AGENTIC.try.href} size="lg" className="self-start sm:self-center">
          {AGENTIC.try.action}
        </Button>
      </div>
    </section>
  );
}
