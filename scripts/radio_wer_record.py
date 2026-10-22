"""Record the 20 radio WER phrases in the browser, straight into ``data/radio_wer/<voice>/``.

    uv run python scripts/radio_wer_record.py --voice dan              # then open http://localhost:8765
    uv run python scripts/radio_wer_record.py --voice dan-radio --port 8766

A local page (stdlib ``http.server``, the browser's MediaRecorder; nothing to install) shows phrase N of
20 from ``tests/radio/phrases.txt`` (the list ``radio_wer.py`` reads), a Record/Stop button (Space), a
level meter, playback of the take, Redo and Next (Enter). Each take is saved as
``data/radio_wer/<voice>/NN.webm`` (``.ogg`` or ``.m4a`` if the browser records that), overwriting the
previous take of that phrase: the one-file-per-phrase layout ``radio_wer.py`` scores. The "Radio" toggle
only writes ``{"via": "handheld radio"}`` to ``notes.json`` in the same folder (``radio_wer.py`` ignores
it), so record a radio set under its own voice name, e.g. ``dan-radio``.

The microphone needs a secure context: open the page as ``http://localhost:PORT``, not by IP address.
The server listens on 127.0.0.1 only and opens nothing itself.
"""

from __future__ import annotations

import argparse
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from radio_wer import PHRASES, RECORDINGS, phrases

ROOT = Path(__file__).resolve().parents[1]
MIME_EXT = {"audio/webm": ".webm", "audio/ogg": ".ogg", "audio/mp4": ".m4a", "audio/wav": ".wav"}
SERVE_MIME = {v: k for k, v in MIME_EXT.items()}
MAX_TAKE = 50 * 1024 * 1024
_VOICE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")

