#!/usr/bin/env bash
# Dress-run stage, after web-build: serve web/dist as a static host would, fetch index.html and the
# script it loads, and check that the bundle is the one-console build: its routes (#m/demo with the
# story clock ?t=, #new, #about) and the redirects from the old addresses (#judges, #survey,
# #operate...). The redirects themselves run in the browser (a hash never reaches the server), so
# this checks the built code carries them; web/src/shell/flow.test.ts tests what they do.
set -euo pipefail
cd /app/web

test -s dist/index.html
PORT=8173
python -m http.server "$PORT" --bind 127.0.0.1 --directory dist >/tmp/dressrun-web.log 2>&1 &
WEB_PID=$!
trap 'kill "$WEB_PID" 2>/dev/null || true' EXIT
for _ in $(seq 50); do
  curl -sf "http://127.0.0.1:$PORT/" -o /tmp/dressrun-index.html && break
  sleep 0.1
done

# index.html is served and loads one module script from assets/.
grep -q '<div id="root">' /tmp/dressrun-index.html
src="$(grep -oE '<script type="module"[^>]* src="[^"]+"' /tmp/dressrun-index.html | sed -E 's/.* src="([^"]+)"/\1/' | head -n1)"
[ -n "$src" ] || { echo "index.html loads no module script"; exit 1; }
curl -sf "http://127.0.0.1:$PORT${src}" -o /tmp/dressrun-main.js
echo "index.html served; it loads $src ($(wc -c </tmp/dressrun-main.js) bytes)"

# The one-console routes and the old addresses' redirects, in any of the built scripts.
missing=0
for s in '#m/demo' '?t=' '?t=5&judges' '#new' '#about' '#judges' '#survey' '#operate' '#command' '#try'; do
  if grep -qF -- "$s" dist/assets/*.js; then
    echo "  bundle has $s"
  else
    echo "  MISSING from the bundle: $s"
    missing=1
  fi
done
# The demo cache and the in-browser detector the site reads ship with it.
test -s dist/cache/demo/manifest.json && echo "  dist/cache/demo/manifest.json"
ls dist/models/*.onnx >/dev/null && echo "  dist/models: $(ls dist/models)"
curl -sf "http://127.0.0.1:$PORT/cache/demo/manifest.json" >/dev/null && echo "  the demo manifest is served"
exit "$missing"
