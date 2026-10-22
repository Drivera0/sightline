// Upload helpers for the New search screen (LANE_D §5.6, D-I1). Built by lane A for lane D.

export const BATCH = 10;

/** JPEGs only (by name or type), in name order: a folder from an SD card arrives in flight order. */
export function photoFiles(files: Iterable<File>): { photos: File[]; skipped: { name: string; reason: string }[] } {
  const photos: File[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const f of files) {
    if (/\.jpe?g$/i.test(f.name) || f.type === "image/jpeg") photos.push(f);
    else skipped.push({ name: f.name, reason: "not a JPEG" });
  }
  photos.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { photos, skipped };
}

export function batches<T>(items: readonly T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The API's host for prose ("connected to 127.0.0.1"): the hostname alone, never the raw origin. An empty
 * base is this page's own server. */
export function hostLabel(apiBase: string, here: string = globalThis.location?.hostname ?? ""): string {
  if (!apiBase) return here || "this page's server";
  try {
    return new URL(apiBase).hostname || apiBase;
  } catch {
    return apiBase.replace(/^[a-z]+:\/\//i, "").replace(/[:/].*$/, "");
  }
}

/** The command an operator runs on the laptop the drone's photos land on (copy button): lane B's
 * `watch` client uploads each photo once its copy has finished, and queues while offline. */
export function uploadCommand(apiBase: string, missionId: string): string {
  return `uv run python -m sightline.client watch PHOTO_FOLDER --api ${apiBase || "http://127.0.0.1:8000"} --mission ${missionId}`;
}
