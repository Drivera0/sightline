import { useCallback, useEffect, useRef, useState } from "react";
import type { CacheBundle } from "../contract";
import { cacheUrl } from "../lib/cache";
import { reviewItems } from "../review/items";
import { Badge, Label, Panel } from "../shell/components";
import { detectPhoto, loadDetector, modelAvailable, type Backend } from "./runDetector";
import { OVERLAP, SLICE_PX, type Detection } from "./tiling";

type Phase =
  | { kind: "idle" }
  | { kind: "model"; loaded: number; total: number | null }
  | { kind: "running"; done: number; total: number }
  | { kind: "done"; ms: number }
  | { kind: "error"; message: string };

interface Shown {
  url: string;
  name: string;
  width: number;
  height: number;
  /** The pipeline's own boxes for a survey photo, to compare with. */
  reference?: { box: [number, number, number, number]; conf: number }[];
}

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

/**
 * "Try your own photo": the detector, running in the visitor's browser on a photo they drop in.
 * Same weights, slicing, merge and threshold as the pipeline. Said plainly: it runs on their
 * device, and on photos that aren't aerial search photos its boxes mean nothing.
 */
export function TryPhoto({ cache, dir, onClose }: { cache: CacheBundle; dir: string; onClose: () => void }) {
  const threshold = cache.metrics.detector.threshold;
  const [available, setAvailable] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [backend, setBackend] = useState<Backend | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [boxes, setBoxes] = useState<Detection[]>([]);
  const [dragging, setDragging] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const busy = phase.kind === "model" || phase.kind === "running";
  const urlToRevoke = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    void modelAvailable().then((ok) => live && setAvailable(ok));
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    return () => {
      live = false;
      previous?.focus();
      if (urlToRevoke.current) URL.revokeObjectURL(urlToRevoke.current);
    };
  }, []);

  useEffect(() => {
    // While the dialog is open, the page's own shortcuts (1-5, review keys) stay out of the way.
    const onKey = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const run = useCallback(
    async (blob: Blob, name: string, reference?: Shown["reference"]) => {
      if (busy) return;
      setBoxes([]);
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(blob);
      } catch {
        setPhase({ kind: "error", message: "That file could not be read as an image. Try a JPEG or PNG." });
        return;
      }
      if (urlToRevoke.current) URL.revokeObjectURL(urlToRevoke.current);
      const url = URL.createObjectURL(blob);
      urlToRevoke.current = url;
      setShown({ url, name, width: bitmap.width, height: bitmap.height, reference });
      try {
        setPhase({ kind: "model", loaded: 0, total: null });
        const detector = await loadDetector((loaded, total) => setPhase({ kind: "model", loaded, total }));
        setBackend(detector.backend);
        const start = performance.now();
        const dets = await detectPhoto(detector, bitmap, (done, total) => setPhase({ kind: "running", done, total }));
        setBoxes(dets);
        setPhase({ kind: "done", ms: performance.now() - start });
      } catch (err) {
        setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        bitmap.close();
      }
    },
    [busy],
  );

  const onFile = (file: File | undefined) => {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      setPhase({ kind: "error", message: "Please choose an image file (JPEG or PNG)." });
      return;
    }
    void run(file, file.name);
  };

  // Survey photos with a candidate: real HERIDAL sections, with the pipeline's boxes to compare.
  const samples = reviewItems(cache)
    .slice(0, 3)
    .map((item) => ({
      frame: item.frame,
      reference: (cache.detections.frames[item.frame.id] ?? [])
        .filter((d) => d.conf >= threshold)
        .map((d) => ({ box: d.box_px as [number, number, number, number], conf: d.conf })),
    }));

  const trySample = async (s: (typeof samples)[number]) => {
    try {
      const res = await fetch(cacheUrl(dir, s.frame.file));
      const blob = await res.blob();
      await run(blob, `Survey photo ${s.frame.id}`, s.reference);
    } catch {
      setPhase({ kind: "error", message: "Could not load that survey photo." });
    }
  };

  const kept = boxes.filter((b) => b.conf >= threshold);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-bg/75 p-4 backdrop-blur-sm sm:items-center sm:p-6" onClick={busy ? undefined : onClose}>
      <Panel
        role="dialog"
        aria-modal="true"
        aria-label="Try your own photo"
        className="flex w-full max-w-4xl flex-col gap-4 bg-bg/95"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Try your own photo</Label>
            <h2 className="text-title font-medium">Run Sightline&apos;s detector in your browser</h2>
          </div>
          <button
            ref={closeButton}
            type="button"
            onClick={onClose}
            className="rounded-sm px-2 py-1 text-small text-text-2 hover:text-text"
          >
            Close
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          <Badge kind="info">Runs on your device</Badge>
          <Badge kind="placeholder">Aerial search photos only</Badge>
        </div>
        <p className="text-small text-text-2">
          Your photo never leaves this browser: the model downloads once from this site and runs here
          {backend ? ` (${backend === "webgpu" ? "WebGPU" : "WebAssembly"})` : ""}. It was trained on HERIDAL drone photos
          of people in rough terrain seen from above, so on anything else (selfies, street photos, close-ups) its boxes
          are meaningless. Same weights, {SLICE_PX} px slices with {Math.round(OVERLAP * 100)}% overlap, merge and
          threshold ({threshold}, metrics.detector) as the pipeline.
        </p>

        {available === false ? (
          <p className="rounded-sm border border-warn/40 bg-warn/10 px-4 py-3 text-small text-warn">
            The detector model is not included in this build of the site, so this panel can&apos;t run here.
          </p>
        ) : (
          <>
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                onFile(e.dataTransfer.files[0]);
              }}
              className={
                "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed px-4 py-6 text-center transition-colors " +
                (dragging ? "border-accent bg-accent/10" : "border-border bg-surface hover:border-text-3") +
                (busy ? " pointer-events-none opacity-50" : "")
              }
            >
              <span className="text-body text-text">Drop a JPEG here, or tap to choose one</span>
              <span className="text-small text-text-3">Drone photos taken from roughly 30 to 60 m work best</span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                disabled={busy}
                onChange={(e) => onFile(e.target.files?.[0])}
              />
            </label>
            {samples.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-small text-text-3">
                Or a survey photo:
                {samples.map((s) => (
                  <button
                    key={s.frame.id}
                    type="button"
                    disabled={busy}
                    onClick={() => void trySample(s)}
                    className="inline-flex items-center gap-2 rounded-full border border-border px-2 py-1 text-text-2 hover:border-accent/60 hover:text-text disabled:opacity-40"
                  >
                    <img src={cacheUrl(dir, s.frame.file)} alt="" className="size-6 rounded-full object-cover" />
                    {s.frame.id}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        <Status phase={phase} kept={kept.length} />

        {shown && (
          <figure className="flex flex-col gap-2">
            <div className="relative overflow-hidden rounded-md bg-surface-strong">
              <img src={shown.url} alt={shown.name} className="block max-h-[60vh] w-full object-contain" />
              <BoxLayer shown={shown} boxes={kept} />
            </div>
            <figcaption className="flex flex-wrap items-baseline justify-between gap-2 text-small text-text-3">
              <span>
                {shown.name} · {shown.width}×{shown.height} px
              </span>
              {shown.reference && (
                <span>
                  Dashed white: the pipeline&apos;s boxes for this photo ({shown.reference.length}), from the full
                  4000×3000 photo, so slicing differs slightly.
                </span>
              )}
            </figcaption>
            {kept.length > 0 && (
              <ul className="flex flex-wrap gap-1.5" aria-label="Detections">
                {kept.map((b, i) => (
                  <li key={i} className="rounded-full bg-accent/15 px-2.5 py-0.5 font-mono text-label text-accent-soft">
                    {b.conf.toFixed(2)}
                  </li>
                ))}
              </ul>
            )}
          </figure>
        )}
      </Panel>
    </div>
  );
}

function Status({ phase, kept }: { phase: Phase; kept: number }) {
  if (phase.kind === "idle") return null;
  if (phase.kind === "error") {
    return (
      <p role="alert" className="text-small text-warn">
        {phase.message}
      </p>
    );
  }
  const [label, fraction] =
    phase.kind === "model"
      ? [
          phase.total ? `Downloading the model: ${mb(phase.loaded)} of ${mb(phase.total)}` : `Downloading the model: ${mb(phase.loaded)}`,
          phase.total ? phase.loaded / phase.total : 0.05,
        ]
      : phase.kind === "running"
        ? [`Reading slice ${Math.min(phase.done + 1, phase.total)} of ${phase.total}`, phase.done / phase.total]
        : [`${kept} ${kept === 1 ? "person" : "people"} flagged in ${(phase.ms / 1000).toFixed(1)} s on this device`, 1];
  return (
    <div className="flex flex-col gap-1.5" role="status" aria-live="polite">
      <span className="text-small text-text-2">{label}</span>
      <span className="h-1 overflow-hidden rounded-full bg-surface-strong">
        <span
          className={"block h-full rounded-full transition-[width] duration-300 " + (phase.kind === "done" ? "bg-ok" : "bg-accent")}
          style={{ width: `${Math.round(fraction * 100)}%` }}
        />
      </span>
    </div>
  );
}

function BoxLayer({ shown, boxes }: { shown: Shown; boxes: Detection[] }) {
  // Same box and the same "contain" fit as the image, so photo pixels line up.
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox={`0 0 ${shown.width} ${shown.height}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {shown.reference?.map((r, i) => (
        <rect
          key={`ref-${i}`}
          x={r.box[0]}
          y={r.box[1]}
          width={r.box[2] - r.box[0]}
          height={r.box[3] - r.box[1]}
          fill="none"
          stroke="var(--text)"
          strokeDasharray="6 5"
          strokeWidth={Math.max(1.5, shown.width / 500)}
          vectorEffect="non-scaling-stroke"
          opacity={0.8}
        />
      ))}
      {boxes.map((b, i) => {
        const pad = Math.max(6, shown.width / 250);
        return (
          <g key={i}>
            <rect
              x={b.box[0] - pad}
              y={b.box[1] - pad}
              width={b.box[2] - b.box[0] + 2 * pad}
              height={b.box[3] - b.box[1] + 2 * pad}
              rx={pad}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={b.box[0] - pad}
              y={b.box[1] - pad * 1.6}
              fill="var(--accent-soft)"
              fontSize={Math.max(14, shown.width / 60)}
              fontFamily="var(--mono)"
            >
              {b.conf.toFixed(2)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
