export type Recording = { stop: () => Promise<Blob>; cancel: () => void };

export function encodeWave(chunks: Float32Array[], rate: number) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const size = Math.floor((length * 16000) / rate);
  const data = new DataView(new ArrayBuffer(44 + size * 2));
  const write = (offset: number, text: string) =>
    [...text].forEach((character, i) => data.setUint8(offset + i, character.charCodeAt(0)));
  write(0, 'RIFF');
  data.setUint32(4, 36 + size * 2, true);
  write(8, 'WAVEfmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, 16000, true);
  data.setUint32(28, 32000, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  write(36, 'data');
  data.setUint32(40, size * 2, true);
  let chunkIndex = 0,
    chunkOffset = 0,
    position = 0;
  for (let i = 0; i < size; i++) {
    const start = Math.floor((i * rate) / 16000),
      end = Math.min(length, Math.floor(((i + 1) * rate) / 16000));
    let sample = 0;
    while (position < end) {
      const chunk = chunks[chunkIndex];
      const count = Math.min(chunk.length - chunkOffset, end - position);
      for (let j = 0; j < count; j++) sample += chunk[chunkOffset + j];
      chunkOffset += count;
      position += count;
      if (chunkOffset === chunk.length) {
        chunkIndex++;
        chunkOffset = 0;
      }
    }
    sample = Math.max(-1, Math.min(1, sample / Math.max(1, end - start)));
    data.setInt16(44 + i * 2, sample * (sample < 0 ? 32768 : 32767), true);
  }
  return new Blob([data], { type: 'audio/wav' });
}
export async function recordMicrophone(signal: AbortSignal): Promise<Recording> {
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext)
    throw Error('Голосовой ввод недоступен. Откройте сайт через localhost в Edge или Chrome.');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  let context: AudioContext | undefined;
  const close = () => {
    stream.getTracks().forEach((track) => track.stop());
    void context?.close().catch(() => {});
  };
  if (signal.aborted) {
    close();
    throw new DOMException('Отменено', 'AbortError');
  }
  signal.addEventListener('abort', close, { once: true });
  try {
    context = new AudioContext();
    await context.audioWorklet.addModule(new URL('./recorder-worklet.js', location.href));
    if (signal.aborted) throw new DOMException('Отменено', 'AbortError');
    const source = context.createMediaStreamSource(stream);
    const recorder = new AudioWorkletNode(context, 'voice-recorder');
    const chunks: Float32Array[] = [];
    let settle: (() => void) | undefined;
    recorder.port.onmessage = ({ data }) => {
      if (data === 'stopped') settle?.();
      else if (data instanceof Float32Array) chunks.push(data);
    };
    source.connect(recorder).connect(context.destination);
    await context.resume();
    let stopped: Promise<Blob> | undefined;
    const rate = context.sampleRate;
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      signal.removeEventListener('abort', close);
      source.disconnect();
      recorder.disconnect();
      recorder.port.close();
      close();
    };
    return {
      stop: () =>
        (stopped ||= (async () => {
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, 500);
            settle = () => {
              clearTimeout(timeout);
              resolve();
            };
            recorder.port.postMessage('stop');
          });
          dispose();
          return encodeWave(chunks, rate);
        })()),
      cancel: () => {
        settle?.();
        dispose();
        chunks.length = 0;
      },
    };
  } catch (error) {
    signal.removeEventListener('abort', close);
    close();
    throw error;
  }
}
