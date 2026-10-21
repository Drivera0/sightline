// Plays a reply's audio chunks in order (sightline/radio/api.py: chunk 0 is ready at once, later
// chunks may 404 for a moment while they are generated). With "radio sound" on, a 300–3400 Hz
// band-pass and faint noise make it sound like a handheld radio in the video; off by default.

const RETRY_MS = 100;
const MAX_WAIT_MS = 20_000;

async function fetchChunk(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const started = Date.now();
  for (;;) {
    const res = await fetch(url, { signal });
    if (res.ok) return res.arrayBuffer();
    if (res.status !== 404 || Date.now() - started > MAX_WAIT_MS) throw new Error(`audio chunk ${res.status}`);
    await new Promise((r) => setTimeout(r, RETRY_MS));
  }
}

function radioChain(ctx: AudioContext): AudioNode {
  const high = ctx.createBiquadFilter();
  high.type = "highpass";
  high.frequency.value = 300;
  const low = ctx.createBiquadFilter();
  low.type = "lowpass";
  low.frequency.value = 3400;
  high.connect(low).connect(ctx.destination);
  // Faint static under the voice, for as long as the context runs.
  const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.015;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  src.connect(low);
  src.start();
  return high;
}

/** Play `urls` back to back; resolves when the last chunk has finished. */
export async function playChunks(urls: string[], radioSound: boolean, signal?: AbortSignal): Promise<void> {
  if (!urls.length) return;
  const ctx = new AudioContext();
  const out = radioSound ? radioChain(ctx) : ctx.destination;
  try {
    // Start fetching the next chunk while the current one plays.
    let next = fetchChunk(urls[0]!, signal);
    for (let i = 0; i < urls.length; i++) {
      const buf = await ctx.decodeAudioData(await next);
      if (i + 1 < urls.length) next = fetchChunk(urls[i + 1]!, signal);
      await new Promise<void>((resolve) => {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(out);
        src.onended = () => resolve();
        signal?.addEventListener("abort", () => {
          src.stop();
          resolve();
        });
        src.start();
      });
      if (signal?.aborted) return;
    }
  } finally {
    await ctx.close();
  }
}
