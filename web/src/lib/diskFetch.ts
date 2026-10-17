// Test helper: a `fetch` that serves files from web/public, so tests read the real sample cache.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// vitest runs from web/
const PUBLIC = join(process.cwd(), "public");

export function diskFetch(overrides: Record<string, () => Response> = {}): typeof fetch {
  return async (input) => {
    const path = String(input);
    const override = overrides[path];
    if (override) return override();
    try {
      return new Response(await readFile(PUBLIC + path));
    } catch {
      return new Response("not found", { status: 404 });
    }
  };
}
