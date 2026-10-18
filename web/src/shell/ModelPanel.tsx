import { memo, useMemo, useRef, useState, type ReactNode } from "react";
import type { CacheBundle, Detection, Frame } from "../contract";
import { cacheUrl } from "../lib/cache";
import {
  architectureName,
  boxValuesPerLocation,
  detectorSpec,
  formatMillions,
  formatShape,
  gridLocations,
  inputsOf,
  pyramidLevels,
  stageOf,
  type SpecLayer,
} from "../metrics/detectorSpec";
import { prefersReducedMotion } from "../metrics/motion";
import { Badge, Label } from "./components";
import { scoreHistogram, surveyScores, topDetection, type ScoreHistogram } from "./detectorViz";
import { layerTitle, ModelGraph } from "./ModelGraph";
import { ModelGrids } from "./ModelGrids";

/** Where the training facts come from (not in the cache). */
const TRAINING_SOURCE = "scripts/README.md and the weights-v2 release notes";
const SPEED_SOURCE =
  "metrics.detector.seconds_per_image: mean wall time of tiled detection on a full 4000×3000 HERIDAL test photo, on an RTX 4080 SUPER (docs/LANE_A_ML.md, scripts/README.md)";
const CLASS_SOURCE =
  "nc = 1 in the weights. Trained with single_cls on the HERIDAL person labels (scripts/tile_dataset.py names class 0 'person'; Ultralytics stores a single_cls class as 'item').";
/** The training set size is quoted from scripts/README.md (it is not stored in the weights). */
const TRAINING_PHOTOS = 890;

interface Props {
  cache: CacheBundle;
  dir: string;
  /** The photo being scored (or the lead candidate's photo once the scan is done). */
  frame: Frame | undefined;
  /** Every box the model kept for that photo (at or above the save threshold). */
  boxes: Detection[];
  /** Changes on every photo, so the signal runs again. */
  pulseKey: string;
  /** How long the scanner rests on this photo, in milliseconds. */
  stopMs: number;
  done: boolean;
}

/**
 * "Inside the detector": the network the scanner runs, drawn from our weights' real layer table
 * (detectorSpec.json), with a signal running through it for every photo the scan stops on; the
 * photo at the head's three prediction grids; and the photo's real top score against every box
 * in detections.json and the flag threshold. The graph is a schematic, labelled as such: the
 * model does not run in the browser.
 */
