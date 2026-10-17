// Usage: node scripts/check-offline.mjs [build folder]   (default: dist)
// Fails when the build refers to a web address the browser would fetch. Namespace and error-message
// strings that are never fetched are allowed.
import { scanDirectory } from "./offline.mjs";

const ALLOWED_HOSTS = ["www.w3.org", "react.dev"];
const dir = process.argv[2] ?? "dist";
const found = scanDirectory(dir, ALLOWED_HOSTS);

if (Object.keys(found).length > 0) {
  console.error("The build refers to web addresses, so it may not work with Wi-Fi off:");
  for (const [file, urls] of Object.entries(found)) {
    for (const url of urls) console.error(`  ${file}: ${url}`);
  }
  process.exit(1);
}
console.log(`${dir}: no external web addresses`);
