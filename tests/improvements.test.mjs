import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaults } from '../.tools/test-build/model.js';
import { reminderPlan } from '../.tools/test-build/reminders/plan.js';
import { createBackup, parseBackup } from '../.tools/test-build/storage/backup.js';
import { editDraft, restoreStep } from '../.tools/test-build/chat/draft.js';
import { undoPreferences } from '../.tools/test-build/storage/history.js';
import { interpretAssistant, interpretAI } from '../.tools/test-build/aiInterpreter.js';
import { processRequest } from '../.tools/test-build/assistantEngine.js';
import { interpretLocal } from '../.tools/test-build/localInterpreter.js';
import { createReminderMiddleware, prepareReminders, reminderXml } from '../server/reminders.mjs';
const now = Date.parse('2026-10-23T07:00:00Z');
const prefs = { ...defaults, zone: 'Europe/Moscow', background: true };
const entry = {
  id: 'qa',
  type: 'task',
  title: 'Отчёт',
  date: '2026-10-23',
  time: '10:20',
  atTime: true,
  duration: 0,
  color: '#123abc',
  important: false,
  description: '',
  completed: false,
};
test('background plan uses exact timezone instants, category flags, completion and history', () => {
  const plan = reminderPlan([entry], prefs, now);
  assert.equal(plan[0].at, now + 5 * 60000);
  assert.equal(plan[0].entryId, 'qa');
  for (const p of [
    { ...prefs, enabled: false },
    { ...prefs, background: false },
    { ...prefs, tasks: false, important: false },
  ])
    assert.deepEqual(reminderPlan([entry], p, now), []);
  assert.deepEqual(
    reminderPlan(
      [
        { ...entry, completed: true },
        { ...entry, id: 'old', importedAt: '2026-10-24T00:00:00Z' },
      ],
      prefs,
      now,
    ),
    [],
  );
  assert.equal(
    reminderPlan([{ ...entry, important: true }], { ...prefs, tasks: false }, now).length,
    1,
  );
  assert.equal(reminderPlan([{ ...entry, allDay: true }], prefs, now).length, 0);
});
test('recurrences expand into future reminders and daily reviews respect the selected zone', () => {
  const plan = reminderPlan(
    [
      {
        ...entry,
        recurrence: { frequency: 'daily', until: '2026-10-25', exceptions: ['2026-10-24'] },
      },
    ],
    prefs,
    now,
  );
  assert.deepEqual(
    plan.map((p) => p.entryId),
    ['qa@2026-10-23', 'qa@2026-10-25'],
  );
  const daily = reminderPlan([], { ...prefs, daily: true }, now);
  assert.equal(daily[0].at, Date.parse('2026-10-24T06:00:00Z'));
  assert.ok(daily.length <= 366);
});
test('native payload escapes calendar text and deduplication survives a tab reopening', () => {
  const item = {
    key: 'a',
    title: '<b> & "x"',
    body: '<script>',
    at: now - 1000,
    expires: now + 60000,
    sound: false,
    entryId: 'qa@2026-10-23',
  };
  assert.match(reminderXml(item), /&lt;b&gt; &amp; &quot;x&quot;/);
  assert.doesNotMatch(reminderXml(item), /<script>/);
  const first = prepareReminders([item], {}, now);
  assert.equal(first.items[0].at, now + 3000);
  assert.deepEqual(prepareReminders([item], first.ledger, now + 4000).items, []);
  assert.equal(prepareReminders([item], first.ledger, now + 1000).items[0].at, now + 3000);
});
test('reminder API isolates owners, validates input, serializes native work and preserves failed deliveries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voksa-reminder-unit-'));
  let calls = [],
    active = 0,
    maxActive = 0,
    fail = false;
  const middleware = createReminderMiddleware({
    root,
    platform: 'win32',
    now: () => now,
    execute: async (command, request) => {
      active++;
      maxActive = Math.max(maxActive, active);
      calls.push({ command, ...request });
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (fail) throw Error('native unavailable');
      return { ok: true, scheduled: request.items?.length || 0 };
    },
  });
  const server = createServer((q, s) =>
    middleware(q, s, () => {
      s.writeHead(404).end();
    }),
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/reminders`;
  const post = (owner, items = [], action = 'sync') =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner, items, action }),
    });
  try {
    assert.deepEqual(await (await fetch(url)).json(), { available: true });
    const item = {
      key: 'x',
      title: 'Task',
      body: 'Tomorrow',
      at: now + 10000,
      expires: now + 60000,
      sound: false,
    };
    await Promise.all([post('browser-a', [item]), post('browser-b', [item])]);
    assert.notEqual(calls[0].owner, calls[1].owner);
    assert.equal(maxActive, 1);
    assert.equal((await post('bad!', [])).status, 400);
    assert.equal((await post('browser-a', [{ ...item, entryId: '../bad' }])).status, 400);
    await post('browser-a', []);
    assert.deepEqual(calls.at(-1).items, []);
    fail = true;
    assert.equal((await post('browser-c', [item])).status, 502);
    fail = false;
    await post('browser-c', [item]);
    assert.equal(calls.at(-1).items.length, 1);
    await post('browser-a', [], 'test');
    assert.notEqual(calls.at(-1).owner, calls[0].owner);
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      403,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    assert.ok(root.startsWith(join(tmpdir(), 'voksa-reminder-unit-')));
    await rm(root, { recursive: true, force: true });
  }
});
test('portable backup retains unknown fields, validates version and duplicate IDs, and clamps preferences', () => {
  const records = [
    { ...entry, custom: { untouched: true } },
    { id: 'future', custom: true },
  ];
  const backup = parseBackup(createBackup(records, prefs, new Date(now)));
  assert.deepEqual(backup.records, records);
  assert.equal(backup.count, 1);
  assert.equal(backup.other, 1);
  assert.equal(
    parseBackup(createBackup(records, { ...prefs, zone: 'bad', hourStart: 24 })).preferences
      .hourStart,
    0,
  );
  for (const value of [
    '{}',
    'null',
    'no json',
    JSON.stringify({ app: 'voksa', version: 2, records: [], preferences: {} }),
    createBackup([entry, entry], prefs),
  ])
    assert.throws(() => parseBackup(value));
});
test('undo only restores preferences changed by that action and retains later settings', () => {
  const after = { ...prefs, taskColor: '#ffffff' };
  const current = { ...after, theme: 'dark', sound: true };
  const restored = undoPreferences(current, prefs, after);
  assert.equal(restored.taskColor, prefs.taskColor);
  assert.equal(restored.theme, 'dark');
  assert.equal(restored.sound, true);
  assert.equal(
    undoPreferences({ ...current, taskColor: '#000000' }, prefs, after).taskColor,
    '#000000',
  );
});
test('draft controls preserve other fields, renew choice IDs, and corrections are not mistaken for titles', async () => {
  const context = {
    updatedAt: now,
    pending: { intent: 'create_task', fields: { date: '2026-10-23', time: '14:00' } },
    numeric: { next: 'title' },
  };
  const changed = editDraft(context, 'time', now);
  assert.equal(changed.context.pending.fields.date, '2026-10-23');
  assert.equal(changed.context.pending.fields.time, undefined);
  assert.equal(context.pending.fields.time, '14:00');
  const restored = restoreStep(
    { context: { numeric: { value: '2310', questionId: 'old' } }, question: 'Время или дата?' },
    now,
  );
  assert.notEqual(restored.numericChoiceId, 'old');
  const result = await processRequest(
    interpretLocal,
    'нет, в 15:00',
    [],
    context,
    prefs,
    'operation',
    new Date(now),
  );
  assert.equal(result.context.pending.fields.time, '15:00');
  assert.equal(result.context.pending.fields.date, '2026-10-23');
  assert.equal(result.reply, 'Как называется задача?');
  assert.equal(result.records, undefined);
});
test('cancelled remote requests cannot turn into a fallback operation and status is cached for complex requests', async () => {
  const saved = globalThis.fetch;
  try {
    let gets = 0,
      posts = 0;
    globalThis.fetch = async (_url, o) => {
      if (!o.method) {
        gets++;
        return Response.json({ configured: true, model: 'test' });
      }
      posts++;
      return Response.json({ command: { intent: 'answer_question', answer: 'Уточните дату' } });
    };
    const args = [
      'Создай встречу завтра в 10 или 11',
      {},
      prefs,
      new Date(now),
      [],
      [],
      'cache',
      'request',
    ];
    await interpretAssistant(...args);
    await interpretAssistant(...args);
    assert.equal(gets, 1);
    assert.equal(posts, 2);
    const controller = new AbortController();
    globalThis.fetch = async (_url, o) =>
      new Promise((_, reject) =>
        o.signal.addEventListener('abort', () => reject(o.signal.reason), { once: true }),
      );
    const result = interpretAI(...args, controller.signal);
    controller.abort();
    await assert.rejects(result, { name: 'AbortError' });
  } finally {
    globalThis.fetch = saved;
  }
});
