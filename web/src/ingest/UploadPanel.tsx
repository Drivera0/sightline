// After each flight: drag a folder or many JPEGs in; they go up in batches of 10 with a progress bar,
// and files the API refuses are listed with its reason ("no GPS position…"). LANE_D §5.6 D-I1.

import { useState, type DragEvent } from "react";
import * as defaultApi from "../lib/api";
import type { Api, UploadResult } from "../lib/api";
import { Label, Panel } from "../shell/components";
import { batches, photoFiles } from "./upload";

export function UploadPanel({
  api,
  missionId,
  upload = defaultApi.uploadPhotos,
}: {
  api: Api;
  missionId: string;
  upload?: typeof defaultApi.uploadPhotos;
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
        <div className="flex flex-col gap-1">
          <progress className="w-full accent-accent" max={total} value={sent} aria-label="Upload progress" />
          <span className="font-mono text-small text-text-2">
            {sent} / {total} sent · {accepted} accepted
          </span>
        </div>
      )}
      {error && (
        <p role="alert" className="text-small text-warn">
          {error}
        </p>
      )}
      {rejected.length > 0 && (
        <div aria-label="Rejected files" className="flex flex-col gap-1">
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