export const ModelPanel = memo(function ModelPanel({ cache, dir, frame, boxes, pulseKey, stopMs, done }: Props) {
  const { detections, metrics } = cache;
  const spec = detectorSpec;
  const threshold = detections.candidate_threshold;
  const [motion] = useState(() => !prefersReducedMotion());
  const [view, setView] = useState<"graph" | "table">("graph");
  const [hover, setHover] = useState<SpecLayer | "input" | undefined>(undefined);

  const best = topDetection(boxes);
  const top = best?.conf;
  const photo = frame ? cacheUrl(dir, frame.file) : undefined;
  const locations = gridLocations(spec.imgsz, spec.strides);
  const levels = pyramidLevels(spec);
  const seconds = metrics.detector.seconds_per_image;

  const readout =
    hover === "input"
      ? `Input · ${spec.imgsz}²×3: the photo, letterboxed to ${spec.imgsz} px`
      : hover
        ? layerTitle(hover, spec)
        : undefined;

  return (
    <section
      aria-label="Inside the detector"
      className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-surface p-4 [box-shadow:inset_0_1px_0_0_var(--surface-strong)]"
    >
      {/* Header */}
      <div className="flex shrink-0 flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <Label className="text-text-2">Inside the detector</Label>
          <span className="truncate font-mono text-label text-text-3" title="detections.model">
            {detections.model}
          </span>
        </div>
        <ul className="flex flex-wrap gap-1.5" aria-label="Detector facts">
          <Chip title={`Base model: ${spec.train_base_model ?? "yolo11s"} (Ultralytics)`}>{architectureName(spec)}</Chip>
          <Chip title="Input size: sightline/ml/detect.py runs the detector at imgsz=1024">{spec.imgsz} px</Chip>
          <Chip title={`${spec.total_params.toLocaleString("en-US")} parameters, counted from the weights`}>
            {formatMillions(spec.total_params)} parameters
          </Chip>
          <Chip title="Layers in the weights' model table">{spec.n_layers} layers</Chip>
          <Chip title={CLASS_SOURCE}>{spec.nc} class: person</Chip>
        </ul>
      </div>

      {/* Architecture */}
      <div className="flex flex-col gap-1.5 xl:flex-1">
        <div className="flex items-center justify-between gap-2">
          <Label>Architecture</Label>
          <div className="flex rounded-full border border-border p-0.5 text-[11px]" role="group" aria-label="Architecture view">
            {(["graph", "table"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className={
                  "rounded-full px-2.5 py-0.5 font-mono transition-colors " +
                  (view === v ? "bg-surface-strong text-text" : "text-text-3 hover:text-text-2")
                }
              >
                {v === "graph" ? "Graph" : "Layer table"}
              </button>
            ))}
          </div>
        </div>
        {/* Fixed height in the stacked layout; in the three-column layout it takes the room left. */}
        <div className="relative h-[min(250px,52vw)] w-full shrink-0 xl:h-auto xl:min-h-[140px] xl:flex-1 xl:shrink">
          {view === "graph" ? (
            <div key="graph" className="sl-fade absolute inset-0">
              <ModelGraph
                photo={photo}
                top={top}
                threshold={threshold}
                pulseKey={motion && !done ? pulseKey : undefined}
                waveMs={Math.round(stopMs * 0.8)}
                onHover={setHover}
                spec={spec}
              />
            </div>
          ) : (
            <div key="table" className="sl-fade absolute inset-0">
              <LayerTable />
            </div>
          )}
        </div>
        <p className="text-[12px] leading-snug text-text-3">
          <span className="text-text-2" title="Drawn from detectorSpec.json (every layer's type, links and output shape). The model does not run in the browser.">
            Schematic of our weights&apos; real layers, not live activations.
          </span>{" "}
          {view === "graph" && readout ? (
            <span className="font-mono text-[11px] text-text-2">{readout}</span>
          ) : (
            <span title={`Detect output at a ${spec.imgsz}² input: ${spec.layers[spec.layers.length - 1]?.out_shape.join(" × ")}`}>
              <span className="font-mono text-text-2">{locations.toLocaleString("en-US")}</span> grid locations per{" "}
              {spec.imgsz} px pass ({levels.map((l) => `${spec.imgsz / l.stride}²`).join(" + ")}), each with{" "}
              {boxValuesPerLocation(spec)} box values and {spec.nc} person score.
            </span>
          )}
        </p>
      </div>

      {/* Prediction grids */}
      {frame && (
        <div className="shrink-0">
          <ModelGrids
            frame={frame}
            photo={photo}
            top={best}
            imgsz={spec.imgsz}
            strides={spec.strides}
            pulseKey={pulseKey}
            caption={
              <p
                className="flex flex-col gap-1 self-start text-[11px] leading-snug text-text-3"
                title={`Cells for one ${spec.imgsz} px pass of this ${frame.width_px}×${frame.height_px} photo. Demo frames are scored in one pass; full-size photos are scored in ${spec.imgsz} px tiles, where each cell covers less of the photo.`}
              >
                <Label className="text-text-3">Grids</Label>
                <span>
                  One square per prediction location, pixelated for scale.{" "}
                </span>
                {best ? (
                  <span className="text-accent-soft">Orange: cell containing the top box&apos;s centre.</span>
                ) : (
                  <span>No box, so no cell is highlighted.</span>
                )}
              </p>
            }
          />
        </div>
      )}

      {/* Score distribution and verdict (in the scanner column on wide screens, where there is room) */}
      <ScoreStrip cache={cache} boxes={boxes} done={done} className="xl:hidden" />

      {/* Sources */}
      <div className="flex shrink-0 items-start gap-2.5 border-t border-border pt-3">
        <Badge kind="info">Schematic</Badge>
        <p className="text-[11px] leading-snug text-text-3">
          <span title={`${spec.source} on ${spec.weights_file}, sha256 ${spec.weights_sha256}`}>
            Layers: {spec.source.replace("scripts/analysis/", "")} ({spec.weights_sha256.slice(0, 8)}…)
          </span>
          {" · "}
          <span title="Ultralytics YOLO11 model and architecture guides">docs.ultralytics.com/models/yolo11</span>
          {" · "}
          <span title={TRAINING_SOURCE}>
            {spec.train_epochs} epochs on {spec.train_imgsz} px tiles, {TRAINING_PHOTOS} labelled HERIDAL photos
          </span>
          {" · "}
          <span title={SPEED_SOURCE}>{seconds.toFixed(2)} s/photo</span>
        </p>
      </div>
    </section>
  );
});

