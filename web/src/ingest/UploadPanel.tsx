// After each flight: drag a folder or many JPEGs in; they go up in batches of 10 with a progress bar,
// and files the API refuses are listed with its reason ("no GPS position…"). LANE_D §5.6 D-I1.

import { useState, type DragEvent } from "react";
import * as defaultApi from "../lib/api";
import type { Api, UploadResult } from "../lib/api";
import { Label, Panel } from "../shell/components";
import { batches, hostLabel, photoFiles, uploadCommand } from "./upload";

/**
 * During the flight: the `watch` command for the laptop the photos land on. The prose names the host
 * ("connected to 127.0.0.1"); the exact command, origin and all, is in the code line and on the Copy button.
 */
export function WatchPanel({ base, missionId }: { base: string; missionId: string }) {
  const command = uploadCommand(base, missionId);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(command).then(
      () => setCopied(true),
      () => undefined,
    );
  };
  return (
    <Panel className="flex flex-col gap-2" aria-label="During the flight">
      <Label>During the flight</Label>
      <p className="text-body text-text-2">
        On the laptop the drone's photos land on, watch the folder: each photo is sent once its copy has finished, in batches of up to
        10, and kept in a queue while there is no connection. This mission is connected to <span className="text-text">{hostLabel(base)}</span>;
        run this, with PHOTO_FOLDER replaced by the SD card or sync folder:
      </p>
      <code aria-label="Watch command" className="block overflow-x-auto whitespace-pre-wrap break-all rounded-sm bg-surface-strong p-2 font-mono text-caption text-text-2">
        {command}
      </code>
      <button type="button" className="sl-tap self-start rounded-full border border-border px-3 py-1 text-small text-text-2" onClick={copy}>
        {copied ? "Copied" : "Copy the command"}
      </button>
      <p className="text-small text-text-3">In production the drone maker's own cloud upload would post here directly (roadmap).</p>
    </Panel>
  );
}

/** A thin progress bar with its words (the native <progress> keeps its role and numbers for screen readers). */
function Bar({ label, value, max, words }: { label: string; value: number; max: number; words: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="relative h-1.5 overflow-hidden rounded-full bg-surface-strong">
        <div className="absolute inset-y-0 left-0 rounded-full bg-ok transition-[width] duration-300" style={{ width: `${pct}%` }} />
        <progress className="sr-only" max={max} value={value} aria-label={label} />
      </div>
      <span className="text-caption text-text-2">{words}</span>
    </div>
  );
}

export function UploadPanel({
  api,
  missionId,
  upload = defaultApi.uploadPhotos,
  processed,
}: {
  api: Api;
  missionId: string;
  upload?: typeof defaultApi.uploadPhotos;
  /** Photos the detector has finished (photo.processed events), for the second bar. */
  processed?: number;
}) {
  const [sent, setSent] = useState(0);
  const [total, setTotal] = useState(0);
  const [accepted, setAccepted] = useState(0);
  const [rejected, setRejected] = useState<UploadResult["rejected"]>([]);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  const send = async (files: Iterable<File>) => {
    const { photos, skipped } = photoFiles(files);
    setRejected((r) => [...r, ...skipped]);
    setTotal((t) => t + photos.length);
    setError(null);
    for (const batch of batches(photos)) {
      try {
        const r = await upload(api, missionId, batch);
        setAccepted((n) => n + r.accepted.length);
        setRejected((x) => [...x, ...r.rejected]);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setRejected((x) => [...x, ...batch.map((f) => ({ name: f.name, reason: "upload failed" }))]);
      }
      setSent((n) => n + batch.length);
    }
  };

  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void send(Array.from(e.dataTransfer.files));
  };

  return (
    <Panel className="flex flex-col gap-3" aria-label="Upload photos">
      <Label>After each flight</Label>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        className={`flex flex-col items-center gap-2 rounded-md border border-dashed p-6 text-center ${over ? "border-accent bg-accent/10" : "border-border"}`}
      >
        <p className="text-body text-text">Drag the photos from the SD card here</p>
        <label className="cursor-pointer text-small text-accent-soft underline">
          or choose files
          <input
            type="file"
            multiple
            accept="image/jpeg"
            className="sr-only"
            aria-label="Choose photos"
            onChange={(e) => e.target.files && void send(Array.from(e.target.files))}
          />
        </label>
      </div>
      {total > 0 && (
        <div className="flex flex-col gap-2">
          <Bar label="Upload progress" value={sent} max={total} words={`${sent} / ${total} sent · ${accepted} accepted`} />
          {processed !== undefined && accepted > 0 && (
            <Bar
              label="Detector progress"
              value={Math.min(processed, accepted)}
              max={accepted}
              words={processed >= accepted ? `all ${accepted} ranked by the detector` : `${processed} / ${accepted} ranked by the detector…`}
            />
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-small text-warn">
          {error}
        </p>
      )}
      {rejected.length > 0 && (
        <div role="group" aria-label="Rejected files" className="flex flex-col gap-1">
          <Label className="text-warn">Not used ({rejected.length})</Label>
          <ul className="max-h-40 overflow-auto text-small text-text-2">
            {rejected.map((r, i) => (
              <li key={`${r.name}-${i}`}>
                <span className="font-mono text-text">{r.name}</span>: {r.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
