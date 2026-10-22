// The review queue in live mode (LANE_D §5.5 D-Q1): candidates (conf ≥ threshold) plus detections an
// approved promotion added, most confident first, each with the second look's verdict in words.
// Answers go to POST /reviews (through useMission). Built by lane A for lane D (issue #51).

import { useState } from "react";
import type { Detection, Detections, Survey, Verdict } from "../contract";
import { Badge, EmptyState, Label, Panel } from "../shell/components";

export type LiveAnswer = "person" | "not_person" | "unsure";

/** "Second look: likely a person · lying down · red jacket", or "Second look: unclear". Always words. */
/** "relook/f0003-d01-zoom_native.jpg" → "zoom native": which OpenCV 5 tool made the image. */
export function relookName(rel: string): string {
  const base = rel.split("/").at(-1)?.replace(/\.[a-z]+$/i, "") ?? rel;
  const tool = /^f\d{4}-d\d{2}-(.+)$/.exec(base)?.[1] ?? base;
  return tool.replace(/_/g, " ");
}

export function verdictWords(v: Verdict | undefined): string | null {
  if (!v) return null;
  if (v.person === "unclear") return "Second look: unclear";
  if (v.person === "no") return "Second look: probably not a person";
  const parts = ["Second look: likely a person"];
  if (v.posture !== "unknown") parts.push(v.posture === "lying" ? "lying down" : v.posture);
  if (v.group_size && v.group_size > 1) parts.push(`${v.group_size} people`);
  if (v.clothing) parts.push(v.clothing);
  return parts.join(" · ");
}

export function liveReviewItems(detections: Detections | null, promoted: readonly string[]): Detection[] {
  if (!detections) return [];
  return Object.values(detections.frames)
    .flat()
    .filter((d) => d.conf >= detections.candidate_threshold || promoted.includes(d.id))
    .sort((a, b) => b.conf - a.conf || a.id.localeCompare(b.id));
}

const ANSWERS: { id: LiveAnswer; label: string }[] = [
  { id: "person", label: "Person" },
  { id: "not_person", label: "Not a person" },
  { id: "unsure", label: "Unsure" },
];

export function LiveReview({
  detections,
  survey,
  verdicts,
  promoted,
  imageUrl,
  onAnswer,
}: {
  detections: Detections | null;
  survey: Survey | null;
  verdicts: readonly Verdict[];
  promoted: readonly string[];
  imageUrl: (rel: string) => string;
  onAnswer: (detectionId: string, answer: LiveAnswer) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, LiveAnswer>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const items = liveReviewItems(detections, promoted);
  if (items.length === 0) return <EmptyState title="No candidates yet">Candidates appear here as photos are processed.</EmptyState>;
  const latest = new Map<string, Verdict>();
  for (const v of verdicts) latest.set(v.detection_id, v);
  const frameName = (id: string) => survey?.frames.find((f) => f.id === id.slice(0, 5))?.source.image ?? id.slice(0, 5);

  return (
    <section aria-label="Live review" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((d) => {
        const words = verdictWords(latest.get(d.id));
        const answer = answers[d.id];
        return (
          <Panel key={d.id} className="flex flex-col gap-2 p-3" aria-label={`Candidate ${d.id}`}>
            <img
              src={imageUrl(d.crop ?? `crops/nearmiss/${d.id}.jpg`)}
              alt={`Crop of ${d.id}`}
              className="aspect-square w-full rounded-sm object-cover"
            />
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-small text-text">{d.id}</span>
              <span className="font-mono text-small text-text-2">{d.conf.toFixed(2)}</span>
              {promoted.includes(d.id) && <Badge kind="info">Promoted</Badge>}
            </div>
            <Label className="normal-case tracking-normal">{frameName(d.id)}</Label>
            {words && <p className="text-small text-text-2">{words}</p>}
            {(latest.get(d.id)?.relook_crops.length ?? 0) > 0 && (
              // the OpenCV 5 re-look images the second look saw (D-Q1), on demand: they are larger files
              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  className="self-start text-small text-accent-soft underline"
                  aria-expanded={!!shown[d.id]}
                  onClick={() => setShown((x) => ({ ...x, [d.id]: !x[d.id] }))}
                >
                  {shown[d.id] ? "Hide the second look's images" : `Show the second look's images (${latest.get(d.id)!.relook_crops.length})`}
                </button>
                {shown[d.id] && (
                  <div className="grid grid-cols-2 gap-1">
                    {latest.get(d.id)!.relook_crops.map((rel) => (
                      <figure key={rel} className="flex flex-col gap-0.5">
                        <img src={imageUrl(rel)} alt={`Re-look image ${rel}`} className="aspect-square w-full rounded-sm object-cover" />
                        <figcaption className="text-caption text-text-3">{relookName(rel)}</figcaption>
                      </figure>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="flex gap-2">
              {ANSWERS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  aria-pressed={answer === a.id}
                  onClick={() => {
                    setAnswers((x) => ({ ...x, [d.id]: a.id }));
                    onAnswer(d.id, a.id);
                  }}
                  className={`rounded-full border px-3 py-1 text-small ${answer === a.id ? "border-accent text-text" : "border-border text-text-2"}`}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </Panel>
        );
      })}
    </section>
  );
}
