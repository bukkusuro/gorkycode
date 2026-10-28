import test from 'node:test';
import assert from 'node:assert/strict';
import { proposePlan, applyPlan } from '../.tools/test-build/planning/plan.js';
import { productivity, trackCompletion } from '../.tools/test-build/planning/analytics.js';
import {
  planningRequest,
  guardCalendarRequest,
  scopeMessage,
} from '../.tools/test-build/assistantPolicy.js';
import { validateCommand } from '../.tools/test-build/assistantTypes.js';
import { executeCommand, processRequest } from '../.tools/test-build/assistantEngine.js';
import { interpretAssistant } from '../.tools/test-build/aiInterpreter.js';
import { defaults, toInstant, wallParts } from '../.tools/test-build/model.js';
import { validEntry } from '../.tools/test-build/calendar.js';
import { expandEntries } from '../.tools/test-build/recurrence.js';
const prefs = { ...defaults, zone: 'Europe/Moscow' };
const now = new Date('2026-10-28T05:00:00Z'); // 08:00 Moscow, Wednesday
const task = (id, patch = {}) => ({
  id,
  title: id,
  type: 'task',
  date: '2026-10-28',
  time: '12:00',
  duration: 30,
  color: '#ddd8f5',
  important: false,
  description: '',
  completed: false,
  ...patch,
});
const batch = (items) =>
  validateCommand({
    intent: 'create_batch',
    items: items.map((fields) => ({ type: 'task', fields })),
  });
const overlaps = (a, b) =>
  a.date === b.date &&
  a.time < wallParts(b.endAt, prefs.zone).time &&
  b.time < wallParts(a.endAt, prefs.zone).time;

test('free-form planning and reports are in calendar scope; titles and unsafe clauses retain their previous meaning', () => {
  for (const [text, intent] of [
    [
      'ВОКСА, я сегодня ничего не успеваю. Перестрой мой день так, чтобы я закончил самое важное',
      'plan_day',
    ],
    [
      'Мне завтра нужно закончить презентацию, в пятницу сдать проект, ещё надо сходить за продуктами, позвонить маме и подготовиться к экзамену',
      'create_batch',
    ],
    ['Покажи недельный отчёт по выполнению задач', 'productivity_report'],
  ]) {
    assert.equal(planningRequest(text), intent);
    assert.equal(guardCalendarRequest(text), undefined);
  }
  assert.equal(planningRequest('Отчёт'), undefined);
  assert.equal(planningRequest('задача Отчёт; завтра; 25:00'), undefined);
  assert.equal(
    planningRequest('встреча План на завтра и отчёт 2027; сегодня; 10:00; 30; важно'),
    undefined,
  );
  assert.equal(
    guardCalendarRequest('Перестрой мой день и напиши код калькулятора').answer,
    scopeMessage,
  );
});

test('batch model output has bounded validated creation fields and cannot embed destructive commands', () => {
  for (const command of [
    { intent: 'create_batch', items: [] },
    {
      intent: 'create_batch',
      items: Array.from({ length: 21 }, () => ({ type: 'task', fields: { title: 'x' } })),
    },
    { intent: 'create_batch', items: [{ type: 'delete_event', fields: { title: 'x' } }] },
    {
      intent: 'create_batch',
      items: [{ type: 'task', fields: { title: 'x', date: '2026-02-30' } }],
    },
    {
      intent: 'create_batch',
      items: [{ type: 'task', fields: { title: 'x', deadline: '2026-02-30' } }],
    },
    { intent: 'create_batch', items: [{ type: 'task', fields: { title: 'x', completed: true } }] },
    { intent: 'create_task', priorities: ['x'] },
  ])
    assert.throws(() => validateCommand(command));
});

