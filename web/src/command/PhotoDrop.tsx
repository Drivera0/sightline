// Drop a drone's photos onto the Photos view. On the demo (no server) each photo is read and ranked in the
// browser: its EXIF GPS (and DJI's relative altitude and heading) places it, the same ONNX detector as Try a
// photo ranks it, the ground under it is lowered on the map (a photo step at the drone's POD), its
// candidates go to Needs you, and each step is logged on the timeline. "Load 20 sample photos" fetches the
// sample pack (VITE_SAMPLE_PHOTOS_URL: a JSON list of photo addresses) or, without it or offline, uses the
// demo survey's own photos with their recorded poses. On a live mission the same drop uploads to
// POST /missions/{id}/photos and the server ranks them. Built by lane A.
import { useState, type DragEvent } from "react";
import { create } from "zustand";
import type { CacheBundle } from "../contract";
import { uploadPhotos, type Api } from "../lib/api";
import { cacheUrl } from "../lib/cache";
import { footprintRadiusM, readPose, type PhotoPose } from "../lib/exif";
import { DRONE_POD, useMission } from "../lib/mission";
import type { ReviewCard } from "../review/LiveReview";
import { cellsWithinRadius } from "../search/update";
import { Button } from "../shell/components";

/** The hint on an empty Photos view. */
export const DROP_HINT = "Drop a drone's photos here to see them ranked and placed";
const SAMPLE_COUNT = 20;
const M_PER_DEG = 111_320;

interface Dropped {
  cards: ReviewCard[];
  /** Where each candidate is (its pin when a person confirms it). */
  at: Record<string, { lat: number; lon: number; photo: string; conf: number }>;
  status: string | null;
  busy: boolean;
}
export const useDropped = create<Dropped>(() => ({ cards: [], at: {}, status: null, busy: false }));

interface Item {
  blob: Blob;
  name: string;
  /** Known already (a survey photo's recorded pose); else read from the file. */
  pose?: (Pick<PhotoPose, "lat" | "lon" | "heading"> & { relAlt: number | null }) | null;
}

