import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '../.tools/test-build/model.js';
import { interpretLocal } from '../.tools/test-build/localInterpreter.js';
import { executeCommand, processRequest } from '../.tools/test-build/assistantEngine.js';
import { validateCommand, loadChat, restoreContext } from '../.tools/test-build/assistantTypes.js';
import { expandEntries, changeOccurrence } from '../.tools/test-build/recurrence.js';
import { numericParts } from '../.tools/test-build/numericInput.js';

const p = { ...defaults, zone: 'Europe/Moscow', hourStart: 9, hourEnd: 18 };
const now = new Date('2026-10-15T06:00:00Z');
const entry = (patch = {}) => ({
  id: crypto.randomUUID(),
  title: 'Презентация',
  type: 'task',
  date: '2026-10-15',
  time: '10:00',
  duration: 60,
  color: '#123abc',
  important: true,
  description: 'Договор с Иваном',
  completed: false,
  ...patch,
});
function session(initial = []) {
  let records = initial,
    context = {};
  return {
    get records() {
      return records;
    },
    get context() {
      return context;
    },
    run(text, id = crypto.randomUUID()) {
      const command = interpretLocal(text, context, p, now);
      const result = executeCommand(command, records, context, p, id, text, now);
      records = result.records || records;
      context = result.context;
      return result;
    },
  };
}
test('natural task, persistence marker, no fabricated time and technical duplicate', () => {
  const s = session([{ id: 'unknown', future: true }]);
  let r = s.run('Напомни мне завтра в 10 утра позвонить Ивану', 'same');
  assert.equal(s.records[1].title, 'позвонить ивану');
  assert.equal(s.records[1].date, '2026-10-16');
  assert.equal(s.records[1].time, '10:00');
  assert.ok(r.reply.includes('Сохранено'));
  s.run('Напомни мне завтра в 10 утра позвонить Ивану', 'same');
  assert.equal(s.records.length, 2);
  assert.deepEqual(s.records[0], { id: 'unknown', future: true });
  s.run('В пятницу нужно отправить отчёт');
  const e = s.records[2];
  assert.equal(e.date, '2026-10-16');
  assert.equal(e.allDay, true);
  assert.equal(e.title, 'отправить отчет');
});
test('meeting clarification merges time and preserves title/date', () => {
  const s = session();
  assert.match(s.run('Поставь встречу с Иваном завтра').reply, /время/);
  assert.equal(s.records.length, 0);
  s.run('На 15:00');
  assert.equal(s.records[0].time, '15:00');
  assert.equal(s.records[0].date, '2026-10-16');
  assert.equal(s.records[0].title, 'с иваном');
});

