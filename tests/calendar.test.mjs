import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCommand,
  dateKey,
  addDays,
  weekStart,
  validEntry,
} from '../.tools/test-build/calendar.js';

test('creates a task at the specified time without a default duration', () => {
  const { entry } = parseCommand('задача Подготовить отчёт; сегодня; 14:00');
  assert.equal(entry.type, 'task');
  assert.equal(entry.date, dateKey(new Date()));
  assert.equal(entry.duration, 0);
  assert.equal(entry.atTime, true);
  assert.ok(validEntry(entry));
});
test('creates an important meeting with custom duration for tomorrow', () => {
  const { entry } = parseCommand('ВСТРЕЧА Обсудить проект; завтра; 10:30; 90; важно');
  assert.equal(entry.type, 'meeting');
  assert.equal(entry.date, dateKey(addDays(new Date(), 1)));
  assert.equal(entry.important, true);
  assert.equal(entry.duration, 90);
});
test('rejects invalid dates and times, short entries', () => {
  for (const command of [
    'задача Тест; 2026-02-30; 10:00',
    'задача Тест; сегодня; 25:00',
    'задача Тест; сегодня; 10:60',
    'задача Тест; сегодня; 10:00; 0',
    'встреча Тест; сегодня; 10:00; 4',
  ])
    assert.equal(parseCommand(command).entry, undefined, command);
});
test('allows an entry ending exactly at midnight', () => {
  assert.ok(parseCommand('задача Тест; сегодня; 23:00; 60').entry);
});
test('unsupported free text explains limitations and help creates no entry', () => {
  const result = parseCommand('Расскажи о погоде');
  assert.equal(result.entry, undefined);
  assert.match(result.reply, /только с командами/);
  assert.equal(parseCommand('помощь').entry, undefined);
  assert.match(parseCommand('помощь').reply, /ГГГГ-ММ-ДД/);
});
test('weeks start on Monday including Sundays and year transitions', () => {
  assert.equal(dateKey(weekStart(new Date(2026, 9, 11, 12))), '2026-10-05');
  assert.equal(dateKey(weekStart(new Date(2026, 9, 5, 12))), '2026-10-05');
  assert.equal(dateKey(weekStart(new Date(2027, 0, 1, 12))), '2026-12-28');
});
test('storage validation rejects malformed data', () => {
  const entry = parseCommand('задача Проверка; 2026-10-20; 10:00').entry;
  assert.ok(validEntry(entry));
  assert.equal(validEntry(null), false);
  assert.equal(validEntry({ ...entry, color: 'invalid' }), false);
  assert.equal(validEntry({ ...entry, time: undefined }), false);
});

test('events are valid entries and technical commands use the event palette color', () => {
  const { entry } = parseCommand('событие Демо проекта; 2026-10-20; 12:00');
  assert.ok(validEntry(entry));
  assert.equal(entry.type, 'event');
  assert.equal(entry.color, '#f7e5cf');
});