PAGE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Radio WER recorder</title>
<style>
:root{--bg:#111418;--fg:#e8eaed;--mut:#8a939c;--acc:#3b82f6;--rec:#dc2626;--ok:#16a34a;--slot:#2a2f36}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.4 system-ui,sans-serif;padding:16px}
main{max-width:860px;margin:0 auto}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;color:var(--mut)}
header b{color:var(--fg)}
#strip{display:grid;grid-template-columns:repeat(20,1fr);gap:4px;margin:16px 0}
#strip button{height:28px;border:0;border-radius:4px;background:var(--slot);color:var(--mut);font-size:12px;cursor:pointer}
#strip button.done{background:var(--ok);color:#fff}
#strip button.cur{outline:2px solid var(--acc);outline-offset:1px}
#num{color:var(--mut);margin-top:24px}
#phrase{font-size:clamp(24px,4.5vw,40px);line-height:1.3;margin:8px 0 24px;min-height:3.9em}
#rec{width:100%;padding:24px;font-size:28px;font-weight:600;border:0;border-radius:12px;background:var(--acc);color:#fff;cursor:pointer}
#rec.on{background:var(--rec)}
#meter{height:12px;background:var(--slot);border-radius:6px;overflow:hidden;margin:12px 0}
#bar{height:100%;width:0;background:var(--ok);transition:width 50ms}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:12px}
.row button{padding:12px 20px;font-size:18px;border:0;border-radius:8px;background:var(--slot);color:var(--fg);cursor:pointer}
audio{width:100%;margin-top:12px}
#msg{color:var(--mut);margin-top:12px;min-height:1.4em;word-break:break-all}
label{cursor:pointer}
</style></head>
<body><main>
<header><div>Voice: <b id="voice"></b></div>
<label><input type="checkbox" id="radio"> Radio (recorded through a handheld radio)</label></header>
<div id="strip"></div>
<div id="num"></div>
<div id="phrase"></div>
<button id="rec">Record</button>
<div id="meter"><div id="bar"></div></div>
<audio id="play" controls></audio>
<div class="row"><button id="redo">Redo</button><button id="next">Next &#9166;</button>
<span style="color:var(--mut)">Space: record/stop. Enter: next.</span></div>
<div id="msg"></div>
</main>
<script>
const CFG = __CFG__;
const N = CFG.phrases.length;
let cur = 0, done = new Set(CFG.done), rec = null, chunks = [], stream = null, analyser = null;
const $ = id => document.getElementById(id);
$("voice").textContent = CFG.voice;
$("radio").checked = CFG.via === "handheld radio";
for (let i = 0; i < N; i++) {
  const b = document.createElement("button");
  b.textContent = i + 1; b.onclick = () => go(i);
  $("strip").appendChild(b);
}
function msg(t) { $("msg").textContent = t; }
function render() {
  [...$("strip").children].forEach((b, i) => {
    b.className = (done.has(i + 1) ? "done " : "") + (i === cur ? "cur" : "");
    b.title = done.has(i + 1) ? "recorded" : "missing";
  });
  $("num").textContent = `Phrase ${cur + 1} of ${N}` + (done.has(cur + 1) ? " (recorded)" : "");
  $("phrase").textContent = CFG.phrases[cur];
}
function go(i) {
  if (rec && rec.state === "recording") return;
  cur = Math.max(0, Math.min(N - 1, i));
  $("play").removeAttribute("src");
  if (done.has(cur + 1)) $("play").src = `/take?n=${cur + 1}&t=${Date.now()}`;
  render();
}
async function mic() {
  if (stream) return stream;
  if (!navigator.mediaDevices) throw new Error("No microphone API: open the page as http://localhost:PORT");
  stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false}});
  const ctx = new AudioContext();
  await ctx.resume();
  analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  (function tick() {
    analyser.getFloatTimeDomainData(buf);
    let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v));
    $("bar").style.width = Math.min(100, peak * 100) + "%";
    $("bar").style.background = peak > 0.95 ? "var(--rec)" : "var(--ok)";
    requestAnimationFrame(tick);
  })();
  return stream;
}
function pickType() {
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"])
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  return "";
}
async function toggle() {
  if (rec && rec.state === "recording") { rec.stop(); return; }
  try { await mic(); } catch (e) { msg("Microphone: " + e.message); return; }
  const type = pickType();
  rec = new MediaRecorder(stream, type ? {mimeType: type} : {});
  chunks = [];
  const n = cur + 1;
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => save(n, new Blob(chunks, {type: rec.mimeType || type || "audio/webm"}));
  rec.start();
  $("rec").textContent = "Stop"; $("rec").classList.add("on");
  msg(`Recording phrase ${n}...`);
}
async function save(n, blob) {
  $("rec").textContent = "Record"; $("rec").classList.remove("on");
  $("play").src = URL.createObjectURL(blob);
  msg(`Saving ${(blob.size / 1024).toFixed(1)} KB...`);
  try {
    const r = await fetch(`/take?n=${n}`, {method: "POST", headers: {"Content-Type": blob.type}, body: blob});
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    done.add(n); msg(`Saved ${j.path}`); render();
  } catch (e) { msg("Save failed: " + e.message); }
}
function next() {
  if (rec && rec.state === "recording") return;
  for (let k = 1; k <= N; k++) { const i = (cur + k) % N; if (!done.has(i + 1)) return go(i); }
  go(cur + 1 < N ? cur + 1 : cur); msg("All " + N + " phrases recorded.");
}
$("rec").onclick = toggle;
$("next").onclick = next;
$("redo").onclick = () => { if (!rec || rec.state !== "recording") { $("play").removeAttribute("src"); toggle(); } };
$("radio").onchange = async e => {
  const r = await fetch("/notes", {method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({via: e.target.checked ? "handheld radio" : "direct microphone"})});
  const j = await r.json(); msg(r.ok ? `Saved ${j.path}` : "Notes failed: " + j.error);
};
document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT") return;
  if (e.code === "Space") { e.preventDefault(); toggle(); }
  else if (e.key === "Enter") { e.preventDefault(); next(); }
});
go(0);
</script></body></html>
"""


def take_paths(folder: Path, n: int) -> list[Path]:
    """Existing takes of phrase ``n`` in any format this recorder writes (not ``.radio`` takes)."""
    return [
        folder / f"{n:02d}{ext}"
        for ext in MIME_EXT.values()
        if (folder / f"{n:02d}{ext}").is_file()
    ]


def done(folder: Path, total: int) -> list[int]:
    return [n for n in range(1, total + 1) if take_paths(folder, n)]


def make_handler(voice: str, folder: Path, lines: list[str]):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: object) -> None:  # saves are printed instead
            pass

        def _send(self, code: int, body: bytes, ctype: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, code: int, obj: dict) -> None:
            self._send(code, json.dumps(obj).encode(), "application/json")

        def _slot(self) -> int | None:
            q = parse_qs(urlparse(self.path).query)
            try:
                n = int(q.get("n", [""])[0])
            except ValueError:
                return None
            return n if 1 <= n <= len(lines) else None

        def _notes(self) -> dict:
            try:
                return json.loads((folder / "notes.json").read_text())
            except (OSError, ValueError):
                return {}

        def do_GET(self) -> None:
            route = urlparse(self.path).path
            if route == "/":
                cfg = {
                    "voice": voice,
                    "phrases": lines,
                    "done": done(folder, len(lines)),
                    "via": self._notes().get("via"),
                }
                cfg_js = json.dumps(cfg).replace("</", "<\\/")
                self._send(
                    200, PAGE.replace("__CFG__", cfg_js).encode(), "text/html; charset=utf-8"
                )
            elif route == "/status":
                self._json(200, {"done": done(folder, len(lines)), "notes": self._notes()})
            elif route == "/take":
                n = self._slot()
                found = take_paths(folder, n) if n else []
                if not found:
                    self._json(404, {"error": "no take"})
                    return
                self._send(
                    200, found[0].read_bytes(), SERVE_MIME.get(found[0].suffix, "audio/webm")
                )
            else:
                self._json(404, {"error": "not found"})

        def do_POST(self) -> None:
            route = urlparse(self.path).path
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_TAKE:
                self._json(400, {"error": f"body must be 1 byte to {MAX_TAKE // 2**20} MB"})
                return
            body = self.rfile.read(length)
            folder.mkdir(parents=True, exist_ok=True)
            if route == "/take":
                n = self._slot()
                if n is None:
                    self._json(400, {"error": f"n must be 1..{len(lines)}"})
                    return
                mime = (
                    (self.headers.get("Content-Type") or "audio/webm").split(";")[0].strip().lower()
                )
                ext = MIME_EXT.get(mime, ".webm")
                for old in take_paths(folder, n):  # a redo replaces the take in any format
                    old.unlink()
                path = folder / f"{n:02d}{ext}"
                path.write_bytes(body)
                rel = path.relative_to(ROOT) if path.is_relative_to(ROOT) else path
                print(f"saved {rel} ({len(body) / 1024:.1f} KB)")
                self._json(200, {"path": str(rel), "bytes": len(body)})
            elif route == "/notes":
                try:
                    via = str(json.loads(body).get("via", ""))[:100]
                except (ValueError, AttributeError):
                    self._json(400, {"error": 'expected JSON {"via": ...}'})
                    return
                notes = {**self._notes(), "via": via}
                path = folder / "notes.json"
                path.write_text(json.dumps(notes, indent=2) + "\n")
                rel = path.relative_to(ROOT) if path.is_relative_to(ROOT) else path
                self._json(200, {"path": str(rel), "notes": notes})
            else:
                self._json(404, {"error": "not found"})

    return Handler


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--voice", required=True, help="folder name under data/radio_wer, e.g. dan or dan-radio"
    )
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--recordings", type=Path, default=RECORDINGS, help="default: data/radio_wer")
    args = ap.parse_args()
    if not _VOICE.fullmatch(args.voice):
        raise SystemExit("--voice: letters, digits, '-' and '_' only (it becomes a folder name)")
    lines = phrases()
    folder = args.recordings / args.voice
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(args.voice, folder, lines))
    have = done(folder, len(lines))
    print(
        f"{len(lines)} phrases from {PHRASES.relative_to(ROOT)}; {len(have)} already recorded in {folder}"
    )
    print(
        f"Open http://localhost:{args.port} in Chrome or Firefox (use 'localhost', not an IP address:"
    )
    print("the browser only allows the microphone on a secure context). Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