test('brain dump previews five independent records, suggests missing dates, and commits only on confirmation', async () => {
  const records = [
    task('meeting', { type: 'meeting', time: '09:00', duration: 60 }),
    { unknown: true },
  ];
  const snapshot = structuredClone(records);
  const command = batch([
    { title: 'Закончить презентацию', date: '2026-10-29', deadline: '2026-10-29' },
    { title: 'Сдать проект', date: '2026-10-30', deadline: '2026-10-30', important: true },
    { title: 'Сходить за продуктами' },
    { title: 'Позвонить маме' },
    { title: 'Подготовиться к экзамену' },
  ]);
  const result = await processRequest(
    () => command,
    'Мне нужно закончить презентацию и позвонить маме',
    records,
    {},
    prefs,
    'brain',
    now,
  );
  assert.equal(result.records, undefined);
  assert.equal(result.proposal.rows.length, 5);
  assert.deepEqual(records, snapshot);
  assert.equal(result.proposal.rows[0].after.date, '2026-10-29');
  assert.equal(result.proposal.rows[1].after.deadline, '2026-10-30');
  const suggested = result.proposal.rows.slice(2);
  assert.ok(
    suggested.every(
      (row) => row.after.date === '2026-10-28' && row.after.time >= '10:00' && row.suggested,
    ),
  );
  const applied = applyPlan(result.proposal, records, prefs, now);
  assert.equal(applied.length, 7);
  assert.deepEqual(applied.slice(0, 2), records);
  assert.ok(applied.slice(2).every(validEntry));
  for (const a of suggested)
    for (const b of suggested) if (a !== b) assert.equal(overlaps(a.after, b.after), false);
  assert.throws(() => applyPlan(result.proposal, applied, prefs, now), /изменились/);
});

test('explicit meetings reserve time before tasks without time, including multi-day busy intervals', () => {
  const records = [
    task('overnight', { type: 'event', date: '2026-10-27', time: '23:00', duration: 660 }),
  ];
  const command = validateCommand({
    intent: 'create_batch',
    items: [
      { type: 'task', fields: { title: 'Flexible' } },
      {
        type: 'meeting',
        fields: { title: 'Fixed', date: '2026-10-28', time: '10:00', duration: 60 },
      },
    ],
  });
  const proposal = proposePlan(command, records, prefs, 'explicit', now);
  assert.equal(proposal.rows[0].after.time, '11:00');
  assert.equal(proposal.rows[1].after.time, '10:00');
  assert.throws(
    () =>
      proposePlan(
        batch([{ title: 'Conflict', date: '2026-10-28', time: '09:30' }]),
        records,
        prefs,
        'bad',
        now,
      ),
    /пересекается/,
  );
});

test('invalid or incomplete batches have no partial writes or invented meeting times', () => {
  const records = [task('fixed', { type: 'meeting', time: '09:00', duration: 540 })];
  for (const command of [
    batch([{ title: 'Fits' }, { title: 'Expired', date: '2026-10-27' }]),
    batch([{ title: 'Deadline', date: '2026-10-29', deadline: '2026-10-28' }]),
    batch([{ title: 'No slot', date: '2026-10-28', duration: 600 }]),
    validateCommand({
      intent: 'create_batch',
      items: [{ type: 'meeting', fields: { title: 'Who', date: '2026-10-29' } }],
    }),
  ]) {
    const copy = structuredClone(records);
    assert.throws(() => proposePlan(command, records, prefs, 'invalid', now));
    assert.deepEqual(records, copy);
  }
});

test('replanning prioritizes important tasks and keeps meetings, completed and other-day tasks fixed', () => {
  const records = [
    task('meeting', { type: 'meeting', time: '09:00', duration: 60 }),
    task('ordinary', { time: '11:00' }),
    task('important', { time: '15:00', important: true }),
    task('done', { completed: true }),
    task('tomorrow', { date: '2026-10-29' }),
    { unknown: true },
  ];
  const proposal = proposePlan(
    { intent: 'plan_day', priorities: ['ordinary', 'important'] },
    records,
    prefs,
    'day',
    now,
  );
  assert.deepEqual(
    proposal.rows.map((row) => row.after.id),
    ['important', 'ordinary'],
  );
  assert.equal(proposal.rows[0].after.time, '10:00');
  const applied = applyPlan(proposal, records, prefs, now);
  for (const id of ['meeting', 'done', 'tomorrow'])
    assert.deepEqual(
      applied.find((e) => e.id === id),
      records.find((e) => e.id === id),
    );
  assert.deepEqual(applied.at(-1), { unknown: true });
  assert.throws(
    () => proposePlan({ intent: 'plan_day', priorities: ['tomorrow'] }, records, prefs, 'bad', now),
    /пределами/,
  );
});

