import test from 'node:test';
import assert from 'node:assert/strict';
import { validEntry } from '../.tools/test-build/calendar.js';
import { defaults, displayEntry, endParts, segment } from '../.tools/test-build/model.js';
import { layoutEvents } from '../.tools/test-build/eventLayout.js';
import { importedEntriesAtTime, completePastTasks } from '../.tools/test-build/recordUpdates.js';
import { occurrence } from '../.tools/test-build/recurrence.js';
import { executeCommand } from '../.tools/test-build/assistantEngine.js';
import { interpretLocal } from '../.tools/test-build/localInterpreter.js';

const task = (patch = {}) => ({
  id: 'scheduled-task',
  title: 'Позвонить',
  type: 'task',
  date: '2026-10-21',
  time: '12:30',
  duration: 0,
  atTime: true,
  color: '#ddd8f5',
  important: false,
  description: '',
  completed: false,
  ...patch,
});

test('scheduled entries of every type have no interval and belong only to their actual day', () => {
  const entry = task({ time: '23:59' });
  assert.ok(validEntry(entry));
  assert.ok(validEntry({ ...entry, type: 'meeting' }));
  assert.ok(validEntry({ ...entry, type: 'event' }));
  assert.equal(validEntry({ ...entry, atTime: false }), false);
  assert.equal(validEntry({ ...entry, allDay: true }), false);
  assert.equal(validEntry({ ...entry, endAt: '2026-10-22T00:00:00Z' }), false);
  assert.equal(segment(entry, '2026-10-20'), null);
  assert.deepEqual(segment(entry, '2026-10-21'), entry);
  assert.equal(segment(entry, '2026-10-22'), null);
  assert.deepEqual(endParts(entry), { date: entry.date, time: entry.time });
});

test('zero-duration tasks stay visible and use separate lanes at the same time', () => {
  const entries = [task(), task({ id: 'second' })];
  const layout = layoutEvents(entries, 0, 1440);
  assert.equal(layout.length, 2);
  assert.equal(new Set(layout.map((row) => row.lane)).size, 2);
  assert.ok(
    layout.every((row) => row.top === 750 * 1.5 && row.height === 88 && row.e.duration === 0),
  );
  assert.equal(layoutEvents([task({ time: '07:59' })], 480, 1200).length, 0);
  assert.equal(layoutEvents([task({ time: '20:00' })], 480, 1200).length, 0);
  const [last] = layoutEvents([task({ time: '23:59' })], 0, 1440);
  assert.ok(last.top + last.height <= 1440 * 1.5 + 88);
});

test('migration preserves imported entry times, statuses, IDs and colors', () => {
  const imported = Object.freeze(
    task({ atTime: undefined, duration: 900, importKey: 'csv:one', completed: true }),
  );
  const meeting = Object.freeze({ ...imported, id: 'meeting', type: 'meeting' });
  const event = Object.freeze({ ...imported, id: 'event', type: 'event' });
  const localTask = Object.freeze({ ...imported, id: 'manual', importKey: undefined });
  const unknown = Object.freeze({ futureSchema: true });
  const records = Object.freeze([imported, meeting, event, localTask, unknown]);
  const [updated, updatedMeeting, updatedEvent, ...untouched] = importedEntriesAtTime(records);
  assert.ok(validEntry(updated));
  assert.equal(updated.atTime, true);
  assert.equal(updated.duration, 0);
  for (const key of ['id', 'importKey', 'time', 'date', 'color', 'completed'])
    assert.equal(updated[key], imported[key]);
  assert.deepEqual(updatedMeeting, {
    ...meeting,
    atTime: true,
    allDay: false,
    duration: 0,
    endAt: undefined,
  });
  assert.deepEqual(updatedEvent, {
    ...event,
    atTime: true,
    allDay: false,
    duration: 0,
    endAt: undefined,
  });
  assert.deepEqual(untouched, [localTask, unknown]);
  assert.equal(imported.duration, 900);
  assert.deepEqual(importedEntriesAtTime([updated]), [updated]);
});

test('zoned scheduled tasks and recurring occurrences keep a start without an end', () => {
  const entry = task({ startAt: '2026-10-21T09:30:00.000Z', recurrence: { frequency: 'daily' } });
  assert.ok(validEntry(entry));
  assert.equal(displayEntry(entry, 'Asia/Tokyo').time, '18:30');
  assert.equal(displayEntry(entry, 'Asia/Tokyo').duration, 0);
  const next = occurrence(entry, '2026-10-22', 'Europe/Moscow');
  assert.ok(validEntry(next));
  assert.equal(next.startAt, '2026-10-22T09:30:00.000Z');
  assert.equal(next.endAt, undefined);
  assert.equal(next.duration, 0);
  const boundary = task({ date: '2026-10-20', time: '00:00' });
  assert.equal(completePastTasks([boundary])[0].completed, false);
});

test('assistant edits scheduled task time without inventing duration, explicit duration restores an interval', () => {
  const prefs = { ...defaults, zone: 'Europe/Moscow' };
  const now = new Date('2026-10-21T08:00:00Z');
  for (const entry of [task(), task({ startAt: '2026-10-21T09:30:00.000Z' })]) {
    const moved = executeCommand(
      { intent: 'update_event', id: entry.id, fields: { time: '15:00' } },
      [entry],
      {},
      prefs,
      'move',
      'перенеси',
      now,
    ).records[0];
    assert.ok(validEntry(moved));
    assert.equal(moved.atTime, true);
    assert.equal(moved.duration, 0);
    assert.equal(moved.time, '15:00');
    assert.equal(moved.endAt, undefined);
    const timed = executeCommand(
      { intent: 'update_event', id: moved.id, fields: { duration: 90 } },
      [moved],
      {},
      prefs,
      'duration',
      'длительность',
      now,
    ).records[0];
    assert.ok(validEntry(timed));
    assert.equal(timed.atTime, false);
    assert.equal(timed.duration, 90);
  }
});

test('assistant creates all three types at their exact time without inventing an end', () => {
  for (const type of ['task', 'meeting', 'event']) {
    const label = { task: 'задача', meeting: 'встреча', event: 'событие' }[type];
    const command = interpretLocal(
      `${label} Проверка; 2026-10-21; 08:00`,
      {},
      defaults,
      new Date('2026-10-21T00:00:00Z'),
    );
    const result = executeCommand(
      command,
      [],
      {},
      defaults,
      type,
      'создай',
      new Date('2026-10-21T00:00:00Z'),
    );
    const entry = result.records[0];
    assert.ok(validEntry(entry));
    assert.equal(entry.type, type);
    assert.equal(entry.time, '08:00');
    assert.equal(entry.duration, 0);
    assert.equal(entry.atTime, true);
    assert.ok(entry.startAt);
    assert.equal(entry.endAt, undefined);
    assert.doesNotMatch(result.reply, /60 минут/);
  }
});
