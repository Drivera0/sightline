// Push-to-talk recording (LANE_E §8.5): MediaRecorder, webm/opus where the browser has it.

export class MicDenied extends Error {}

export interface Recording {
  stop: () => Promise<Blob>;
}

/** Start recording from the microphone; `stop()` resolves with the clip. Throws MicDenied when the
 * browser has no microphone or the user refuses it (the desk then offers the text box). */
export async function startRecording(): Promise<Recording> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    throw new MicDenied("This browser can't record audio.");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } });
  } catch {
    throw new MicDenied("Microphone permission was refused.");
  }
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.start();
  return {
    stop: () =>
      new Promise<Blob>((resolve) => {
        recorder.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
        };
        recorder.stop();
      }),
  };
}