test('urgent and important local tasks share priority while negated urgency stays normal', () => {
  for (const word of ['Срочно', 'Важно', 'Дедлайн']) {
    const s = session();
    s.run(`Создай задачу ${word} проверить документы завтра в 10:00`);
    assert.equal(s.records[0].important, true, word);
  }
  for (const word of ['Не срочно', 'Не важно', 'Несрочно', 'Неважно']) {
    const s = session();
    s.run(`Создай задачу ${word} проверить документы завтра в 10:00`);
    assert.equal(s.records[0].important, false, word);
  }
});
test('event creation requires time, preserves clarification and uses its own label/color', () => {
  const s = session();
  assert.match(s.run('Создай событие выставка завтра').reply, /время.*событие/);
  assert.equal(s.records.length, 0);
  const result = s.run('В 15:00');
  const saved = s.records[0];
  assert.equal(saved.type, 'event');
  assert.equal(saved.title, 'выставка');
  assert.equal(saved.date, '2026-10-16');
  assert.equal(saved.time, '15:00');
  assert.equal(saved.allDay, false);
  assert.equal(saved.color, p.eventColor);
  assert.ok(saved.startAt && !saved.endAt);
  assert.equal(saved.atTime, true);
  assert.equal(saved.duration, 0);
  assert.match(result.reply, /Событие «выставка»/);
  assert.doesNotMatch(result.reply, /не выполнено/);
  s.run('Событие концерт завтра в 19:00 на два часа');
  assert.equal(s.records[1].type, 'event');
  assert.equal(s.records[1].title, 'концерт');
  assert.equal(s.records[1].duration, 120);
});
test('event filters and search keep tasks, meetings and events separate', () => {
  const event = entry({ type: 'event', title: 'Выставка' });
  const s = session([
    entry({ title: 'Подготовить выставку' }),
    entry({ type: 'meeting', title: 'Обсудить выставку' }),
    event,
  ]);
  assert.deepEqual(
    s.run('Какие события сегодня?').entries.map((e) => e.id),
    [event.id],
  );
  assert.deepEqual(
    s.run('Найди событие про выставку').entries.map((e) => e.id),
    [event.id],
  );
  assert.equal(s.run('Какие встречи сегодня?').entries[0].type, 'meeting');
  assert.equal(s.run('Какие задачи сегодня?').entries[0].type, 'task');
});
test('event completion and reopening are rejected without modifying records', () => {
  const event = entry({ type: 'event', title: 'Выставка' });
  const s = session([event]);
  assert.match(s.run('Я закончила событие выставка').reply, /только для задач/);
  assert.match(s.run('Верни событие в невыполненные').reply, /только для задач/);
  assert.deepEqual(s.records, [event]);
  for (const intent of ['complete_task', 'reopen_task']) {
    const result = executeCommand({ intent, id: event.id }, [event], {}, p, 'status', '', now);
    assert.equal(result.records, undefined);
    assert.match(result.reply, /только для задач/);
  }
});
test('validated event commands require exact time and accept event recurrence', () => {
  assert.equal(validateCommand({ intent: 'create_event', type: 'event' }).type, 'event');
  assert.throws(
    () =>
      executeCommand(
        {
          intent: 'create_event',
          fields: { title: 'Выставка', date: '2026-10-16', time: '10:00', allDay: true },
        },
        [],
        {},
        p,
        'all-day-event',
        '',
        now,
      ),
    /Для события укажите точное время/,
  );
  const result = executeCommand(
    {
      intent: 'create_recurrence',
      type: 'event',
      fields: {
        title: 'Выставка',
        date: '2026-10-16',
        time: '10:00',
        recurrence: { frequency: 'weekly' },
      },
    },
    [],
    {},
    p,
    'recurring-event',
    '',
    now,
  );
  assert.equal(result.records[0].type, 'event');
  assert.equal(result.records[0].recurrence.frequency, 'weekly');
});
test('missing title then date, cancellation and unknown request', () => {
  const s = session();
  s.run('Запланируй встречу завтра');
  assert.equal(s.records.length, 0);
  s.run('С командой');
  s.run('В 14:00');
  assert.equal(s.records.length, 1);
  s.run('Создай задачу подготовить презентацию');
  assert.match(s.run('Отмена').reply, /отменено/);
  assert.equal(s.records.length, 1);
  assert.match(s.run('расскажи анекдот').reply, /только с задачами/);
});
test('schedule today, next week, old search/comments and open second', () => {
  const a = entry(),
    b = entry({ title: 'План', date: '2026-10-20' }),
    c = entry({ date: '2025-01-01', title: 'Архив' }),
    s = session([a, b, c]);
  assert.equal(s.run('Что у меня сегодня?').entries.length, 1);
  assert.equal(s.run('Какие задачи у меня на следующей неделе?').entries[0].id, b.id);
  assert.equal(s.run('Найди задачу про архив').entries[0].id, c.id);
  assert.equal(s.run('Найди задачи по договору').entries.length, 3);
  assert.equal(s.run('Открой вторую').openId, a.id);
});
test('edits use context, preserve unrelated fields, completion/reopen', () => {
  const a = entry(),
    s = session([a, entry({ title: 'Другая задача' })]);
  s.run('Найди задачу про презентацию');
  s.run('А перенеси её на завтра');
  assert.equal(s.records[0].date, '2026-10-16');
  assert.equal(s.records[0].color, a.color);
  assert.equal(s.records[0].description, a.description);
  s.run('Измени время презентации на 14:00');
  assert.equal(s.records[0].time, '14:00');
  s.run('Я закончила презентацию');
  assert.equal(s.records[0].completed, true);
  s.run('Верни задачу в невыполненные');
  assert.equal(s.records[0].completed, false);
});
test('ambiguity requires selection then operation continues', () => {
  const a = entry(),
    b = entry({ date: '2026-10-16' }),
    s = session([a, b]);
  assert.match(s.run('Перенеси презентацию на завтра').reply, /несколько/);
  assert.equal(s.records[0].date, a.date);
  s.run('Вторую');
  assert.equal(s.records[0].date, a.date);
  assert.equal(s.records[1].date, '2026-10-16');
});
test('comment clarification preserves the selected task and unrelated fields', () => {
  const a = entry(),
    s = session([a, entry({ title: 'Другая' })]);
  assert.match(s.run('Добавь комментарий к задаче про презентацию').reply, /Какой комментарий/);
  s.run('Проверить документы перед звонком');
  assert.equal(s.records[0].comment, 'Проверить документы перед звонком');
  assert.equal(s.records[0].color, a.color);
});
test('delete confirmation cancel, context reset, stale record protection', () => {
  const a = entry({ type: 'meeting', title: 'Встреча с Иваном' }),
    s = session([a]);
  s.run('Удали встречу с Иваном');
  assert.equal(s.records.length, 1);
  s.run('Нет');
  assert.equal(s.records.length, 1);
  s.run('Удали встречу с Иваном');
  s.run('Да');
  assert.equal(s.records.length, 0);
  const t = session([a]);
  t.run('Удали встречу с Иваном');
  t.run('Что у меня сегодня?');
  t.run('Да');
  assert.equal(t.records.length, 1);
  const result = executeCommand(
    { intent: 'delete_event', id: a.id },
    [a],
    {},
    p,
    'a',
    'удали',
    now,
  );
  const changed = { ...a, title: 'Изменено' };
  const confirm = executeCommand(
    { intent: 'confirm_action' },
    [changed],
    result.context,
    p,
    'b',
    'Да',
    now,
  );
  assert.equal(confirm.records, undefined);
  assert.match(confirm.reply, /изменилась/);
});
test('multiday meeting and relative hours in selected zone', () => {
  const s = session();
  s.run('Запланируй встречу с командой завтра с 23:00 до 02:00 следующего дня');
  assert.equal(s.records[0].duration, 180);
  assert.equal(s.records[0].endAt, '2026-10-16T23:00:00.000Z');
  s.run('Через два часа напомни проверить документы');
  assert.equal(s.records[1].time, '11:00');
});
test('recurrence is one rule, weekly days, monthly day skips nonexistent, scopes', () => {
  const s = session();
  s.run('Каждый понедельник в 9:00 планёрка');
  assert.equal(s.records.length, 1);
  assert.equal(s.records[0].recurrence.frequency, 'weekly');
  const list = expandEntries(s.records, '2026-10-01', '2026-11-01', p.zone);
  assert.equal(list.length, 2);
  assert.equal(new Set(list.map((e) => e.id)).size, 2);
  const one = changeOccurrence(s.records, list[0], { title: 'Особая' }, 'one', p.zone);
  assert.equal(one.length, 2);
  assert.equal(
    expandEntries(one, '2026-10-01', '2026-11-01', p.zone).filter((e) => e.title === 'Особая')
      .length,
    1,
  );
  const future = changeOccurrence(s.records, list[1], null, 'future', p.zone);
  assert.equal(expandEntries(future, '2026-10-01', '2026-12-01', p.zone).length, 1);
  const m = entry({ date: '2026-01-31', recurrence: { frequency: 'monthly' } });
  assert.deepEqual(
    expandEntries([m], '2026-01-01', '2026-03-31', p.zone).map((e) => e.date),
    ['2026-01-31', '2026-03-31'],
  );
});
test('recurring chat deletion requires scope then yes', () => {
  const s = session();
  s.run('Напоминай пить воду каждый день в 12');
  s.run('Удали пить воду');
  assert.match(s.run('Только это повторение').reply, /Ответьте/);
  s.run('Да');
  assert.equal(s.records.length, 1);
  assert.equal(s.records[0].recurrence.exceptions.length, 1);
});
test('free time ignores tasks and includes crossing-midnight meeting', () => {
  const s = session([
    entry({ allDay: true }),
    entry({ type: 'meeting', time: '10:00', duration: 120 }),
  ]);
  const r = s.run('Есть ли у меня свободное время сегодня?');
  assert.match(r.reply, /09:00–10:00, 12:00–18:00/);
});
test('free time excludes meetings and events, including events crossing midnight', () => {
  const s = session([
    entry({ allDay: true }),
    entry({ type: 'meeting', time: '10:00', duration: 60 }),
    entry({ type: 'event', title: 'Выставка', time: '12:00', duration: 120 }),
    entry({
      type: 'event',
      title: 'Ночной концерт',
      date: '2026-10-14',
      time: '23:00',
      duration: 660,
    }),
  ]);
  assert.match(s.run('Есть ли у меня свободное время сегодня?').reply, /11:00–12:00, 14:00–18:00/);
});
test('mock model uses same validation, invalid data never runs, API rejection propagates', async () => {
  const mocked = async () => ({
    intent: 'create_task',
    fields: { title: 'Из модели', date: '2026-10-16' },
  });
  assert.equal(
    (await processRequest(mocked, 'Создай задачу завтра', [], {}, p, 'mock', now)).records.length,
    1,
  );
  for (const raw of [
    { intent: 'eval', code: 'bad' },
    { intent: 'update_event', fields: { completed: true } },
    { intent: 'create_task', fields: { date: '2026-02-30' } },
    { intent: 'create_task', fields: { time: '25:00' } },
    { intent: 'create_task', fields: { recurrence: { frequency: 'weekly', weekdays: [] } } },
  ])
    assert.throws(() => validateCommand(raw));
  await assert.rejects(
    () =>
      processRequest(
        async () => {
          throw Error('API unavailable');
        },
        'Создай задачу завтра',
        [],
        {},
        p,
        'mock',
        now,
      ),
    /API unavailable/,
  );
});
test('history bounded and legacy retained, confirmations do not survive reload', () => {
  const e = entry();
  assert.equal(
    loadChat([{ role: 'assistant', text: 'Старая история' }], [])[0].text,
    'Старая история',
  );
  assert.equal(
    loadChat(
      Array.from({ length: 400 }, () => ({ role: 'user', text: 'a' })),
      [],
    ).length,
    300,
  );
  const context = restoreContext(
    { updatedAt: +now, lastId: e.id, confirmation: { id: e.id } },
    [e],
    +now,
  );
  assert.equal(context.lastId, e.id);
  assert.equal(context.confirmation, undefined);
  assert.deepEqual(restoreContext({ updatedAt: +now, lastId: 'missing' }, [], +now), {
    updatedAt: +now,
  });
});

