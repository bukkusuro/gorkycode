import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assistantStatus,
  interpretAI,
  interpretAssistant,
} from '../.tools/test-build/aiInterpreter.js';
import { processRequest } from '../.tools/test-build/assistantEngine.js';
import { defaults } from '../.tools/test-build/model.js';
import { readFileSync } from 'node:fs';
import { importCsv } from '../.tools/test-build/importCsv.js';
import { calendarHelp, scopeMessage } from '../.tools/test-build/assistantPolicy.js';

const command = {
  intent: 'create_task',
  fields: { title: 'Позвонить', date: '2026-10-22', time: '08:00' },
};
const now = new Date('2026-10-21T08:00:00Z');
const originalFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('unexpected free-form model prose is never shown to the user', async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        command: { intent: 'answer_question', answer: 'function calculator() {}' },
      }),
    );
  assert.deepEqual(
    await interpretAI('Покажи мои задачи завтра', {}, defaults, now, [], [], 'chat', 'request'),
    { intent: 'answer_question', answer: calendarHelp },
  );
});

test('misspelled dates and command words are normalized before collecting relevant calendar context', async () => {
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.text, 'Отметь задачу выполненным сегодня в 10:15');
    assert.equal(body.calendar.start, '2026-10-21');
    assert.equal(body.calendar.time, '10:15');
    return new Response(
      JSON.stringify({ command: { intent: 'complete_task', start: '2026-10-21', time: '10:15' } }),
    );
  };
  await interpretAI(
    'Отметь задчу выполенным севодня в 10:15',
    {},
    { ...defaults, zone: 'Europe/Moscow' },
    now,
    [],
    [],
    'chat',
    'request',
  );
});

test('client sends text and bounded conversation context only to its own local API', async () => {
  const records = [
    {
      id: 'one',
      title: 'Первая',
      type: 'task',
      description: 'private unused description',
      color: '#123abc',
    },
    { id: 'other', title: 'Не выбрана' },
  ];
  const history = [
    { role: 'assistant', text: 'Ошибка', error: true },
    ...Array.from({ length: 20 }, (_, i) => ({ role: 'user', text: `Сообщение ${i}` })),
  ];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, './api/assistant');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, undefined);
    const body = JSON.parse(options.body);
    assert.equal(body.text, 'Позвонить');
    assert.equal(body.conversationId, 'chat');
    assert.equal(body.requestId, 'request');
    assert.equal(body.now, now.toISOString());
    assert.equal(body.history.length, 12);
    assert.deepEqual(body.entries, [{ id: 'one', title: 'Первая', type: 'task' }]);
    assert.ok(!options.body.includes('private unused description'));
    return new Response(JSON.stringify({ command }));
  };
  assert.deepEqual(
    await interpretAI(
      'Позвонить',
      { lastId: 'one@2026-10-22' },
      defaults,
      now,
      history,
      records,
      'chat',
      'request',
    ),
    command,
  );
});

test('invalid model commands and provider errors never become calendar operations', async () => {
  for (const value of [
    { intent: 'eval' },
    { intent: 'update_event', fields: { completed: true } },
    { intent: 'create_task', fields: { date: '2026-02-30' } },
  ]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ command: value }));
    await assert.rejects(() => interpretAI('Текст', {}, defaults, now, [], [], 'chat', 'request'));
  }
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: 'Phala временно перегружен' }), { status: 429 });
  await assert.rejects(
    () => interpretAI('Текст', {}, defaults, now, [], [], 'chat', 'request'),
    /Phala временно перегружен/,
  );
});

test('status is optional when the server is offline and never includes a browser credential', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ configured: true, model: 'test-model' }));
  assert.deepEqual(await assistantStatus(), { configured: true, model: 'test-model' });
  globalThis.fetch = async () => new Response('not an API', { status: 404 });
  assert.equal(await assistantStatus(), null);
  globalThis.fetch = async () => {
    throw Error('offline');
  };
  assert.equal(await assistantStatus(), null);
});

test('a fresh conversation includes real calendar matches for relative date and time', async () => {
  const p = { ...defaults, zone: 'Europe/Moscow' };
  const imported = importCsv(
    readFileSync(new URL('../public/data/voice-assistant-events.csv', import.meta.url), 'utf8'),
    p,
    [],
    now,
  );
  const entries = imported.entries;
  assert.equal(entries.length, 1000);
  const target = entries.find(
    (entry) => entry.date === '2026-10-21' && entry.time === '10:15' && entry.type === 'task',
  );
  assert.ok(target);
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.ok(body.entries.some((entry) => entry.id === target.id));
    assert.ok(body.entries.every((entry) => entry.date === '2026-10-21' && entry.time === '10:15'));
    assert.deepEqual(body.calendar, {
      start: '2026-10-21',
      end: '2026-10-21',
      time: '10:15',
      partial: true,
      matchingCount: body.entries.length,
      truncated: false,
    });
    return new Response(
      JSON.stringify({
        command: { intent: 'complete_task', type: 'task', start: '2026-10-21', time: '10:15' },
      }),
    );
  };
  await interpretAI(
    'Отметь выполненным задачу на сегодня в 10:15',
    {},
    p,
    now,
    [],
    entries,
    'chat',
    'request',
  );
});