/**
 * Every box's score with the flag threshold and the current photo's top score, and the verdict
 * for the photo (or the survey totals once the scan is done).
 */
export const ScoreStrip = memo(function ScoreStrip({
  cache,
  boxes,
  done,
  className = "",
}: {
  cache: CacheBundle;
  boxes: Detection[];
  done: boolean;
  className?: string;
}) {
  const { detections, survey } = cache;
  const threshold = detections.candidate_threshold;
  const totals = useMemo(() => surveyScores(detections), [detections]);
  const hist = useMemo(
    () => scoreHistogram(totals.confs, threshold, detections.save_threshold, 1, 0.05),
    [totals, threshold, detections.save_threshold],
  );
  const top = topDetection(boxes)?.conf;
  return (
    <div className={"flex shrink-0 flex-col gap-3 " + className}>
        <ScoreDistribution hist={hist} threshold={threshold} top={done ? undefined : top} nPhotos={survey.frames.length} />

        <p className="shrink-0 text-small text-text-2">
          {done ? (
            <>
              <span className="font-mono text-text">{totals.boxes}</span> boxes kept across {survey.frames.length} photos ·{" "}
              <span className="font-mono text-accent-soft">{totals.above}</span> at or above {threshold} ·{" "}
              <span className="font-mono text-accent-soft">{totals.photosFlagged}</span>{" "}
              {totals.photosFlagged === 1 ? "photo" : "photos"} flagged for review.
            </>
          ) : top === undefined ? (
            <>
              No box at or above {detections.save_threshold} · <span className="text-text-3">Nothing to score</span>
            </>
          ) : top >= threshold ? (
            <>
              Top score <span className="font-mono text-text">{top.toFixed(2)}</span> ≥ {threshold} ·{" "}
              <span className="text-accent-soft">Flagged for review</span>
            </>
          ) : (
            <>
              Top score <span className="font-mono text-text">{top.toFixed(2)}</span> &lt; {threshold} ·{" "}
              <span className="text-text-3">Not flagged</span>
            </>
          )}
        </p>
    </div>
  );
});

function Chip({ children, title }: { children: ReactNode; title: string }) {
  return (
    <li title={title} className="rounded-full border border-border bg-surface-strong px-2 py-0.5 font-mono text-[10.5px] text-text-2">
      {children}
    </li>
  );
}

