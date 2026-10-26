import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyTypeColors, completePastTasks } from '../.tools/test-build/recordUpdates.js';
import { defaults } from '../.tools/test-build/model.js';
import { expandEntries } from '../.tools/test-build/recurrence.js';
import { importCsv } from '../.tools/test-build/importCsv.js';

const entry = (patch = {}) => ({
  id: crypto.randomUUID(),
  title: 'Проверка обновления',
  type: 'task',
  date: '2026-10-19',
  time: '10:00',
  duration: 60,
  color: '#123abc',
  important: false,
  description: 'Сохранить комментарий',
  completed: false,
  ...patch,
});
const colors = {
  ...defaults,
  taskColor: '#345678',
  meetingColor: '#789abc',
  eventColor: '#abcdef',
};

test('type colors replace previous individual colors for selected types without changing other data', () => {
  const task = Object.freeze(entry({ completed: true }));
  const meeting = Object.freeze(entry({ type: 'meeting' }));
  const event = Object.freeze(entry({ type: 'event', date: '2027-01-01' }));
  const unknown = Object.freeze({ id: 'future', unknownFormat: true });
  const records = Object.freeze([task, meeting, event, unknown]);
  const snapshot = structuredClone(records);
  const selected = applyTypeColors(records, colors, ['task']);
  assert.deepEqual(selected[0], { ...task, color: colors.taskColor });
  assert.equal(selected[1], meeting);
  assert.equal(selected[2], event);
  assert.equal(selected[3], unknown);
  const all = applyTypeColors(records, colors);
  assert.deepEqual(
    all.slice(0, 3),
    records.slice(0, 3).map((row) => ({ ...row, color: colors[`${row.type}Color`] })),
  );
  assert.equal(all[3], unknown);
  assert.deepEqual(records, snapshot);
  const repeated = applyTypeColors(all, colors);
  assert.deepEqual(repeated, all);
  assert.ok(repeated.every((row, index) => row === all[index]));
});

test('only tasks ending at or before the cutoff midnight become complete', () => {
  const past = entry();
  const midnight = entry({ time: '23:55', duration: 5 });
  const ongoing = entry({ time: '23:56', duration: 5 });
  const multiday = entry({ date: '2026-10-18', duration: 3 * 1440 });
  const today = entry({ date: '2026-10-20', time: '00:00' });
  const future = entry({ date: '2026-10-21' });
  const meeting = entry({ type: 'meeting' });
  const event = entry({ type: 'event' });
  const alreadyDone = entry({ completed: true });
  const unknown = { id: 'future', unknownFormat: true };
  const records = [
    past,
    midnight,
    ongoing,
    multiday,
    today,
    future,
    meeting,
    event,
    alreadyDone,
    unknown,
  ];
  const snapshot = structuredClone(records);
  const result = completePastTasks(records);
  assert.deepEqual(
    result.map((row) => row.completed),
    [true, true, false, false, false, false, false, false, true, undefined],
  );
  for (let i = 2; i < records.length; i++) assert.equal(result[i], records[i]);
  assert.deepEqual(records, snapshot);
  assert.deepEqual(completePastTasks(result), result);
});

test('cutoff compares exact zoned end time instead of the stored floating date', () => {
  const ended = entry({
    date: '2026-10-20',
    time: '10:00',
    startAt: '2026-10-19T20:00:00.000Z',
    endAt: '2026-10-19T21:00:00.000Z',
  });
  const ongoing = entry({
    startAt: '2026-10-19T20:00:00.000Z',
    endAt: '2026-10-19T21:01:00.000Z',
  });
  const westernDay = entry({
    date: '2026-10-20',
    startAt: '2026-10-20T02:00:00.000Z',
    endAt: '2026-10-20T03:00:00.000Z',
  });
  assert.equal(completePastTasks([ended])[0].completed, true);
  assert.equal(completePastTasks([ongoing])[0].completed, false);
  assert.equal(
    completePastTasks([westernDay], '2026-10-20', 'America/New_York')[0].completed,
    true,
  );
  assert.equal(completePastTasks([westernDay], '2026-10-20', 'Europe/Moscow')[0].completed, false);
});