test('calendar context expands recurring occurrences and bounds large day results', async () => {
  const p = { ...defaults, zone: 'Europe/Moscow' };
  const base = {
    id: 'daily',
    title: 'Повтор',
    type: 'task',
    date: '2026-10-01',
    time: '10:15',
    duration: 0,
    atTime: true,
    recurrence: { frequency: 'daily' },
    color: '#123abc',
    description: '',
    important: false,
    completed: false,
  };
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.ok(body.entries.some((entry) => entry.id === 'daily@2026-10-22'));
    assert.ok(!body.entries.some((entry) => entry.id === 'daily'));
    return new Response(
      JSON.stringify({ command: { intent: 'reopen_task', id: 'daily@2026-10-22' } }),
    );
  };
  await interpretAI(
    'Верни её в невыполненные',
    { lastId: 'daily@2026-10-22' },
    p,
    now,
    [],
    [base],
    'chat',
    'request',
  );
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.entries.length, 60);
    assert.equal(body.calendar.matchingCount, 1000);
    assert.equal(body.calendar.truncated, true);
    return new Response(
      JSON.stringify({ command: { intent: 'list_events', start: '2026-10-22' } }),
    );
  };
  await interpretAI(
    'Что у меня завтра?',
    {},
    p,
    now,
    [],
    Array.from({ length: 1000 }, (_, i) => ({
      ...base,
      id: `item-${i}`,
      date: '2026-10-22',
      recurrence: undefined,
    })),
    'chat',
    'request2',
  );
});

const prefs = { ...defaults, zone: 'Europe/Moscow' };
function resilientRequest(text, context = {}, records = []) {
  return processRequest(
    (value, state, preferences, date) =>
      interpretAssistant(value, state, preferences, date, [], records, 'resilient-chat', 'request'),
    text,
    records,
    context,
    prefs,
    'operation',
    now,
  );
}
function unavailable(status = 504, retryable = true) {
  let posts = 0;
  globalThis.fetch = async (_url, options) => {
    if (!options.method) return Response.json({ configured: true, model: 'test-model' });
    posts++;
    return Response.json({ error: 'Provider unavailable', retryable }, { status });
  };
  return () => posts;
}

test('ordinary commands finish without waiting on any provider', async () => {
  for (const code of [429, 500, 502, 503, 504]) {
    const calls = unavailable(code);
    const result = await resilientRequest('Создай встречу с Мариу завтра в 22:00');
    assert.equal(calls(), 0, 'unambiguous commands do not reach the provider');
    assert.equal(result.records.length, 1);
    const saved = result.records[0];
    assert.equal(saved.type, 'meeting');
    assert.equal(saved.title, 'с мариу');
    assert.equal(saved.date, '2026-10-22');
    assert.equal(saved.time, '22:00');
    assert.equal(saved.atTime, true);
    assert.equal(saved.duration, 0);
    assert.equal(saved.endAt, undefined);
    assert.equal(saved.operationId, 'operation');
  }
});

test('structured creation commands save locally even when the provider rejects access', async () => {
  globalThis.fetch = async () => assert.fail('A validated structured command reached the network');
  for (const [text, type, title, date, time, duration, important] of [
    ['задача Подготовить презентацию; завтра; 14:00', 'task', 'Подготовить презентацию', '2026-10-22', '14:00', 0, false],
    ['встреча План на завтра и отчёт 2027; сегодня; 10:00; 30; важно', 'meeting', 'План на завтра и отчёт 2027', '2026-10-21', '10:00', 30, true],
    ['событие Концерт; 2026-12-31; 18:00', 'event', 'Концерт', '2026-12-31', '18:00', 0, false],
  ]) {
    const result = await resilientRequest(text);
    assert.equal(result.records.length, 1, text);
    const saved = result.records[0];
    assert.equal(saved.type, type);
    assert.equal(saved.title, title);
    assert.equal(saved.date, date);
    assert.equal(saved.time, time);
    assert.equal(saved.duration, duration);
    assert.equal(saved.important, important);
    assert.equal(saved.atTime, duration === 0);
    assert.match(result.reply, /Сохранено/);
  }
});

