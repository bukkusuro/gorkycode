import { assertSameOrigin, sendJSON, readBody } from './http.mjs';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const fail = (status, message) => Object.assign(Error(message), { status });
const files = (root) => {
  const folder = join(root, '.tools', 'speech');
  return {
    binary: join(folder, 'bin', 'Release', 'whisper-cli.exe'),
    model: join(folder, 'ggml-small-q5_1.bin'),
    vad: join(folder, 'ggml-silero-v5.1.2.bin'),
  };
};
export function validateAudio(audio) {
  if (
    audio.length < 44 + 3200 ||
    audio.length > 44 + 60 * 32000 ||
    audio.toString('ascii', 0, 4) !== 'RIFF' ||
    audio.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
    audio.readUInt32LE(4) !== audio.length - 8 ||
    audio.readUInt32LE(16) !== 16 ||
    audio.readUInt16LE(20) !== 1 ||
    audio.readUInt16LE(22) !== 1 ||
    audio.readUInt32LE(24) !== 16000 ||
    audio.readUInt32LE(28) !== 32000 ||
    audio.readUInt16LE(32) !== 2 ||
    audio.readUInt16LE(34) !== 16 ||
    audio.toString('ascii', 36, 40) !== 'data' ||
    audio.readUInt32LE(40) !== audio.length - 44 ||
    (audio.length - 44) % 2
  )
    throw fail(400, 'Запишите отрывок речи длительностью до минуты.');
}
export async function transcribeAudio(audio, { root = process.cwd(), signal } = {}) {
  const config = files(root);
  if (!Object.values(config).every(existsSync))
    throw fail(503, 'Распознавание не установлено. Запустите START.cmd.');
  const folder = await mkdtemp(join(tmpdir(), 'voxa-speech-'));
  const input = join(folder, 'recording.wav'),
    output = join(folder, 'result');
  try {
    await writeFile(input, audio);
    const task = run(
      config.binary,
      [
        '-m',
        relative(root, config.model),
        '-f',
        input,
        '-l',
        'ru',
        '-t',
        '4',
        '-ng',
        '--vad',
        '-vm',
        relative(root, config.vad),
        '-bs',
        '3',
        '-bo',
        '3',
        '-nf',
        '-sns',
        '-oj',
        '-of',
        output,
        '-np',
        '-nt',
      ],
      { cwd: root, windowsHide: true, signal, timeout: 90000, maxBuffer: 1048576 },
    );
    try {
      await task;
    } catch (error) {
      if (task.child.pid && task.child.exitCode === null && task.child.signalCode === null)
        await new Promise((resolve) => task.child.once('close', resolve));
      throw error;
    }
    const result = JSON.parse(await readFile(`${output}.json`, 'utf8'));
    return (result.transcription || [])
      .map((segment) => segment.text.trim())
      .filter(Boolean)
      .join(' ')
      .slice(0, 4000);
  } finally {
    await Promise.allSettled([unlink(input), unlink(`${output}.json`)]);
    await rmdir(folder).catch(() => {});
  }
}
export function createSpeechMiddleware({
  root = process.cwd(),
  transcribe = transcribeAudio,
} = {}) {
  let busy = false;
  return async (req, res, next) => {
    if (!['/api/speech', '/VoiceTask/api/speech'].includes(req.url?.split('?')[0])) return next();
    const controller = new AbortController();
    const closed = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', closed);

    let acquired = false;
    try {
      assertSameOrigin(req);
      if (req.method === 'GET')
        return sendJSON(res, 200, {
          configured: Object.values(files(root)).every(existsSync),
          local: true,
        });
      if (req.method !== 'POST') throw fail(405, 'Используйте GET или POST.');
      if (req.headers['content-type']?.split(';')[0] !== 'audio/wav')
        throw fail(415, 'Ожидается запись с микрофона.');
      if (busy) throw fail(429, 'Предыдущая запись ещё распознаётся. Подождите немного.');
      busy = acquired = true;
      const audio = await readBody(
        req,
        44 + 60 * 32000,
        'Запись слишком длинная. Продиктуйте сообщение за минуту.',
      );
      validateAudio(audio);
      const text = await transcribe(audio, { root, signal: controller.signal });
      sendJSON(res, 200, { text });
    } catch (error) {
      sendJSON(res, error.status || 502, {
        error: error.status
          ? error.message
          : error.killed
            ? 'Распознавание заняло слишком много времени. Запишите более короткую фразу.'
            : 'Не удалось распознать запись. Попробуйте ещё раз.',
      });
    } finally {
      if (acquired) busy = false;
      res.off('close', closed);
    }
  };
}
export function speechPlugin() {
  const attach = (server) => {
    server.middlewares.use(createSpeechMiddleware({ root: server.config.root }));
  };
  return { name: 'voxa-speech', configureServer: attach, configurePreviewServer: attach };
}
