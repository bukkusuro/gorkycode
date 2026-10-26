import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { encodeWave } from '../.tools/test-build/voiceRecorder.js';
import { createSpeechMiddleware, validateAudio } from '../server/speech.mjs';

const audio = async (seconds = 1, rate = 48000) =>
  Buffer.from(
    await encodeWave(
      [
        Float32Array.from(
          { length: seconds * rate },
          (_, i) => Math.sin((i * 2 * Math.PI * 440) / rate) * 0.25,
        ),
      ],
      rate,
    ).arrayBuffer(),
  );
async function serve(t, transcribe) {
  const middleware = createSpeechMiddleware({ transcribe });
  const server = createServer(
    (req, res) =>
      void middleware(req, res, () => {
        res.writeHead(404);
        res.end();
      }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const url = `http://127.0.0.1:${server.address().port}/VoiceTask/api/speech`;
  return {
    url,
    post: (body, headers = {}) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'audio/wav', ...headers }, body }),
  };
}
test('recorded PCM becomes a standard mono 16kHz WAV without clipping or changing its duration', async () => {
  for (const rate of [16000, 44100, 48000]) {
    const wav = await audio(1, rate);
    assert.equal(wav.length, 32044);
    assert.doesNotThrow(() => validateAudio(wav));
    const samples = [];
    for (let i = 44; i < wav.length; i += 2) samples.push(wav.readInt16LE(i));
    assert.ok(Math.max(...samples) > 8000 && Math.max(...samples) < 8300);
    assert.ok(Math.min(...samples) < -8000 && Math.min(...samples) > -8300);
  }
  const clipped = Buffer.from(
    await encodeWave([new Float32Array([2, -2, 0])], 16000).arrayBuffer(),
  );
  assert.deepEqual(
    [44, 46, 48].map((offset) => clipped.readInt16LE(offset)),
    [32767, -32768, 0],
  );
});
test('speech API transcribes audio on its own server and returns text without submitting a chat message', async (t) => {
  let calls = 0;
  const { url, post } = await serve(t, async (wav, { signal }) => {
    calls++;
    assert.equal(signal.aborted, false);
    assert.doesNotThrow(() => validateAudio(wav));
    return 'Отметь выполненной задачу сегодня в 10:15';
  });
  assert.equal((await fetch(url)).status, 200);
  const response = await post(await audio());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: 'Отметь выполненной задачу сегодня в 10:15' });
  assert.equal(calls, 1);
});
test('malformed, oversized, cross-origin and concurrent recordings cannot start transcription', async (t) => {
  let release, started;
  const running = new Promise((resolve) => {
    started = resolve;
  });
  const { url, post } = await serve(t, () => {
    started();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  assert.equal((await fetch(url, { method: 'DELETE' })).status, 405);
  assert.equal((await post('invalid', { 'Content-Type': 'application/json' })).status, 415);
  assert.equal((await post(await audio(), { Origin: 'https://example.org' })).status, 403);
  assert.equal((await post(Buffer.alloc(100))).status, 400);
  assert.equal((await post(Buffer.alloc(2000000))).status, 413);
  const malformed = await audio();
  malformed.writeUInt32LE(8000, 24);
  assert.equal((await post(malformed)).status, 400);
  const first = post(await audio());
  await running;
  assert.equal((await post(await audio())).status, 429);
  release('Проверка');
  assert.equal((await first).status, 200);
});
test('empty speech is returned as empty text while internal failures expose no process arguments or local files', async (t) => {
  let shouldFail = false;
  const { post } = await serve(t, async () => {
    if (shouldFail) throw Error('private local file or process output');
    return '';
  });
  assert.deepEqual(await (await post(await audio())).json(), { text: '' });
  shouldFail = true;
  const response = await post(await audio());
  assert.equal(response.status, 502);
  assert.doesNotMatch(JSON.stringify(await response.json()), /private local/);
});

test('cancelling recognition releases the server for the next recording', async (t) => {
  let started, aborted;
  const running = new Promise((resolve) => {
    started = resolve;
  });
  const ended = new Promise((resolve) => {
    aborted = resolve;
  });
  let calls = 0;
  const { url, post } = await serve(t, async (_audio, { signal }) => {
    if (calls++) return 'Следующая запись';
    started();
    await new Promise((_resolve, reject) =>
      signal.addEventListener(
        'abort',
        () => {
          aborted();
          reject(Error('cancelled'));
        },
        { once: true },
      ),
    );
  });
  const controller = new AbortController();
  const testWav = await audio();
  const first = fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: testWav,
    signal: controller.signal,
  });
  const rejected = assert.rejects(first, /abort/i);
  await running;
  controller.abort();
  await rejected;
  await ended;
  const response = await post(testWav);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: 'Следующая запись' });
});