test('overflow moves to the next day while explicit deadlines and retained intervals remain protected', () => {
  const records = [
    task('large', { duration: 90, time: '09:00' }),
    task('small', { duration: 30, time: '10:30' }),
    task('deadline', { duration: 60, time: '09:30', deadline: '2026-10-28' }),
  ];
  const p = { ...prefs, hourStart: 9, hourEnd: 10 };
  const proposal = proposePlan({ intent: 'plan_day' }, records, p, 'overflow', now);
  assert.ok(proposal.warnings.some((text) => text.includes('large')));
  assert.ok(proposal.warnings.some((text) => text.includes('deadline')));
  assert.equal(proposal.rows.length, 1);
  assert.equal(proposal.rows[0].after.date, '2026-10-29');
  assert.deepEqual(records.find((e) => e.id === 'deadline').time, '09:30');
});

test('recurring tasks detach just the selected occurrence and keep future occurrences unchanged', () => {
  const records = [task('daily', { time: '15:00', recurrence: { frequency: 'daily' } })];
  const proposal = proposePlan({ intent: 'plan_day' }, records, prefs, 'recurring', now);
  const applied = applyPlan(proposal, records, prefs, now);
  assert.equal(applied.length, 2);
  assert.deepEqual(applied[0].recurrence.exceptions, ['2026-10-28']);
  assert.equal(applied[1].recurrence, undefined);
  assert.equal(applied[1].time, '09:00');
  assert.equal(
    expandEntries(applied.filter(validEntry), '2026-10-29', '2026-10-29', prefs.zone).find(
      (e) => e.occurrenceDate === '2026-10-29',
    ).time,
    '15:00',
  );
});

test('stale calendars, changed settings, time passing and expired proposals cannot apply', () => {
  const records = [task('one')];
  const proposal = proposePlan({ intent: 'plan_day' }, records, prefs, 'stale', now);
  assert.throws(() => applyPlan(proposal, [...records, task('new')], prefs, now), /изменились/);
  assert.throws(() => applyPlan(proposal, records, { ...prefs, zone: 'UTC' }, now), /настройки/);
  assert.throws(() => applyPlan(proposal, records, prefs, new Date(+now + 31 * 60_000)), /устарел/);
  assert.throws(
    () => applyPlan(proposal, records, prefs, new Date('2026-10-28T06:01:00Z')),
    /устарел|прошло/,
  );
});

test('completion time is recorded once, follows reopening, and uses actual zoned completion days', () => {
  const original = [task('a', { date: '2026-10-26' })];
  const completed = trackCompletion(
    original,
    [{ ...original[0], completed: true }],
    new Date('2026-10-27T21:30:00Z'),
  );
  assert.equal(completed[0].completedAt, '2026-10-27T21:30:00.000Z');
  const edited = trackCompletion(completed, [{ ...completed[0], title: 'new' }], now);
  assert.equal(edited[0].completedAt, completed[0].completedAt);
  const report = productivity(edited, prefs.zone, now);
  assert.equal(report.days.find((d) => d.label === 'Среда').completed, 1);
  assert.equal(report.days.find((d) => d.label === 'Понедельник').completed, 0);
  const reopened = trackCompletion(edited, [{ ...edited[0], completed: false }], now);
  assert.equal(reopened[0].completedAt, undefined);
  assert.equal(productivity(reopened, prefs.zone, now).datedCompletions, 0);
});

test('reports exclude untouched imported sample data and do not invent historical completion dates', () => {
  const report = productivity(
    [
      task('old', { completed: true }),
      task('demo', { completed: true, importKey: 'bundled' }),
      task('future', { date: '2026-12-31' }),
    ],
    prefs.zone,
    now,
  );
  assert.equal(report.week.total, 1);
  assert.equal(report.week.done, 1);
  assert.equal(report.week.percent, 100);
  assert.equal(report.datedCompletions, 0);
  assert.equal(report.undated, 1);
  assert.equal(report.excluded, 1);
  assert.ok(report.recommendations[0].includes('мало данных'));
  assert.equal(productivity([], prefs.zone, now).week.percent, null);
});

