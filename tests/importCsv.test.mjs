import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importCsv, classifyEntry } from '../.tools/test-build/importCsv.js';
import { defaults } from '../.tools/test-build/model.js';
import { validEntry } from '../.tools/test-build/calendar.js';

const now = new Date('2026-10-20T09:00:00.000Z');
const csv = (...rows) => ['id,date,time,text', ...rows].join('\n');
const load = (text, existing = []) => importCsv(text, defaults, existing, now);

test('all bundled entries have a start time without a duration or end', () => {
  const source = readFileSync(
    new URL('../public/data/voice-assistant-events.csv', import.meta.url),
    'utf8',
  );
  const result = load(source);
  assert.equal(result.total, 1000);
  assert.equal(result.entries.length, 1000);
  assert.equal(result.duplicates, 0);
  assert.deepEqual(result.counts, { task: 768, meeting: 178, event: 54 });
  assert.equal(result.start, '2024-01-07');
  assert.equal(result.end, '2027-12-31');
  assert.equal(new Set(result.entries.map((entry) => entry.id)).size, 1000);
  assert.ok(result.entries.every(validEntry));
  assert.ok(result.entries.every((entry) => entry.id === entry.importKey));
  assert.ok(result.entries.every((entry) => entry.importedAt === now.toISOString()));
  assert.ok(
    result.entries.every(
      (entry) => entry.atTime && entry.duration === 0 && !entry.endAt && !entry.important,
    ),
  );
  for (const entry of result.entries) {
    assert.equal(entry.duration, 0, entry.title);
    assert.equal(entry.color, defaults[`${entry.type}Color`]);
  }
});

test('classification reserves events for project demos and retains task/meeting distinctions', () => {
  for (const title of ['Демо проекта по хакатону', '  ДЕМО ПРОЕКТА  ', 'демо   проекта клиенту'])
    assert.equal(classifyEntry(title), 'event', title);
  for (const title of [
    'Встреча с Иваном',
    'Созвон с командой',
    'Провести планёрку',
    'Обсудить договор с Марией',
  ])
    assert.equal(classifyEntry(title), 'meeting', title);
  for (const title of [
    'Подготовить демо проекта',
    'Демо продукта',
    'Демо проектация',
    'Отправить итоги встречи',
    'Подготовить материалы для созвона',
    'Событие в календаре',
  ])
    assert.equal(classifyEntry(title), 'task', title);
});

test('adjacent, simultaneous and last entries never acquire a duration', () => {
  const result = load(
    csv(
      'late,2026-10-20,23:30,Встреча последняя',
      'first,2026-10-20,09:00,Встреча первая',
      'next-day,2026-10-21,09:00,Другой день',
      'same,2026-10-20,09:00,Параллельная задача',
      'middle,2026-10-20,11:00,Демо проекта',
    ),
  );
  assert.deepEqual(
    Object.fromEntries(result.entries.map((entry) => [entry.title, entry.duration])),
    {
      'Встреча последняя': 0,
      'Встреча первая': 0,
      'Другой день': 0,
      'Параллельная задача': 0,
      'Демо проекта': 0,
    },
  );
  assert.ok(
    load(csv('1,2026-10-20,10:00,Встреча первая', '2,2026-10-20,10:04,Вторая')).entries.every(
      validEntry,
    ),
  );
});

test('BOM, CRLF, reordered columns, quoted commas, multiline text and escaped quotes survive', () => {
  const text =
    '\uFEFFtext,time,id,date\r\n"Текст, с ""кавычками""\r\nВторая строка",09:00,a,2026-10-20\r\n';
  const result = load(text);
  assert.equal(result.total, 1);
  assert.equal(result.entries[0].title, 'Текст, с "кавычками"\r\nВторая строка');
  assert.equal(result.entries[0].date, '2026-10-20');
  assert.equal(result.entries[0].time, '09:00');
  assert.equal(result.entries[0].duration, 0);
  assert.equal(result.entries[0].atTime, true);
});

test('semicolon files preserve quoted delimiters and escaped quotes', () => {
  const result = load('id;date;time;text\r\na;2026-10-20;09:00;"Проверить; ""договор"""\r\n');
  assert.equal(result.entries[0].title, 'Проверить; "договор"');
  assert.equal(result.total, 1);
});

test('invalid headers, dates, times, IDs, columns and quotes fail before importing', () => {
  for (const text of [
    '',
    'id,date,time,text',
    'id,date,time,title\n1,2026-10-20,10:00,Текст',
    'id,date,time,text,id\n1,2026-10-20,10:00,Текст,2',
    csv('1,2026-02-30,10:00,Текст'),
    csv('1,2026-13-01,10:00,Текст'),
    csv('1,2026-10-20,24:00,Текст'),
    csv('1,2026-10-20,09:60,Текст'),
    csv('1,2026-10-20,9:00,Текст'),
    csv(',2026-10-20,10:00,Текст'),
    csv('1,2026-10-20,10:00,   '),
    csv('1,2026-10-20,10:00,Текст', ' 1 ,2026-10-21,11:00,Другой текст'),
    csv('1,2026-10-20,10:00'),
    csv('1,2026-10-20,10:00,Текст,лишний столбец'),
    csv('1,2026-10-20,10:00,"Незакрытая строка'),
    csv('1,2026-10-20,10:00,"Текст"лишнее'),
    csv('1,2026-10-20,10:00,Текст"'),
  ])
    assert.throws(() => load(text), text);
});

test('reimport recognizes stable import keys after editing and does not overwrite or mutate records', () => {
  const text = csv('1,2026-10-20,09:00,Демо проекта', '2,2026-10-20,10:00,Отправить отчёт');
  const first = load(text);
  const edited = Object.freeze({
    ...first.entries[0],
    id: 'user-edited-id',
    title: 'Исправленная запись',
    date: '2026-11-01',
    time: '16:00',
    duration: 90,
    atTime: false,
    color: '#123abc',
    important: true,
    comment: 'Сохранить правки',
  });
  const unknown = Object.freeze({ id: 'future', futureFormat: true });
  const existing = Object.freeze([edited, Object.freeze(first.entries[1]), unknown]);
  const snapshot = structuredClone(existing);
  const second = load(text, existing);
  assert.equal(second.total, 2);
  assert.equal(second.duplicates, 2);
  assert.deepEqual(second.entries, []);
  assert.deepEqual(existing, snapshot);
  assert.equal(edited.importKey, first.entries[0].importKey);
  assert.equal(edited.id, 'user-edited-id');
  assert.equal(edited.title, 'Исправленная запись');
  const repeated = load(text);
  assert.deepEqual(
    repeated.entries.map((entry) => entry.id),
    first.entries.map((entry) => entry.id),
  );
});

test('importance requires an explicit positive marker and respects negation', () => {
  for (const title of [
    'Важно отправить договор',
    'Срочно проверить отчёт',
    'Дедлайн проекта',
    'Очень важная задача',
  ])
    assert.equal(load(csv(`1,2026-10-20,09:00,${title}`)).entries[0].important, true, title);
  for (const title of [
    'Обычная задача',
    'Неважно отправить договор',
    'Несрочно проверить отчёт',
    'Не важно отправить договор',
    'Не срочно проверить отчёт',
  ])
    assert.equal(load(csv(`1,2026-10-20,09:00,${title}`)).entries[0].important, false, title);
});