test('invalid or multiple structured commands are not executed as a local creation', async () => {
  const calls = unavailable(502, false);
  for (const text of [
    'задача Отчёт; завтра; 25:00',
    'задача Отчёт; завтра; 10:00; задача Звонок; завтра; 11:00',
  ]) {
    await assert.rejects(() => resilientRequest(text), /Provider unavailable/);
  }
  assert.equal(calls(), 2);
});

test('network failures and incomplete response bodies use the same fallback', async () => {
  for (const fail of [
    () => {
      throw new DOMException('Timed out', 'TimeoutError');
    },
    () => {
      throw new TypeError('Connection reset');
    },
    () => ({
      ok: true,
      json: async () => {
        throw new TypeError('Body disconnected');
      },
    }),
  ]) {
    globalThis.fetch = async (_url, options) =>
      !options.method ? Response.json({ configured: true, model: 'test-model' }) : fail();
    const result = await resilientRequest('Напомни завтра в 8 позвонить Анне');
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].time, '08:00');
  }
});

test('calendar clarifications and confirmations finish locally without waiting on any API', async () => {
  globalThis.fetch = async () => assert.fail('A local clarification reached the network');
  const pending = { intent: 'create_meeting', fields: { title: 'С Мариу', time: '21:00' } };
  const result = await resilientRequest('завтро', { pending });
  assert.equal(result.records[0].date, '2026-10-22');
  assert.equal(result.records[0].title, 'С Мариу');
  const title = await resilientRequest('Отчёт', {
    pending: { intent: 'create_task', fields: { date: '2026-10-22', time: '10:15' } },
  });
  assert.equal(title.records[0].title, 'Отчёт');
  const comment = await resilientRequest(
    'Новый комментарий',
    {
      pending: { intent: 'update_event', id: result.records[0].id, answer: 'comment' },
    },
    result.records,
  );
  assert.equal(comment.records[0].comment, 'Новый комментарий');
  const cancelled = await resilientRequest('нет', { pending });
  assert.equal(cancelled.context.pending, undefined);
  const confirmed = await resilientRequest(
    'да',
    {
      confirmation: {
        command: { intent: 'delete_event' },
        id: title.records[0].id,
        snapshot: JSON.stringify(title.records[0]),
      },
    },
    title.records,
  );
  assert.deepEqual(confirmed.records, []);
});

test('uncertain fallback asks for clarification and preserves the pending request without changing records', async () => {
  const calls = unavailable();
  const records = [{ id: 'unknown', preserve: true }],
    pending = { intent: 'create_meeting', fields: { title: 'Обсуждение' } };
  for (const text of [
    'Перенеси встречу с субботы на воскресенье',
    'Создай встречу завтра в 10 или 11',
    'Создай задачу «Позвонить завтра» сегодня в 10',
    'Создай встречу после пятницы',
    'Создай событие концерт 23 октября в 20:00',
  ]) {
    const result = await resilientRequest(text, { pending }, records);
    assert.equal(result.records, undefined, text);
    assert.deepEqual(result.context.pending, pending, text);
    assert.match(result.reply, /Уточните действие/);
    assert.doesNotMatch(result.reply, /ИИ временно недоступен/);
  }
  assert.equal(calls(), 5);
});

test('fallback retains exact task selection and deletion confirmation safeguards', async () => {
  unavailable();
  const a = {
      id: 'a',
      type: 'task',
      title: 'Отчёт',
      date: '2026-10-21',
      time: '10:15',
      duration: 0,
      atTime: true,
      color: '#123abc',
      description: '',
      important: false,
      completed: false,
    },
    b = { ...a, id: 'b', title: 'Звонок', time: '11:15' };
  const completed = await resilientRequest('Отметь выполненной задачу сегодня в 10:15', {}, [a, b]);
  assert.deepEqual(completed.records, [{ ...a, completed: true }, b]);
  const deletion = await resilientRequest('Удали задачу отчёт', {}, [a, b]);
  assert.equal(deletion.records, undefined);
  assert.equal(deletion.context.confirmation.id, a.id);
});

test('configuration errors and invalid model commands stay visible and never silently execute a fallback', async () => {
  unavailable(502, false);
  await assert.rejects(
    () => resilientRequest('Создай встречу завтра в 10 или 11'),
    /Provider unavailable/,
  );
  globalThis.fetch = async (_url, options) =>
    Response.json(
      !options.method ? { configured: true, model: 'test-model' } : { command: { intent: 'eval' } },
    );
  await assert.rejects(
    () => resilientRequest('Создай встречу завтра в 10 или 11'),
    /Недопустимая команда/,
  );
});

test('resilient mode keeps the calendar scope boundary without any network calls', async () => {
  globalThis.fetch = () => assert.fail('Off-topic input reached the network');
  const result = await resilientRequest('Напиши код калькулятора', {
    pending: { intent: 'create_task' },
  });
  assert.equal(result.reply, scopeMessage);
  assert.equal(result.records, undefined);
});