test('reports and deadline fields work through the assistant without an AI connection', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = () => assert.fail('Analytics should be local');
    const cmd = await interpretAssistant(
      'Покажи недельный отчёт по выполнению задач',
      {},
      prefs,
      now,
      [],
      [],
      'c',
      'r',
    );
    const result = executeCommand(cmd, [task('one')], {}, prefs, 'report', 'отчёт', now);
    assert.match(result.reply, /0 из 1/);
    assert.equal(result.records, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test('AI receives durations and deadlines; batch handling cannot fall back to a single immediate create', async () => {
  const original = globalThis.fetch;
  try {
    let posted = 0;
    globalThis.fetch = async (_url, options = {}) => {
      if (!options.method) return Response.json({ configured: true, model: 'test' });
      posted++;
      const body = JSON.parse(options.body);
      assert.equal(body.calendar.start, '2026-10-28');
      assert.equal(body.entries[0].duration, 30);
      assert.equal(body.entries[0].deadline, '2026-10-29');
      return Response.json({ command: { intent: 'plan_day', priorities: ['one'] } });
    };
    const cmd = await interpretAssistant(
      'Перестрой мой день',
      {},
      prefs,
      now,
      [],
      [task('one', { deadline: '2026-10-29' })],
      'c',
      'r',
    );
    assert.equal(cmd.intent, 'plan_day');
    assert.equal(posted, 1);
    globalThis.fetch = async (_url, options = {}) =>
      !options.method
        ? Response.json({ configured: true, model: 'test' })
        : Response.json({
            command: { intent: 'create_task', fields: { title: 'Merged', date: '2026-10-29' } },
          });
    await assert.rejects(
      () =>
        interpretAssistant(
          'Мне нужно купить продукты и позвонить маме',
          {},
          prefs,
          now,
          [],
          [],
          'c',
          'r2',
        ),
      /не составил план/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('planned future timestamps and deadlines stay consistent in another timezone', () => {
  const p = { ...prefs, zone: 'Pacific/Honolulu' };
  const proposal = proposePlan(
    batch([{ title: 'Zoned', date: '2026-10-28', time: '09:00', deadline: '2026-10-28' }]),
    [],
    p,
    'zone',
    now,
  );
  assert.equal(proposal.rows[0].after.startAt, toInstant('2026-10-28', '09:00', p.zone));
  assert.ok(Date.parse(proposal.rows[0].after.startAt) > +now);
});

test('replanning accepts any selected future day beyond two weeks and changes only that day', () => {
  const records = [
    task('today'),
    task('future', { date: '2027-06-14', time: '15:00' }),
    task('meeting-future', { date: '2027-06-14', time: '09:00', type: 'meeting', duration: 60 }),
  ];
  const proposal = proposePlan(
    { intent: 'plan_day', start: '2027-06-14', priorities: ['future'] },
    records,
    prefs,
    'selected',
    now,
  );
  assert.equal(proposal.day, '2027-06-14');
  assert.equal(proposal.rows.length, 1);
  assert.equal(proposal.rows[0].after.time, '10:00');
  const applied = applyPlan(proposal, records, prefs, now);
  assert.deepEqual(applied[0], records[0]);
  assert.deepEqual(applied[2], records[2]);
  assert.throws(
    () => proposePlan({ intent: 'plan_day', start: '2026-10-27' }, records, prefs, 'past', now),
    /будущий/,
  );
});

test('AI must respect an explicitly selected date; missing dates are filled from the request', async () => {
  const original = globalThis.fetch;
  try {
    for (const start of [undefined, '2026-10-28']) {
      globalThis.fetch = async (_url, options = {}) => {
        if (!options.method) return Response.json({ configured: true, model: 'test' });
        const body = JSON.parse(options.body);
        assert.equal(body.calendar.start, '2027-06-14');
        assert.equal(body.entries[0].id, 'future');
        return Response.json({ command: { intent: 'plan_day', ...(start ? { start } : {}) } });
      };
      const call = () =>
        interpretAssistant(
          'Перестрой расписание на 2027-06-14',
          {},
          prefs,
          now,
          [],
          [task('future', { date: '2027-06-14' })],
          'future',
          'future',
        );
      if (start) await assert.rejects(call, /другую дату/);
      else assert.equal((await call()).start, '2027-06-14');
    }
  } finally {
    globalThis.fetch = original;
  }
});
