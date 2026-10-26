import test from 'node:test';
import assert from 'node:assert/strict';
import {
  segment,
  endParts,
  toInstant,
  displayEntry,
  commentOf,
  searchEntries,
  defaults,
  dueReminders,
  loadRecords,
  ENTRY_KEY,
  readJSON,
  dateLabel,
  loadPreferences,
} from '../.tools/test-build/model.js';
import { validEntry, parseCommand } from '../.tools/test-build/calendar.js';
const legacy = {
  id: 'old',
  title: 'Старая задача',
  type: 'task',
  date: '2026-10-12',
  time: '23:00',
  duration: 180,
  color: '#123abc',
  important: true,
  description: 'Старый комментарий',
};
test('midnight produces two segments sharing one ID, exclusive end', () => {
  assert.equal(segment(legacy, '2026-10-12').duration, 60);
  assert.equal(segment(legacy, '2026-10-13').duration, 120);
  assert.equal(segment(legacy, '2026-10-13').time, '00:00');
  assert.equal(segment(legacy, '2026-10-13').id, legacy.id);
  assert.equal(segment(legacy, '2026-10-14'), null);
  assert.equal(segment({ ...legacy, time: '23:00', duration: 60 }, '2026-10-13'), null);
});
test('48 hours, month, year, and leap day boundaries', () => {
  const cases = [
    ['2026-10-12', 2880, '2026-10-14'],
    ['2026-10-31', 180, '2026-11-01'],
    ['2026-12-31', 180, '2027-01-01'],
    ['2028-02-28', 180, '2028-02-29'],
    ['2028-02-29', 180, '2028-03-01'],
  ];
  for (const [date, duration, end] of cases) {
    const e = { ...legacy, date, duration };
    assert.equal(endParts(e).date, end);
    assert.ok(segment(e, end));
    assert.ok(validEntry(e));
  }
  const e = { ...legacy, time: '00:00', duration: 2880 };
  assert.equal(segment(e, '2026-10-14'), null);
  assert.equal(segment(e, '2026-10-13').duration, 1440);
});
test('timezone changes preserve absolute instants and leave floating legacy dates unchanged', () => {
  const e = {
    ...legacy,
    startAt: toInstant(legacy.date, legacy.time, 'Europe/Moscow'),
    endAt: toInstant('2026-10-13', '02:00', 'Europe/Moscow'),
  };
  const saved = JSON.stringify(e);
  assert.equal(displayEntry(e, 'Asia/Tokyo').date, '2026-10-13');
  assert.equal(displayEntry(e, 'America/New_York').time, '16:00');
  assert.equal(JSON.stringify(e), saved);
  assert.deepEqual(displayEntry(legacy, 'Asia/Tokyo'), legacy);
});
test('timezone conversion rejects impossible dates and DST gaps', () => {
  assert.throws(() => toInstant('2026-02-30', '10:00', 'UTC'));
  assert.throws(() => toInstant('2026-10-12', '25:00', 'UTC'));
  assert.throws(() => toInstant('2026-03-08', '02:30', 'America/New_York'));
  assert.equal(toInstant('2026-10-12', '23:00', 'Europe/Moscow'), '2026-10-12T20:00:00.000Z');
});
test('global case insensitive search includes old comments, past/future and start date', () => {
  const future = { ...legacy, id: 'future', date: '2030-01-01', comment: 'Новый текст' };
  assert.equal(commentOf(legacy), 'Старый комментарий');
  assert.equal(searchEntries([legacy, future], 'КОММЕНТАРИЙ')[0].id, 'old');
  assert.equal(searchEntries([legacy, future], 'НОВЫЙ')[0].date, '2030-01-01');
  assert.equal(searchEntries([legacy, future], 'ЗАДАЧА').length, 2);
});
test('legacy storage round trip preserves colors, unknown fields, malformed records, settings, and chat', () => {
  const data = new Map();
  globalThis.localStorage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, String(v)),
  };
  const old = { ...legacy, completed: true, extra: 'preserve' };
  const records = [old, { futureSchema: 3 }];
  localStorage.setItem(ENTRY_KEY, JSON.stringify(records));
  localStorage.setItem('voicetask.chat.v1', JSON.stringify([{ role: 'user', text: 'история' }]));
  assert.deepEqual(loadRecords(), records);
  assert.equal(validEntry(old), true);
  assert.equal(old.color, '#123abc');
  assert.equal(readJSON('voicetask.chat.v1', [])[0].text, 'история');
  localStorage.setItem(ENTRY_KEY, 'broken');
  assert.throws(() => loadRecords());
  assert.equal(localStorage.getItem(ENTRY_KEY), 'broken');
  localStorage.setItem(
    'voicetask.preferences.v2',
    JSON.stringify({ theme: 'dark', hourStart: 25, hourEnd: 1, zone: 'invalid', accent: 'bad' }),
  );
  const p = loadPreferences();
  assert.equal(p.theme, 'dark');
  assert.equal(p.hourEnd, 24);
  assert.equal(p.accent, defaults.accent);
});
test('overdue reminder once across reload; deadline edits generate a fresh reminder', () => {
  const p = { ...defaults, zone: 'UTC' },
    now = Date.parse('2026-10-13T12:00:00Z');
  const first = dueReminders([legacy], p, now, []);
  assert.equal(first.length, 1);
  const seen = JSON.parse(JSON.stringify(first.map((v) => v.key)));
  assert.equal(dueReminders([legacy], p, now, seen).length, 0);
  assert.equal(
    dueReminders([{ ...legacy, time: '11:55', date: '2026-10-13' }], p, now, seen).length,
    1,
  );
  assert.equal(dueReminders([{ ...legacy, completed: true }], p, now, []).length, 0);
  assert.equal(dueReminders([{ ...legacy, type: 'meeting' }], p, now, []).length, 0);
  assert.equal(dueReminders([legacy], { ...p, enabled: false }, now, []).length, 0);
});
test('lead windows, categories, important reminders and daily review', () => {
  const now = Date.parse('2026-10-12T22:50:00Z'),
    p = { ...defaults, zone: 'UTC' };
  assert.equal(dueReminders([legacy], p, now, []).length, 1);
  assert.equal(dueReminders([legacy], { ...p, lead: 5 }, now, []).length, 0);
  assert.equal(dueReminders([legacy], { ...p, tasks: false, important: false }, now, []).length, 0);
  const daily = dueReminders([], { ...p, daily: true }, now, []);
  assert.equal(daily.length, 1);
  assert.equal(dueReminders([], { ...p, daily: true }, now, [daily[0].key]).length, 0);
});