test('recurrence ordinal, end boundaries, past context expiry and date-specific deletion', () => {
  const s = session();
  s.run('В первый понедельник месяца проверять отчёты');
  assert.equal(s.records[0].recurrence.ordinal, 1);
  assert.equal(expandEntries(s.records, '2026-11-01', '2026-11-30', p.zone)[0].date, '2026-11-02');
  const daily = session();
  daily.run('Напоминай пить воду каждый день в 12 до конца месяца');
  assert.equal(daily.records[0].recurrence.until, '2026-10-31');
  assert.equal(daily.records[0].date, '2026-10-15');
  const a = entry({ type: 'meeting', title: 'Созвон с Иваном' }),
    b = entry({ type: 'meeting', title: a.title, date: '2026-10-16' }),
    t = session([a, b]);
  assert.match(t.run('Удали встречу с Иваном завтра').reply, /Ответьте/);
  t.run('Да');
  assert.equal(t.records[0].id, a.id);
  const result = executeCommand(
    { intent: 'update_event', fields: { time: '14:00' } },
    [a],
    { lastId: a.id, updatedAt: +now - 31 * 60000 },
    p,
    'stale',
    'перенеси',
    now,
  );
  assert.equal(result.records, undefined);
});

test('completion selects exact local date and time without requiring a title or changing other data', () => {
  const dates = [
    ['сегодня', '2026-10-15'],
    ['завтра', '2026-10-16'],
    ['послезавтра', '2026-10-17'],
    ['через три дня', '2026-10-18'],
    ['в понедельник', '2026-10-19'],
  ];
  for (const [phrase, date] of dates) {
    const a = entry({ date, time: '10:15', atTime: true, duration: 0, importKey: 'source-key' });
    const others = [
      entry({ date, time: '10:30' }),
      entry({ date, time: '10:15', type: 'meeting' }),
      entry({ date: '2026-10-14', time: '10:15' }),
    ];
    const s = session([a, ...others]);
    const result = s.run(`Отметь выполненным задачу на ${phrase} в 10:15`);
    assert.match(result.reply, /отмечена выполненной/, phrase);
    assert.deepEqual(s.records, [{ ...a, completed: true }, ...others], phrase);
    assert.equal(s.context.lastId, a.id);
    s.run('Помощь');
    s.run('Сними с неё отметку выполнения');
    assert.deepEqual(s.records, [a, ...others], phrase);
  }
});

