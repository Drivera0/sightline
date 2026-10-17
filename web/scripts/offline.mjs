// Finds web addresses in a build that the browser would have to fetch, so the demo can run with Wi-Fi off.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const TEXT_FILES = /\.(html|js|mjs|css|json|svg|webmanifest)$/i;
const URL_PATTERN = /https?:\/\/[^\s"'`<>)\\]+/g;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An entry matches exactly, or as a prefix when it ends in `*`. */
function isAllowedUrl(url, allowedUrls) {
  return allowedUrls.some((entry) => (entry.endsWith("*") ? url.startsWith(entry.slice(0, -1)) : url === entry));
}

/** URLs in `text` whose host is not local, not in `allowedHosts` and not listed in `allowedUrls`. Unique and sorted. */
export function findExternalUrls(text, allowedHosts = [], allowedUrls = []) {
  const found = new Set();
  for (const url of text.match(URL_PATTERN) ?? []) {
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      host = url;
    }
    if (!LOCAL_HOSTS.has(host) && !allowedHosts.includes(host) && !isAllowedUrl(url, allowedUrls)) found.add(url);
  }
  return [...found].sort();
}

/** External URLs per text file under `dir`: { "assets/app.js": ["https://..."] }. */
export function scanDirectory(dir, allowedHosts = [], allowedUrls = []) {
  const result = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (TEXT_FILES.test(entry.name)) {
        const urls = findExternalUrls(readFileSync(path, "utf8"), allowedHosts, allowedUrls);
        if (urls.length > 0) result[relative(dir, path).split(sep).join("/")] = urls;
      }
    }
  };
  walk(dir);
  return result;
}
