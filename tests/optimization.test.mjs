import test from 'node:test';
import assert from 'node:assert/strict';
import { wallParts, toInstant, defaults } from '../.tools/test-build/model.js';
import { selectEntries } from '../.tools/test-build/assistantEngine.js';
import { encodeWave } from '../.tools/test-build/voiceRecorder.js';
import { prepareReminders } from '../server/reminders.mjs';

test('date caches isolate zones and cannot be changed through returned objects', () => {
  const instant = toInstant('2026-10-23', '10:15', 'Europe/Moscow');
  const parts = wallParts(instant, 'Europe/Moscow');
  parts.date = 'wrong';
  parts.time = 'wrong';
  assert.deepEqual(wallParts(instant, 'Europe/Moscow'), { date: '2026-10-23', time: '10:15' });
  assert.equal(wallParts(instant, 'UTC').time, '07:15');
  assert.notEqual(toInstant('2026-10-23', '10:15', 'UTC'), instant);
  assert.throws(() => toInstant('2026-02-30', '10:15', 'Europe/Moscow'));
});
test('streamed WAV encoding is identical across irregular and empty chunk boundaries', async () => {
  const samples = Float32Array.from({ length: 8193 }, (_, i) => Math.sin(i / 7));
  const chunks = [
    samples.slice(0, 1),
    samples.slice(1, 777),
    new Float32Array(),
    samples.slice(777),
  ];
  for (const rate of [8000, 16000, 44100, 48000, 96000]) {
    assert.deepEqual(
      Buffer.from(await encodeWave(chunks, rate).arrayBuffer()),
      Buffer.from(await encodeWave([samples], rate).arrayBuffer()),
    );
  }
});
test('search caches retain edits and match recurring records with date/time filters', () => {
  const base = {
    id: 'one',
    title: 'Обсуждение отчёта',
    description: 'Важный проект',
    type: 'meeting',
    date: '2026-10-23',
    time: '10:15',
    duration: 0,
    atTime: true,
    color: '#123abc',
    important: false,
    recurrence: { frequency: 'daily' },
  };
  const other = { ...base, id: 'other', type: 'task' };
  const query = {
    query: 'проект',
    type: 'meeting',
    start: '2026-10-24',
    end: '2026-10-24',
    time: '10:15',
  };
  assert.deepEqual(
    selectEntries([base, other], query, defaults.zone).map((entry) => entry.id),
    ['one@2026-10-24'],
  );
  base.description = 'Другой комментарий';
  assert.deepEqual(selectEntries([base, other], query, defaults.zone), []);
});
test('reminder keys cannot access inherited ledger properties', () => {
  const now = Date.now(),
    item = { title: 'Test', body: '', at: now + 6000, expires: now + 60000, sound: false };
  for (const key of ['__proto__', 'constructor', 'toString']) {
    const result = prepareReminders([{ ...item, key }], {}, now);
    assert.equal(result.items.length, 1);
    assert.equal(result.ledger[key], item.at);
  }
});