test('event reminders follow their own preference and never become overdue tasks', () => {
  const prefs = { ...defaults, zone: 'UTC', important: false };
  const event = { ...legacy, type: 'event', important: false };
  const before = Date.parse('2026-10-12T22:50:00Z');
  assert.match(dueReminders([event], prefs, before, [])[0].text, /Скоро событие/);
  assert.deepEqual(dueReminders([event], { ...prefs, events: false }, before, []), []);
  assert.deepEqual(dueReminders([event], prefs, Date.parse('2026-10-13T12:00:00Z'), []), []);
});

test('historical imports do not send retrospective alerts while future imported tasks still remind', () => {
  const prefs = { ...defaults, zone: 'UTC' };
  const now = Date.parse('2026-10-13T12:00:00Z');
  assert.deepEqual(
    dueReminders([{ ...legacy, importedAt: new Date(now).toISOString() }], prefs, now, []),
    [],
  );
  const upcoming = {
    ...legacy,
    date: '2026-10-13',
    time: '12:10',
    importedAt: new Date(now).toISOString(),
  };
  assert.equal(dueReminders([upcoming], prefs, now, []).length, 1);
  assert.equal(dueReminders([upcoming], prefs, now + 20 * 60000, []).length, 1);
});
test('chat now supports multiday duration and completed state survives JSON', () => {
  const { entry } = parseCommand('задача Длинная задача; 2026-12-31; 23:00; 2880; важно');
  assert.ok(validEntry(entry));
  assert.equal(endParts(entry).date, '2027-01-02');
  assert.equal(JSON.parse(JSON.stringify({ ...entry, completed: true })).completed, true);
});
test('date formats', () => {
  assert.equal(dateLabel('2026-10-12', 'DD.MM.YYYY'), '12.10.2026');
  assert.equal(dateLabel('2026-10-12', 'MM/DD/YYYY'), '10/12/2026');
  assert.equal(dateLabel('2026-10-12', 'YYYY-MM-DD'), '2026-10-12');
});
test('explicit chat end date and timezone-relative today', () => {
  const result = parseCommand('встреча Ночь; 2026-12-31; 23:00; 2027-01-01 02:00; важно');
  assert.equal(result.entry.duration, 180);
  assert.equal(result.end.date, '2027-01-01');
  assert.equal(
    parseCommand('задача Сегодня; сегодня; 09:00', '2028-02-29').entry.date,
    '2028-02-29',
  );
  assert.equal(parseCommand('задача Завтра; завтра; 09:00', '2028-02-29').entry.date, '2028-03-01');
  assert.equal(parseCommand('задача Ошибка; 2026-02-28; 10:00; 2026-02-30 12:00').entry, undefined);
});
test('DST elapsed duration and repeated hour retain exact timestamps and day access', () => {
  const startAt = toInstant('2026-03-08', '01:30', 'America/New_York'),
    endAt = toInstant('2026-03-08', '03:30', 'America/New_York');
  assert.equal((Date.parse(endAt) - Date.parse(startAt)) / 60000, 60);
  const repeat = {
    ...legacy,
    startAt: '2026-11-01T05:30:00Z',
    endAt: '2026-11-01T06:30:00Z',
    duration: 60,
  };
  const displayed = displayEntry(repeat, 'America/New_York');
  assert.ok(segment(displayed, '2026-11-01'));
  assert.equal(endParts(displayed).time, '01:30');
  assert.equal(repeat.duration, 60);
});