test('date/time selectors override a previous task and accept model fields as selection only', () => {
  const a = entry({ title: 'Вчерашняя', date: '2026-10-14', time: '10:15' });
  const b = entry({
    time: '10:15',
    startAt: '2026-10-15T07:15:00.000Z',
    endAt: '2026-10-15T08:15:00.000Z',
  });
  const c = entry({ time: '09:00' });
  for (const selector of [
    { start: '2026-10-15', end: '2026-10-15', time: '10:15' },
    { fields: { date: '2026-10-15', time: '10:15' } },
  ]) {
    const result = executeCommand(
      { intent: 'complete_task', id: a.id, ...selector },
      [a, b, c],
      { lastId: a.id },
      p,
      'select',
      '',
      now,
    );
    assert.deepEqual(result.records, [a, { ...b, completed: true }, c]);
  }
  const missing = executeCommand(
    { intent: 'complete_task', start: '2026-10-16', time: '10:15' },
    [a, b],
    { lastId: a.id },
    p,
    'missing',
    '',
    now,
  );
  assert.equal(missing.records, undefined);
  assert.equal(missing.context.lastId, undefined);
  assert.match(missing.reply, /2026-10-16.*10:15/);
});

test('a missing time can be corrected and duplicate times require a numbered choice', () => {
  const a = entry({ time: '10:15', title: 'Первая' });
  const b = entry({ time: '10:15', title: 'Вторая' });
  const s = session([a, b]);
  assert.match(s.run('Отметь выполненной задачу сегодня в 10:45').reply, /Не найдена/);
  assert.deepEqual(s.records, [a, b]);
  assert.match(s.run('В 10:15').reply, /несколько/);
  assert.deepEqual(s.records, [a, b]);
  const context = restoreContext(s.context, s.records, +now);
  assert.deepEqual(context.candidates, [a.id, b.id]);
  const command = interpretLocal('Вторую', context, p, now);
  const result = executeCommand(command, s.records, context, p, 'second', 'Вторую', now);
  assert.deepEqual(result.records, [a, { ...b, completed: true }]);
  assert.equal(result.context.pending, undefined);
});

test('time-only follow-up selects from the displayed day and maintains selection through conversation', () => {
  const a = entry({ time: '10:15' });
  const b = entry({ time: '11:15' });
  const c = entry({ time: '10:15', date: '2026-10-16' });
  const s = session([a, b, c]);
  s.run('Какие задачи сегодня?');
  s.run('Отметь выполненной в 10:15');
  assert.deepEqual(s.records, [{ ...a, completed: true }, b, c]);
  s.run('Помощь');
  s.run('Верни её в невыполненные');
  assert.deepEqual(s.records, [a, b, c]);
});