/** Every layer of the weights: index, type, inputs, output shape, parameters. */
function LayerTable() {
  const spec = detectorSpec;
  const levelOf = new Map(pyramidLevels(spec).map((l) => [l.layer.index, l.name] as const));
  return (
    <div className="absolute inset-0 overflow-auto rounded-sm border border-border">
      <table className="w-full border-collapse text-left font-mono text-[11px]">
        <caption className="sr-only">Every layer of the detector weights</caption>
        <thead className="sticky top-0 bg-bg text-text-3">
          <tr>
            <th className="px-2 py-1 font-normal">#</th>
            <th className="px-2 py-1 font-normal">Layer</th>
            <th className="px-2 py-1 font-normal">From</th>
            <th className="px-2 py-1 font-normal">Output</th>
            <th className="px-2 py-1 text-right font-normal">Params</th>
          </tr>
        </thead>
        <tbody>
          {spec.layers.map((layer) => {
            const level = levelOf.get(layer.index);
            return (
              <tr key={layer.index} className="border-t border-border/60 text-text-2">
                <td className="px-2 py-0.5 text-text-3">{layer.index}</td>
                <td className="px-2 py-0.5 text-text">
                  {layer.type}
                  <span className="ml-1.5 text-text-3">{stageOf(layer, spec)}</span>
                </td>
                <td className="px-2 py-0.5">
                  {inputsOf(layer)
                    .map((i) => (i < 0 ? "in" : i))
                    .join(", ")}
                </td>
                <td className="px-2 py-0.5">
                  {layer.type === "Detect" ? layer.out_shape.join("×") : formatShape(layer.out_shape)}
                  {level && <span className="ml-1.5 text-accent-soft">{level}</span>}
                </td>
                <td className="px-2 py-0.5 text-right">{layer.params.toLocaleString("en-US")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Histogram of every box in detections.json, coloured box by box against the flag threshold, with
 * the threshold line and a marker that slides to the current photo's top score.
 */
function ScoreDistribution({
  hist,
  threshold,
  top,
  nPhotos,
}: {
  hist: ScoreHistogram;
  threshold: number;
  top: number | undefined;
  nPhotos: number;
}) {
  const pct = (v: number) => ((Math.min(hist.hi, Math.max(hist.lo, v)) - hist.lo) / (hist.hi - hist.lo)) * 100;
  const t = pct(threshold);
  const m = top === undefined ? undefined : pct(top);
  // With no box the marker fades out where it was, instead of sliding to the left edge.
  const last = useRef({ at: 0, label: "" });
  if (m !== undefined && top !== undefined) last.current = { at: m, label: top.toFixed(2) };
  const at = m ?? last.current.at;
  return (
    <figure className="flex shrink-0 flex-col gap-1" aria-label={`Scores of all ${hist.total} boxes kept`}>
      <div className="flex items-baseline justify-between gap-2">
        <Label>Every box kept</Label>
        <span className="font-mono text-[11px] text-text-3" title="detections.json: every box at or above save_threshold">
          {hist.total} boxes ≥ {hist.lo} in {nPhotos} photos
        </span>
      </div>
      {/* The marker's label, kept inside the chart at either end. */}
      <div className="relative h-3.5 font-mono text-[10px] leading-none">
        <span
          className="absolute whitespace-nowrap text-accent-soft transition-[left,transform,opacity] duration-700 ease-out motion-reduce:transition-none"
          style={{ left: `${at}%`, transform: `translateX(-${at}%)`, opacity: m === undefined ? 0 : 1 }}
        >
          this photo {last.current.label}
        </span>
      </div>
      <div className="relative h-10">
        <div className="absolute inset-0 flex items-end gap-px">
          {hist.bins.map((b) => {
            const n = b.above + b.below;
            return (
              <div
                key={b.lo}
                className="flex h-full min-w-0 flex-1 flex-col justify-end"
                title={`${b.lo.toFixed(2)}–${b.hi.toFixed(2)}: ${n} ${n === 1 ? "box" : "boxes"}${b.above && b.below ? ` (${b.above} at or above ${threshold})` : ""}`}
              >
                {b.above > 0 && (
                  <span className="w-full rounded-t-[2px] bg-accent" style={{ height: `max(2px, ${(b.above / hist.max) * 100}%)` }} />
                )}
                {b.below > 0 && (
                  <span
                    className={"w-full bg-text-3/45 " + (b.above > 0 ? "" : "rounded-t-[2px]")}
                    style={{ height: `max(2px, ${(b.below / hist.max) * 100}%)` }}
                  />
                )}
                {n === 0 && <span className="h-px w-full bg-border" />}
              </div>
            );
          })}
        </div>
        <span aria-hidden="true" className="absolute -inset-y-1 w-px bg-text" style={{ left: `${t}%` }} />
        <span
          aria-hidden="true"
          data-testid="score-marker"
          className="absolute -top-1 bottom-0 w-0.5 -translate-x-1/2 rounded-full bg-accent-soft shadow-[0_0_8px_color-mix(in_srgb,var(--accent)_70%,transparent)] transition-[left,opacity] duration-700 ease-out motion-reduce:transition-none"
          style={{ left: `${at}%`, opacity: m === undefined ? 0 : 1 }}
        />
      </div>
      <div className="relative h-3.5 font-mono text-[10px] text-text-3">
        <span className="absolute left-0">{hist.lo}</span>
        <span className="absolute whitespace-nowrap text-text-2" style={{ left: `${t}%`, transform: "translateX(-50%)" }}>
          flag at {threshold}
        </span>
        <span className="absolute right-0">{hist.hi.toFixed(1)}</span>
      </div>
    </figure>
  );
}