/** Rank and place photos in the browser, one after the other, on the demo store. */
export async function processDemoPhotos(items: readonly Item[], threshold: number): Promise<void> {
  const say = (status: string) => useDropped.setState({ status });
  useDropped.setState({ busy: true });
  try {
    const { loadDetector, detectPhoto } = await import("../detect/runDetector");
    say("Loading the detector…");
    const detector = await loadDetector(() => undefined);
    let n = 0;
    for (const it of items) {
      n += 1;
      const store = useMission.getState();
      const pose = it.pose ?? readPose(await it.blob.arrayBuffer());
      if (!pose) {
        store.emit("mission.note", `${it.name}: no GPS position in its EXIF, so it was not placed`, it.name, { photo: it.name });
        continue;
      }
      say(`Ranking ${it.name} (${n} of ${items.length})…`);
      const bitmap = await createImageBitmap(it.blob);
      try {
        const dets = (await detectPhoto(detector, bitmap, () => undefined)).filter((d) => d.conf >= threshold);
        const radius = footprintRadiusM(pose.relAlt);
        // the photo looked at the ground under it: those cells lower, the rest of the map rises
        const base = useMission.getState().mapBase;
        if (base) {
          const cells = cellsWithinRadius(base.grid, pose.lat, pose.lon, radius);
          if (cells.length) {
            const seq = (useMission.getState().mapUpdates.at(-1)?.seq ?? 0) + 1;
            store.emit("map.updated", `map update ${seq} (photo ${it.name})`, it.name, { seq, kind: "step", source: "frame", ref: it.name, cells: cells.map((i) => [i, DRONE_POD]), at: "" });
          }
        }
        // each candidate: its crop, and where it is (the box's offset from the photo's centre, turned by the heading)
        const gsd = (2 * radius) / Math.max(bitmap.width, bitmap.height);
        const turn = ((pose.heading ?? 0) * Math.PI) / 180;
        const cards: ReviewCard[] = [];
        const at: Dropped["at"] = {};
        dets.forEach((d, i) => {
          const [x0, y0, x1, y1] = d.box;
          const dx = ((x0 + x1) / 2 - bitmap.width / 2) * gsd;
          const dy = ((y0 + y1) / 2 - bitmap.height / 2) * gsd;
          const east = dx * Math.cos(turn) + dy * Math.sin(turn);
          const south = -dx * Math.sin(turn) + dy * Math.cos(turn);
          const lat = pose.lat - south / M_PER_DEG;
          const lon = pose.lon + east / (M_PER_DEG * Math.cos((pose.lat * Math.PI) / 180));
          const id = `${it.name.replace(/\.[^.]+$/, "")}-d${String(i + 1).padStart(2, "0")}`;
          cards.push({ id, conf: d.conf, crop: crop(bitmap, d.box), frame: `Dropped photo ${it.name}`, words: null, note: "Ranked in this browser by the same detector; placed from the photo's EXIF." });
          at[id] = { lat, lon, photo: it.name, conf: d.conf };
          store.emit("detection.new", `${id} in the review queue`, id, { id, box_px: d.box, conf: d.conf, crop: null, lat, lon, radius_m: 10 });
        });
        store.emit("mission.note", `Photo ${it.name} ranked and placed: ${dets.length} ${dets.length === 1 ? "candidate" : "candidates"}`, it.name, { photo: it.name });
        useDropped.setState((s) => ({ cards: [...cards, ...s.cards], at: { ...s.at, ...at } }));
      } finally {
        bitmap.close();
      }
    }
    say(`${items.length} ${items.length === 1 ? "photo" : "photos"} ranked and placed.`);
  } catch (e) {
    say(`Could not rank the photos: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    useDropped.setState({ busy: false });
  }
}

/** A candidate's crop as an image address (a square around the box, at least 96 px). */
function crop(bitmap: ImageBitmap, [x0, y0, x1, y1]: [number, number, number, number]): string {
  const side = Math.max(96, Math.max(x1 - x0, y1 - y0) * 2.5);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const c = document.createElement("canvas");
  c.width = c.height = 160;
  c.getContext("2d")?.drawImage(bitmap, cx - side / 2, cy - side / 2, side, side, 0, 0, 160, 160);
  return c.toDataURL("image/jpeg", 0.85);
}

/**
 * The sample pack: 20 frames of the demo flight (f0256 to f0275, people in f0273) with their EXIF GPS,
 * altitude and heading written, published as a release asset. VITE_SAMPLE_PHOTOS_URL can point at a copy
 * (same origin works everywhere). GitHub's download redirect does not allow a page on another site to
 * read it, so where it is blocked (or offline) the demo flight's own photos are used, with their recorded
 * poses, and the page says so.
 */
export const SAMPLE_PACK_URL = "https://github.com/Drivera0/sightline/releases/download/sample-photos/sightline-sample-photos.zip";

export async function unzipPhotos(buf: ArrayBuffer): Promise<Item[]> {
  const { unzipSync } = await import("fflate");
  const files = unzipSync(new Uint8Array(buf), { filter: (f) => /\.(jpe?g)$/i.test(f.name) && !f.name.startsWith("__MACOSX") });
  return Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, SAMPLE_COUNT)
    .map(([name, data]) => ({ blob: new Blob([data as BlobPart], { type: "image/jpeg" }), name: name.split("/").pop() ?? name }));
}

async function samples(cache: CacheBundle | null, dir: string): Promise<{ items: Item[]; note: string | null }> {
  const url = import.meta.env.VITE_SAMPLE_PHOTOS_URL?.trim() || SAMPLE_PACK_URL;
  if (navigator.onLine) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(String(r.status));
      if (/\.zip($|\?)/.test(url) || (r.headers.get("content-type") ?? "").includes("zip") || (r.headers.get("content-type") ?? "").includes("octet-stream")) {
        const items = await unzipPhotos(await r.arrayBuffer());
        if (items.length) return { items, note: null };
      } else {
        const j = (await r.json()) as string[] | { photos: string[] };
        const list = (Array.isArray(j) ? j : j.photos).slice(0, SAMPLE_COUNT);
        return { items: await Promise.all(list.map(async (u) => ({ blob: await (await fetch(u)).blob(), name: u.split("/").pop() ?? u }))), note: null };
      }
    } catch {
      /* blocked, offline or moved: the survey's own photos instead */
    }
  }
  if (!cache) return { items: [], note: "The sample pack could not be fetched, and the demo survey is not loaded yet." };
  const frames = [...cache.survey.frames].sort((a, b) => b.n_candidates - a.n_candidates || a.flight_index - b.flight_index).slice(0, SAMPLE_COUNT);
  const items = await Promise.all(
    frames.map(async (f) => ({
      blob: await (await fetch(cacheUrl(dir, f.file))).blob(),
      name: `${f.id}.jpg`,
      pose: { lat: f.pose.lat, lon: f.pose.lon, heading: f.pose.heading_deg, relAlt: f.pose.alt_agl_m },
    })),
  );
  return { items, note: "The sample pack could not be read from GitHub in this browser, so these are the demo flight's own photos, placed from their recorded poses." };
}

/** The drop zone at the top of the Photos view. */
export function PhotoDrop({ demo, cache, dir, api, missionId }: { demo: boolean; cache: CacheBundle | null; dir: string; api?: Api; missionId?: string }) {
  const { status, busy } = useDropped();
  const [over, setOver] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const threshold = cache?.detections.candidate_threshold ?? 0.29;
  const take = async (files: File[]) => {
    const photos = files.filter((f) => /^image\/(jpeg|png)$/.test(f.type) || /\.(jpe?g|png)$/i.test(f.name));
    if (!photos.length) return setNote("Drop JPEG photos from the drone's card.");
    setNote(null);
    if (demo) return processDemoPhotos(photos.map((f) => ({ blob: f, name: f.name })), threshold);
    if (!api || !missionId) return;
    let accepted = 0;
    for (let i = 0; i < photos.length; i += 10) accepted += (await uploadPhotos(api, missionId, photos.slice(i, i + 10))).accepted.length;
    setNote(`${accepted} of ${photos.length} uploaded; the server ranks and places them.`);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void take([...e.dataTransfer.files]);
  };
  return (
    <section
      aria-label="Drop photos"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={`flex flex-col gap-2 rounded-lg border border-dashed p-3 ${over ? "border-accent bg-accent/5" : "border-border bg-surface-solid"}`}
    >
      <p className="text-small text-text">{DROP_HINT}</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="sl-tap inline-flex h-8 cursor-pointer items-center rounded-full border border-border px-3 text-small text-text hover:border-text-2">
          Choose photos
          <input type="file" accept="image/jpeg,image/png" multiple className="sr-only" onChange={(e) => void take([...(e.target.files ?? [])])} />
        </label>
        {demo && (
          <Button className="h-8!" disabled={busy || !cache} onClick={() =>
            void samples(cache, dir).then(({ items, note: why }) => {
              setNote(why);
              return processDemoPhotos(items, threshold);
            })
          }>
            Load {SAMPLE_COUNT} sample photos
          </Button>
        )}
      </div>
      {status && (
        <p role="status" className="text-caption text-text-2">
          {status}
        </p>
      )}
      {note && <p className="text-caption text-caution">{note}</p>}
      <p className="text-caption text-text-3">{demo ? "Ranked in this browser; nothing leaves the page." : "Uploaded to this mission's server, which ranks and places them."}</p>
    </section>
  );
}
