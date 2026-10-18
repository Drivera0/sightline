import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Detection, Frame } from "../contract";
import { cellOfBoxCentre, gridSize, inputGeometry, type InputGeometry } from "./detectorViz";

/** Grid lines are drawn only when a cell is at least this many CSS pixels wide. */
const MIN_LINE_CELL_PX = 6;
/** Cells smaller than this get a ring around them, so the highlight can be found. */
const RING_BELOW_PX = 9;

/** Loads one image for all three canvases; null until it has loaded (or in jsdom). */
function useImage(src: string | undefined): HTMLImageElement | null {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    setImage(null);
    if (!src || typeof Image === "undefined") return;
    let live = true;
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      if (live) setImage(img);
    };
    img.src = src;
    return () => {
      live = false;
    };
  }, [src]);
  return image;
}

function token(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * The photo at one prediction grid: shrunk to one pixel per cell, then drawn back up without
 * smoothing, with faint lines where cells are big enough to see.
 */
function GridCanvas({ image, frame, geom, stride }: { image: HTMLImageElement | null; frame: Frame; geom: InputGeometry; stride: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { cols, rows } = gridSize(geom, stride);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      // Not laid out yet (or jsdom, which has no layout and no canvas): the observer redraws later.
      if (canvas.clientWidth === 0) return;
      let ctx: CanvasRenderingContext2D | null = null;
      try {
        ctx = canvas.getContext("2d");
      } catch {
        ctx = null;
      }
      if (!ctx) return; // jsdom has no canvas
      const cssW = canvas.clientWidth;
      const cssH = (cssW * rows) / cols;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      ctx.fillStyle = token("--bg", "#0a0b0d");
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (image) {
        // One pixel per cell, placed where the letterboxed photo sits in the input.
        const small = document.createElement("canvas");
        small.width = cols;
        small.height = rows;
        const sctx = small.getContext("2d");
        if (sctx) {
          sctx.imageSmoothingEnabled = true;
          sctx.imageSmoothingQuality = "high";
          sctx.drawImage(
            image,
            geom.padLeft / stride,
            geom.padTop / stride,
            (frame.width_px * geom.scale) / stride,
            (frame.height_px * geom.scale) / stride,
          );
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(small, 0, 0, canvas.width, canvas.height);
        }
      }
      const cellCss = cssW / cols;
      if (cellCss >= MIN_LINE_CELL_PX) {
        ctx.strokeStyle = token("--border", "rgba(255,255,255,0.12)");
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let c = 1; c < cols; c++) {
          const x = Math.round((c * canvas.width) / cols) + 0.5;
          ctx.moveTo(x, 0);
          ctx.lineTo(x, canvas.height);
        }
        for (let r = 1; r < rows; r++) {
          const y = Math.round((r * canvas.height) / rows) + 0.5;
          ctx.moveTo(0, y);
          ctx.lineTo(canvas.width, y);
        }
        ctx.stroke();
      }
    };
    draw();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [image, frame, geom, stride, cols, rows]);

  return <canvas ref={ref} className="absolute inset-0 h-full w-full [image-rendering:pixelated]" aria-hidden="true" />;
}

interface Props {
  frame: Frame | undefined;
  photo: string | undefined;
  /** The photo's most confident box, if any. */
  top: Detection | undefined;
  imgsz: number;
  strides: readonly number[];
  /** Changes per photo, so the highlight settles in again. */
  pulseKey: string;
  /** Shown beside the three grids. */
  caption?: ReactNode;
}

/**
 * The current photo at the head's three prediction grids (stride 8, 16, 32 of one imgsz pass),
 * with the cell that contains the top box's centre highlighted.
 */
export function ModelGrids({ frame, photo, top, imgsz, strides, pulseKey, caption }: Props) {
  const image = useImage(photo);
  const width = frame?.width_px ?? 0;
  const height = frame?.height_px ?? 0;
  const geom = useMemo(() => inputGeometry(width || 1, height || 1, imgsz), [width, height, imgsz]);
  if (!frame) return null;
  return (
    <div className="grid grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,0.95fr)] gap-2">
      {strides.map((stride, i) => {
        const { cols, rows } = gridSize(geom, stride);
        const cell = cellOfBoxCentre(top?.box_px, geom, stride);
        return (
          <figure key={stride} className="flex min-w-0 flex-col gap-1">
            <div
              className="relative w-full overflow-hidden rounded-[8px] border border-border bg-surface-strong"
              style={{ aspectRatio: `${cols} / ${rows}` }}
              data-testid={`grid-stride-${stride}`}
            >
              <GridCanvas image={image} frame={frame} geom={geom} stride={stride} />
              {cell && (
                <GridHighlight key={`${pulseKey}-${stride}`} col={cell.col} row={cell.row} cols={cols} rows={rows} />
              )}
            </div>
            <figcaption className="flex items-baseline justify-between gap-1 whitespace-nowrap font-mono text-[10px] text-text-3">
              <span className="text-text-2" title={`P${i + 3}: stride ${stride}`}>
                stride {stride}
              </span>
              <span>
                {cols}×{rows}
              </span>
            </figcaption>
          </figure>
        );
      })}
      {caption}
    </div>
  );
}

function GridHighlight({ col, row, cols, rows }: { col: number; row: number; cols: number; rows: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [small, setSmall] = useState(true);
  useEffect(() => {
    const parent = ref.current?.parentElement;
    if (parent && parent.clientWidth > 0) setSmall(parent.clientWidth / cols < RING_BELOW_PX);
  }, [cols]);
  const left = (col / cols) * 100;
  const top = (row / rows) * 100;
  return (
    <>
      <span
        ref={ref}
        data-testid="grid-cell"
        className="sl-cell absolute border border-accent bg-accent/45 shadow-[0_0_10px_2px_color-mix(in_srgb,var(--accent)_70%,transparent)]"
        style={{ left: `${left}%`, top: `${top}%`, width: `${100 / cols}%`, height: `${100 / rows}%` }}
      />
      {small && (
        <span
          aria-hidden="true"
          className="sl-ring pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-accent-soft/80"
          style={{ left: `${left + 50 / cols}%`, top: `${top + 50 / rows}%` }}
        />
      )}
    </>
  );
}