test('relative days use the selected timezone at midnight and repeated tasks select one occurrence', () => {
  const midnight = new Date('2026-10-14T22:05:00Z');
  assert.equal(
    interpretLocal('Отметь выполненной задачу завтра в 10:15', {}, p, midnight).start,
    '2026-10-16',
  );
  assert.equal(
    interpretLocal(
      'Отметь выполненной задачу завтра в 10:15',
      {},
      { ...p, zone: 'America/New_York' },
      midnight,
    ).start,
    '2026-10-15',
  );
  const base = entry({ date: '2026-10-01', time: '10:15', recurrence: { frequency: 'daily' } });
  const s = session([base]);
  assert.match(s.run('Отметь выполненной задачу завтра в 10:15').reply, /повторение/);
  s.run('Только это повторение');
  const occurrences = expandEntries(s.records, '2026-10-15', '2026-10-17', p.zone).filter(
    (entry) => entry.date >= '2026-10-15',
  );
  assert.deepEqual(
    occurrences
      .map(({ date, completed }) => ({ date, completed }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    [
      { date: '2026-10-15', completed: false },
      { date: '2026-10-16', completed: true },
      { date: '2026-10-17', completed: false },
    ],
  );
});

test('invalid selection times and restored invalid pending commands are rejected', () => {
  for (const time of ['24:00', '10:80', 1015])
    assert.throws(() => validateCommand({ intent: 'complete_task', time }));
  const restored = restoreContext(
    {
      updatedAt: +now,
      pending: { intent: 'eval' },
      candidates: ['a'],
      awaitingScope: { intent: 'eval' },
    },
    [],
    +now,
  );
  assert.deepEqual(restored, { updatedAt: +now });
});

test('a misspelled meeting request merges its date clarification and keeps the supplied name', () => {
  const s = session();
  assert.match(s.run('встрича в 21 с мариу').reply, /На какую дату/);
  assert.equal(s.records.length, 0);
  assert.equal(s.context.pending.intent, 'create_meeting');
  assert.equal(s.context.pending.fields.time, '21:00');
  s.run('завтро');
  const saved = s.records[0];
  assert.equal(saved.type, 'meeting');
  assert.equal(saved.title, 'с мариу');
  assert.equal(saved.date, '2026-10-16');
  assert.equal(saved.time, '21:00');
  assert.equal(saved.duration, 0);
  s.run('Перениси её на послезавтро');
  assert.equal(s.records[0].date, '2026-10-17');
  assert.equal(s.records[0].title, saved.title);
});

function numericSession(initial = [], state = {}) {
  let records = initial,
    context = state,
    calls = 0;
  return {
    get records() {
      return records;
    },
    get context() {
      return context;
    },
    get calls() {
      return calls;
    },
    restore() {
      context = restoreContext(JSON.parse(JSON.stringify(context)), records, +now);
    },
    async run(text) {
      const result = await processRequest(
        (...args) => {
          calls++;
          return interpretLocal(...args);
        },
        text,
        records,
        context,
        p,
        crypto.randomUUID(),
        now,
      );
      records = result.records || records;
      context = result.context;
      return result;
    },
  };
}

test('compact date/time clarification preserves each entry type and never calls AI for the choice', async () => {
  for (const [intent, type] of [
    ['create_task', 'task'],
    ['create_meeting', 'meeting'],
    ['create_event', 'event'],
  ]) {
    for (const choice of ['Дата', 'Время']) {
      const pending = { intent, fields: { title: 'Проект 2310', important: true } };
      const s = numericSession([], { pending, updatedAt: +now });
      const question = await s.run('2310');
      assert.match(question.reply, /это время или дата\?/);
      assert.equal(question.numericChoiceId, s.context.numeric.questionId);
      assert.deepEqual(s.context.pending, pending);
      assert.equal(s.records.length, 0);
      s.restore();
      await s.run(choice);
      assert.equal(s.records.length, 0);
      assert.equal(s.context.numeric.next, choice === 'Дата' ? 'time' : 'date');
      s.restore();
      const titleQuestion = await s.run(choice === 'Дата' ? '2200' : '2410');
      assert.match(titleQuestion.reply, /Как называется/);
      assert.equal(s.context.numeric.next, 'title');
      assert.equal(s.records.length, 0);
      await s.run('Проект 2310');
      assert.equal(s.calls, 0);
      assert.equal(s.records.length, 1);
      const saved = s.records[0];
      assert.equal(saved.type, type);
      assert.equal(saved.title, 'Проект 2310');
      assert.equal(saved.important, true);
      assert.equal(saved.date, choice === 'Дата' ? '2026-10-23' : '2026-10-24');
      assert.equal(saved.time, choice === 'Дата' ? '22:00' : '23:10');
      assert.equal(saved.atTime, true);
      assert.equal(saved.duration, 0);
      assert.equal(saved.endAt, undefined);
      assert.equal(s.context.numeric, undefined);
      assert.equal(s.context.pending, undefined);
    }
  }
});

test('the next ambiguous number uses the unselected kind and invalid values keep the pending choice', async () => {
  const s = numericSession([], {
    pending: { intent: 'create_meeting', fields: { title: 'Обсудить проект' } },
  });
  await s.run('2310');
  await s.run('Это дата');
  await s.run('2410');
  assert.equal(s.records.length, 0);
  assert.equal(s.context.numeric.next, 'time');
  assert.match((await s.run('2400')).reply, /не является временем/);
  await s.run('1110');
  await s.run('Обсудить проект');
  assert.equal(s.records[0].date, '2026-10-23');
  assert.equal(s.records[0].time, '11:10');

  const reverse = numericSession([], {
    pending: { intent: 'create_event', fields: { title: 'Концерт' } },
  });
  await reverse.run('2310');
  await reverse.run('время');
  assert.match((await reverse.run('2200')).reply, /не является датой/);
  assert.match((await reverse.run('3102')).reply, /не является датой/);
  assert.equal(reverse.records.length, 0);
  await reverse.run('1110');
  await reverse.run('Концерт');
  assert.equal(reverse.records[0].date, '2026-10-11');
  assert.equal(reverse.records[0].time, '23:10');

  const formatted = numericSession([], {
    pending: { intent: 'create_meeting', fields: { title: 'Планёрка' } },
  });
  await formatted.run('2310');
  await formatted.run('Время');
  await formatted.run('23.10');
  await formatted.run('Планёрка');
  assert.equal(formatted.records[0].date, '2026-10-23');
  assert.equal(formatted.records[0].time, '23:10');
});

test('a compact creation asks for the complementary value even when the old draft already contained it', async () => {
  const s = numericSession([], {
    pending: { intent: 'create_meeting', fields: { title: 'С Мариу', time: '21:00' } },
  });
  await s.run('2310');
  assert.equal((await s.run('Дата')).reply, 'На какое время?');
  assert.equal(s.records.length, 0);
  assert.equal(s.context.pending.fields.time, undefined);
  assert.equal((await s.run('2200')).reply, 'Как называется встреча?');
  assert.equal(s.records.length, 0);
  await s.run('С Мариу');
  assert.equal(s.records.length, 1);
  assert.equal(s.records[0].time, '22:00');
  assert.equal(s.records[0].date, '2026-10-23');
  assert.equal(s.records[0].duration, 0);
});

test('compact selectors complete the requested task only after both values are supplied', async () => {
  const a = entry({ date: '2026-10-23', time: '22:00' }),
    b = entry({ date: '2026-10-23', time: '23:00' });
  const s = numericSession([a, b], { pending: { intent: 'complete_task' } });
  await s.run('2310');
  await s.run('Дата');
  assert.deepEqual(s.records, [a, b]);
  await s.run('2200');
  assert.deepEqual(s.records, [{ ...a, completed: true }, b]);
});

test('ordinary clarifications, cancellation, fresh commands and literal comments do not retain numeric choices', async () => {
  const s = numericSession([], { pending: { intent: 'create_task', fields: { title: 'Звонок' } } });
  await s.run('2310');
  await s.run('Дата');
  await s.run('помощь');
  assert.equal(s.context.numeric.next, 'time');
  await s.run('без времени');
  assert.equal(s.records.length, 0);
  await s.run('Звонок');
  assert.equal(s.records[0].allDay, true);
  assert.equal(s.context.numeric, undefined);

  await s.run('1110');
  await s.run('отмена');
  assert.equal(s.context.numeric, undefined);
  await s.run('2310');
  await s.run('Создай задачу отчёт завтра в 10');
  assert.equal(s.context.numeric, undefined);
  assert.equal(s.records.length, 2);

  const e = entry();
  const comment = numericSession([e], {
    pending: { intent: 'update_event', id: e.id, answer: 'comment' },
  });
  await comment.run('2310');
  assert.equal(comment.records[0].comment, '2310');
  assert.equal(comment.context.numeric, undefined);
});

test('numeric chat choices survive reload, reject malformed state and respect the calendar timezone', async () => {
  const s = numericSession();
  const question = await s.run('0102');
  const message = {
    role: 'assistant',
    text: question.reply,
    numericChoiceId: question.numericChoiceId,
  };
  assert.deepEqual(loadChat([message], []), [message]);
  s.restore();
  await s.run('Дата');
  await s.run('2200');
  await s.run('Звонок');
  assert.equal(s.records[0].date, '2026-02-01');
  assert.equal(s.records[0].time, '22:00');
  assert.deepEqual(restoreContext({ updatedAt: +now, numeric: { next: 'title' } }, [], +now), {
    updatedAt: +now,
  });
  assert.deepEqual(
    restoreContext({ updatedAt: +now, numeric: { value: '<script>', questionId: 'a' } }, [], +now),
    { updatedAt: +now },
  );
  assert.deepEqual(restoreContext(s.context, s.records, +now + 31 * 60000), {});
  const questionAtMidnight = await processRequest(
    interpretLocal,
    '0101',
    [],
    {},
    p,
    'year',
    new Date('2026-12-31T22:00:00Z'),
  );
  const selected = await processRequest(
    interpretLocal,
    'Дата',
    [],
    questionAtMidnight.context,
    p,
    'date',
    new Date('2026-12-31T22:00:00Z'),
  );
  assert.equal(selected.context.pending.fields.date, '2027-01-01');
});

test('every numeric input asks for date or time before interpreting it, including values with only one valid meaning', async () => {
  for (const value of [
    '0',
    '1',
    '7',
    '12',
    '23',
    '24',
    '31',
    '59',
    '99',
    '100',
    '101',
    '709',
    '930',
    '1230',
    '1530',
    '1708',
    '2359',
    '2400',
    '9999',
    '150827',
    '15082027',
    '123456789',
    '7:45',
    '15.08',
    '15.08.2027',
    '2027-08-15',
    '１２３０',
  ]) {
    const pending = { intent: 'create_meeting', fields: { title: 'Проверка' } };
    const s = numericSession([], { pending, updatedAt: +now });
    const question = await s.run(value);
    assert.match(question.reply, /это время или дата\?/, value);
    assert.equal(question.numericChoiceId, s.context.numeric.questionId);
    assert.equal(s.context.numeric.value, value);
    assert.deepEqual(s.context.pending, pending);
    assert.equal(s.records.length, 0);
    assert.equal(s.calls, 0);
    s.restore();
    assert.equal(s.context.numeric.value, value);
  }
});

test('numeric pairing accepts hours, minutes, day numbers and explicit years in both orders', async () => {
  for (const [value, choice, other, date, time] of [
    ['1508', 'Дата', '930', '2026-08-15', '09:30'],
    ['7', 'Дата', '8', '2026-10-07', '08:00'],
    ['5', 'Время', '25', '2026-10-25', '05:00'],
    ['1230', 'Время', '0411', '2026-11-04', '12:30'],
    ['1700', 'Время', '1508', '2026-08-15', '17:00'],
    ['2309', 'Дата', '7:45', '2026-09-23', '07:45'],
    ['150827', 'Дата', '15', '2027-08-15', '15:00'],
    ['15.08.2027', 'Дата', '0805', '2027-08-15', '08:05'],
    ['2027-08-15', 'Дата', '15:30', '2027-08-15', '15:30'],
    ['0000', 'Время', '0101', '2026-01-01', '00:00'],
  ]) {
    const s = numericSession([], {
      pending: { intent: 'create_task', fields: { title: 'Проверка' } },
    });
    await s.run(value);
    await s.run(choice);
    assert.equal(s.records.length, 0);
    s.restore();
    await s.run(other);
    assert.equal(s.records.length, 0);
    assert.equal(s.context.numeric.next, 'title');
    await s.run('Проверка');
    assert.equal(s.calls, 0);
    assert.equal(s.records.length, 1);
    assert.equal(s.records[0].date, date);
    assert.equal(s.records[0].time, time);
    assert.equal(s.records[0].duration, 0);
    assert.equal(s.records[0].endAt, undefined);
    assert.equal(s.context.numeric, undefined);
  }
});

test('an impossible first choice waits for its correction before requesting the complementary value', async () => {
  for (const [value, choice, correction, other] of [
    ['2200', 'Дата', '1508', '930'],
    ['9999', 'Время', '930', '1508'],
  ]) {
    const s = numericSession([], {
      pending: { intent: 'create_meeting', fields: { title: 'Проверка' } },
    });
    await s.run(value);
    const invalid = await s.run(choice);
    assert.match(invalid.reply, /не является/);
    assert.equal(s.records.length, 0);
    assert.equal(s.context.numeric.first, true);
    s.restore();
    await s.run(correction);
    assert.equal(s.records.length, 0);
    assert.equal(s.context.numeric.next, choice === 'Дата' ? 'time' : 'date');
    assert.equal(s.context.numeric.first, undefined);
    await s.run(other);
    assert.equal(s.records.length, 0);
    await s.run('Проверка');
    assert.equal(s.records[0].date, '2026-08-15');
    assert.equal(s.records[0].time, '09:30');
    assert.equal(s.calls, 0);
  }
});

test('all 1440 valid minute values and every calendar day use the same general numeric parser', () => {
  for (let hour = 0; hour < 24; hour++)
    for (let minute = 0; minute < 60; minute++) {
      const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      assert.equal(numericParts(time.replace(':', ''), '2026-10-15').time, time);
    }
  for (let month = 1; month <= 12; month++)
    for (let day = 1; day <= new Date(2026, month, 0).getDate(); day++) {
      const dd = String(day).padStart(2, '0'),
        mm = String(month).padStart(2, '0');
      assert.equal(numericParts(`${dd}${mm}`, '2026-10-15').date, `2026-${mm}-${dd}`);
    }
  assert.equal(numericParts('2902', '2026-10-15').date, undefined);
  assert.equal(numericParts('2902', '2028-10-15').date, '2028-02-29');
  assert.equal(numericParts('3104', '2026-10-15').date, undefined);
  assert.equal(numericParts('2460', '2026-10-15').time, undefined);
});

test('numbered record selection still takes precedence over date/time clarification', async () => {
  const a = entry({ title: 'Отчёт' }),
    b = entry({ title: 'Звонок' });
  const s = numericSession([a, b], {
    pending: { intent: 'complete_task' },
    candidates: [a.id, b.id],
    resultIds: [a.id, b.id],
  });
  const result = await s.run('2');
  assert.equal(result.numericChoiceId, undefined);
  assert.deepEqual(s.records, [a, { ...b, completed: true }]);
});

test('the old availability prefix is removed from assistant history while user text is preserved', () => {
  const text = 'ИИ временно недоступен. Уточните действие, название, дату и время записи.';
  assert.deepEqual(
    loadChat(
      [
        { role: 'assistant', text },
        { role: 'user', text },
      ],
      [],
    ),
    [
      { role: 'assistant', text: 'Уточните действие, название, дату и время записи.' },
      { role: 'user', text },
    ],
  );
});

test('numeric task creation always asks for the other field and then the title before saving', async () => {
  for (const [choice, other, question, date, time] of [
    ['Время', '2310', 'На какую дату?', '2026-10-23', '14:10'],
    ['Дата', '2200', 'На какое время?', '2026-10-14', '22:00'],
  ]) {
    for (const state of [
      {},
      {
        pending: {
          intent: 'create_task',
          fields: { title: 'Прежнее название', date: '2026-01-01', time: '09:00', allDay: true },
        },
      },
    ]) {
      const s = numericSession([], state);
      await s.run('1410');
      assert.equal((await s.run(choice)).reply, question);
      assert.equal(s.records.length, 0);
      s.restore();
      assert.equal((await s.run(other)).reply, 'Как называется задача?');
      assert.equal(s.records.length, 0);
      s.restore();
      assert.equal(s.context.numeric.next, 'title');
      await s.run('Отчёт завтра в 10:15');
      assert.equal(s.records.length, 1);
      assert.equal(s.records[0].title, 'Отчёт завтра в 10:15');
      assert.equal(s.records[0].date, date);
      assert.equal(s.records[0].time, time);
      assert.equal(s.records[0].duration, 0);
      assert.equal(s.context.numeric, undefined);
      assert.equal(s.calls, 0);
    }
  }
});

test('relative answers fill the requested field without overwriting the first choice or skipping the title', async () => {
  const s = numericSession();
  await s.run('1410');
  await s.run('Время');
  assert.equal((await s.run('в 15:00')).reply, 'На какую дату?');
  assert.equal(s.context.pending.fields.time, '14:10');
  assert.equal((await s.run('завтро')).reply, 'Как называется задача?');
  assert.equal(s.records.length, 0);
  await s.run('2026');
  assert.equal(s.records[0].title, '2026');
  assert.equal(s.records[0].date, '2026-10-16');
  assert.equal(s.records[0].time, '14:10');

  const reverse = numericSession();
  await reverse.run('1410');
  await reverse.run('Дата');
  assert.equal((await reverse.run('завтра')).reply, 'На какое время?');
  assert.equal(reverse.context.pending.fields.date, '2026-10-14');
  assert.equal((await reverse.run('в 22')).reply, 'Как называется задача?');
  assert.equal(reverse.records.length, 0);
  await reverse.run('Звонок');
  assert.equal(reverse.records[0].date, '2026-10-14');
  assert.equal(reverse.records[0].time, '22:00');
});

test('a new numeric draft leaves the previously selected record intact and can be cancelled at the title step', async () => {
  const old = entry({ title: 'Прежняя задача' });
  const s = numericSession([old], { lastId: old.id });
  await s.run('1410');
  assert.equal((await s.run('Время')).reply, 'На какую дату?');
  assert.equal((await s.run('2310')).reply, 'Как называется задача?');
  assert.deepEqual(s.records, [old]);
  await s.run('помощь');
  assert.equal(s.context.numeric.next, 'title');
  await s.run('отмена');
  assert.deepEqual(s.records, [old]);
  assert.equal(s.context.pending, undefined);
  assert.equal(s.context.numeric, undefined);
});

test('an explicit rescheduling request keeps updating the selected record without starting task creation', async () => {
  const old = entry({ title: 'Отчёт' });
  const s = numericSession([old], {
    pending: { intent: 'update_event', id: old.id, fields: { date: '2026-10-20' } },
  });
  await s.run('1410');
  await s.run('Время');
  assert.equal(s.records.length, 1);
  assert.equal(s.records[0].id, old.id);
  assert.equal(s.records[0].time, '14:10');
  await s.run('2310');
  assert.equal(s.records.length, 1);
  assert.equal(s.records[0].date, '2026-10-23');
  assert.equal(s.records[0].time, '14:10');
  assert.equal(s.records[0].title, old.title);
});