test('daily recurrence splits completed history from incomplete current and future occurrences', () => {
  const original = entry({ date: '2026-10-16', recurrence: { frequency: 'daily' } });
  const snapshot = structuredClone(original);
  const result = completePastTasks([original]);
  assert.equal(result.length, 2);
  const dates = expandEntries(result, '2026-10-16', '2026-10-22', 'Europe/Moscow');
  assert.deepEqual(
    dates.map((row) => [row.date, row.completed]),
    [
      ['2026-10-16', true],
      ['2026-10-17', true],
      ['2026-10-18', true],
      ['2026-10-19', true],
      ['2026-10-20', false],
      ['2026-10-21', false],
      ['2026-10-22', false],
    ],
  );
  assert.equal(new Set(dates.map((row) => row.id)).size, dates.length);
  assert.deepEqual(original, snapshot);
  assert.deepEqual(completePastTasks(result), result);
});

test('recurring multiday tasks still in progress stay incomplete at the cutoff', () => {
  const recurring = entry({
    date: '2026-10-15',
    time: '23:00',
    duration: 180,
    recurrence: { frequency: 'daily' },
  });
  const result = completePastTasks([recurring]);
  const occurrences = expandEntries(result, '2026-10-15', '2026-10-22', 'Europe/Moscow');
  assert.deepEqual(
    occurrences.map((row) => [row.date, row.completed]),
    [
      ['2026-10-15', true],
      ['2026-10-16', true],
      ['2026-10-17', true],
      ['2026-10-18', true],
      ['2026-10-19', false],
      ['2026-10-20', false],
      ['2026-10-21', false],
      ['2026-10-22', false],
    ],
  );
});

test('ended recurrence, skipped occurrences and future-only recurrence keep their boundaries', () => {
  const ended = entry({
    date: '2026-10-10',
    recurrence: { frequency: 'daily', until: '2026-10-17' },
  });
  const skipped = entry({
    date: '2026-10-17',
    recurrence: { frequency: 'daily', exceptions: ['2026-10-18', '2026-10-20'] },
  });
  const future = entry({ date: '2026-10-21', recurrence: { frequency: 'weekly' } });
  const result = completePastTasks([ended, skipped, future]);
  assert.equal(result.find((row) => row.id === ended.id).completed, true);
  assert.equal(
    result.find((row) => row.id === future.id),
    future,
  );
  const dates = expandEntries(
    result.filter((row) => row.id !== ended.id && row.id !== future.id),
    '2026-10-17',
    '2026-10-22',
    'Europe/Moscow',
  );
  assert.deepEqual(
    dates.map((row) => [row.date, row.completed]),
    [
      ['2026-10-17', true],
      ['2026-10-19', true],
      ['2026-10-21', false],
      ['2026-10-22', false],
    ],
  );
});

test('the bundled 1000 records keep all IDs and only past tasks change completion', () => {
  const text = readFileSync(
    new URL('../public/data/voice-assistant-events.csv', import.meta.url),
    'utf8',
  );
  const { entries } = importCsv(text, defaults);
  const snapshot = structuredClone(entries);
  const result = applyTypeColors(completePastTasks(entries), colors);
  assert.equal(result.length, 1000);
  for (let i = 0; i < entries.length; i++) {
    const before = entries[i],
      after = result[i];
    assert.equal(after.id, before.id);
    assert.equal(after.importKey, before.importKey);
    assert.equal(after.completed, before.type === 'task' && before.date < '2026-10-20');
    assert.equal(after.color, colors[`${after.type}Color`]);
    assert.deepEqual(after, {
      ...before,
      completed: before.type === 'task' && before.date < '2026-10-20',
      color: colors[`${before.type}Color`],
    });
  }
  assert.deepEqual(entries, snapshot);
});
