// Finds web addresses in a build that the browser would have to fetch, so the demo can run with Wi-Fi off.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const TEXT_FILES = /\.(html|js|mjs|css|json|svg|webmanifest|txt)$/i;
const URL_PATTERN = /https?:\/\/[^\s"'`<>)\\]+/g;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** URLs in `text` whose host is not local and not in `allowedHosts`. Unique and sorted. */
export function findExternalUrls(text, allowedHosts = []) {
  const found = new Set();
  for (const url of text.match(URL_PATTERN) ?? []) {
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      host = url;
    }
    if (!LOCAL_HOSTS.has(host) && !allowedHosts.includes(host)) found.add(url);
  }
  return [...found].sort();
}

/** External URLs per text file under `dir`: { "assets/app.js": ["https://..."] }. */
export function scanDirectory(dir, allowedHosts = []) {
  const result = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (TEXT_FILES.test(entry.name)) {
        const urls = findExternalUrls(readFileSync(path, "utf8"), allowedHosts);
        if (urls.length > 0) result[relative(dir, path).split(sep).join("/")] = urls;
      }
    }
  };
  walk(dir);
  return result;
}
