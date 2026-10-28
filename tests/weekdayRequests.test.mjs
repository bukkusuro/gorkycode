import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretAssistant } from '../.tools/test-build/aiInterpreter.js';
import { processRequest } from '../.tools/test-build/assistantEngine.js';
import { defaults } from '../.tools/test-build/model.js';

const prefs = { ...defaults, zone: 'Europe/Moscow' };
const tuesday = new Date('2026-10-27T15:10:00Z');
const originalFetch = globalThis.fetch;
test.beforeEach(() => {
  globalThis.fetch = () => assert.fail('An unambiguous weekday request reached the network');
});
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});
const interpret = (text, context = {}, settings = prefs, now = tuesday) =>
  interpretAssistant(text, context, settings, now, [], [], 'weekdays', crypto.randomUUID());
const run = (text, records, context = {}, now = tuesday) =>
  processRequest(interpret, text, records, context, prefs, crypto.randomUUID(), now);
const meeting = (id, date, patch = {}) => ({
  id,
  date,
  type: 'meeting',
  title: 'Планёрка',
  time: '15:00',
  duration: 0,
  atTime: true,
  color: '#123abc',
  important: false,
  description: '',
  ...patch,
});

test('this and nearest weekday select the next occurrence without becoming a title filter', async () => {
  for (const [phrase, date] of [
    ['на этот понедельник', '2026-11-02'],
    ['на этот вторник', '2026-10-27'],
    ['на эту среду', '2026-10-28'],
    ['на этот четверг', '2026-10-29'],
    ['на эту пятницу', '2026-10-30'],
    ['на эту субботу', '2026-10-31'],
    ['на это воскресенье', '2026-11-01'],
    ['в ближайший понедельник', '2026-11-02'],
    ['в ближайшую среду', '2026-10-28'],
    ['в ближайшее воскресенье', '2026-11-01'],
  ]) {
    const command = await interpret(`удали встречу ${phrase}`);
    assert.equal(command.intent, 'delete_event', phrase);
    assert.equal(command.type, 'meeting', phrase);
    assert.equal(command.start, date, phrase);
    assert.equal(command.end, date, phrase);
    assert.equal(command.query, undefined, phrase);
  }
});

test('nearest weekday includes today and uses the selected timezone across week boundaries', async () => {
  for (const [now, zone, phrase, date] of [
    ['2026-10-29T16:00:00Z', 'Europe/Moscow', 'этот четверг', '2026-10-29'],
    ['2026-11-01T16:00:00Z', 'Europe/Moscow', 'этот понедельник', '2026-11-02'],
    ['2026-10-28T22:30:00Z', 'Europe/Moscow', 'эту среду', '2026-11-04'],
    ['2026-10-29T00:30:00Z', 'America/New_York', 'эту среду', '2026-10-28'],
  ]) {
    const command = await interpret(
      `Покажи встречи на ${phrase}`,
      {},
      { ...prefs, zone },
      new Date(now),
    );
    assert.equal(command.start, date, `${zone}: ${phrase}`);
    assert.equal(command.end, date);
  }
});

test('the reported deletion finds the nearest Thursday and still requires confirmation', async () => {
  const records = [meeting('nearest', '2026-10-29'), meeting('later', '2026-11-05')];
  const result = await run('удали встречу на этот четверг', records, {
    lastId: 'later',
    pending: { intent: 'delete_event', type: 'meeting', query: 'этот', start: '2026-10-29' },
  });
  assert.equal(result.records, undefined);
  assert.equal(result.context.confirmation.id, 'nearest');
  assert.match(result.reply, /Ответьте «Да» или «Нет»/);
  const cancelled = await run('нет', records, result.context);
  assert.equal(cancelled.context.confirmation, undefined);
  const confirmed = await run('да', records, result.context);
  assert.deepEqual(confirmed.records, [records[1]]);
});

test('several meetings on this weekday still require a numbered choice before deletion', async () => {
  const records = [
    meeting('first', '2026-10-29'),
    meeting('second', '2026-10-29', { time: '16:00' }),
  ];
  const result = await run('удали встречу на этот четверг', records);
  assert.equal(result.records, undefined);
  assert.equal(result.context.confirmation, undefined);
  assert.deepEqual(result.context.candidates, ['first', 'second']);
  assert.match(result.reply, /несколько записей/);
  const chosen = await run('вторую', records, result.context);
  assert.equal(chosen.records, undefined);
  assert.equal(chosen.context.confirmation.id, 'second');
  const confirmed = await run('да', records, chosen.context);
  assert.deepEqual(confirmed.records, [records[0]]);
});

test('creation and rescheduling consume the whole weekday phrase while next week stays distinct', async () => {
  const created = await run('Создай встречу Планёрка на этот четверг в 15:00', []);
  assert.equal(created.records[0].title, 'планерка');
  assert.equal(created.records[0].date, '2026-10-29');
  const moved = await run('Перенеси её на эту пятницу в 16:00', created.records, created.context);
  assert.equal(moved.records[0].date, '2026-10-30');
  assert.equal(moved.records[0].time, '16:00');
  assert.equal(moved.records[0].title, 'планерка');
  const next = await interpret('удали встречу на следующий четверг');
  assert.equal(next.start, '2026-11-05');
  assert.equal(next.query, undefined);
  const week = await interpret('Что у меня на следующей неделе?');
  assert.equal(week.start, '2026-11-02');
  assert.equal(week.end, '2026-11-08');
});
