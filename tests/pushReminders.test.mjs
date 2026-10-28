import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createPushReminderService } from '../server/push-reminders.mjs';
import { importCsv } from '../.tools/test-build/importCsv.js';
import { reminderPlan } from '../.tools/test-build/reminders/plan.js';
import { defaults } from '../.tools/test-build/model.js';

const pair = createECDH('prime256v1');
pair.generateKeys();
const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/test-subscription',
  keys: {
    p256dh: pair.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  },
};
const owner = 'test-browser',
  token = 'a'.repeat(64);
const baseline = Date.parse('2026-10-27T15:00:00Z');
const item = (patch = {}) => ({
  key: 'one',
  at: baseline + 10000,
  expires: baseline + 600000,
  title: 'Отчёт',
  body: 'Завтра, 14:00',
  entryId: 'entry-one',
  sound: false,
  ...patch,
});
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'voxa-push-test-'));
  const clock = { now: baseline },
    calls = [];
  let failure;
  const options = {
    directory,
    automatic: false,
    now: () => clock.now,
    send: async (sub, payload, options) => {
      calls.push({ sub, payload: JSON.parse(payload), options });
      if (failure) throw failure;
    },
  };
  let service = createPushReminderService(options);
  await service.ready;
  const server = createServer((q, s) => service.handle(q, s, () => s.writeHead(404).end()));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/push-reminders`;
  const post = (data = {}, headers = {}) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        owner,
        token,
        action: 'sync',
        subscription,
        items: [item()],
        ...data,
      }),
    });
  t.after(async () => {
    service.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    post,
    url,
    clock,
    calls,
    directory,
    tick: () => service.tick(),
    fail: (e) => {
      failure = e;
    },
    restart: async () => {
      service.close();
      service = createPushReminderService(options);
      await service.ready;
    },
  };
}

test('web push uses stable private keys and persists schedules across server restarts', async (t) => {
  const s = await setup(t);
  const before = await (await fetch(s.url)).json();
  assert.equal(before.available, true);
  assert.equal(before.mode, 'web');
  assert.equal(before.publicKey.length, 87);
  assert.equal(before.privateKey, undefined);
  assert.equal((await s.post()).status, 200);
  // Windows does not expose POSIX permission bits; persistence is checked on every platform.
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(s.directory, 'state.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(s.directory, 'vapid.json'))).mode & 0o777, 0o600);
  }
  await s.restart();
  assert.equal((await (await fetch(s.url)).json()).publicKey, before.publicKey);
  s.clock.now += 10001;
  await s.tick();
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].payload.title, 'Отчёт');
  assert.equal(s.calls[0].payload.entryId, 'entry-one');
  assert.equal(s.calls[0].options.contentEncoding, undefined);
  await s.restart();
  await s.tick();
  assert.equal(s.calls.length, 1);
  assert.equal(
    (await (await s.post()).json()).scheduled,
    0,
    'resync cannot replay a delivered reminder',
  );
});

test('rescheduling, completion and disabling cancel obsolete server jobs', async (t) => {
  const s = await setup(t);
  await s.post();
  await s.post({ items: [item({ key: 'moved', at: baseline + 30000 })] });
  s.clock.now = baseline + 15000;
  await s.tick();
  assert.equal(s.calls.length, 0);
  await s.post({ items: [] });
  s.clock.now = baseline + 31000;
  await s.tick();
  assert.equal(s.calls.length, 0);
  await s.post({ items: [item({ key: 'later', at: baseline + 40000 })] });
  await s.post({ action: 'disable' });
  s.clock.now = baseline + 50000;
  await s.tick();
  assert.equal(s.calls.length, 0);
});

test('the full bundled CSV calendar and imported recurrences are accepted by the push API', async (t) => {
  const s = await setup(t);
  const csv = await readFile('public/data/voice-assistant-events.csv', 'utf8');
  const imported = importCsv(csv, defaults, [], new Date('2026-10-20T00:00:00Z'));
  assert.equal(imported.entries.length, 1000);
  const prefs = { ...defaults, zone: 'Europe/Moscow', enabled: true, background: true };
  const plan = reminderPlan(imported.entries, prefs, baseline);
  assert.ok(plan.length > 0);
  assert.ok(plan.every((item) => item.entryId.startsWith('csv:')));
  const response = await s.post({ items: plan });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).scheduled, plan.length);
  const recurring = {
    ...imported.entries.find((entry) => entry.date > '2026-10-27'),
    date: '2026-10-28',
    recurrence: { frequency: 'daily', until: '2026-10-30' },
  };
  const repeats = reminderPlan([recurring], prefs, baseline);
  assert.ok(repeats.every((item) => /^csv:.*@/.test(item.entryId)));
  const repeated = await s.post({ items: repeats });
  assert.equal(repeated.status, 200);
  s.clock.now = repeats[0].at + 1;
  await s.tick();
  assert.equal(s.calls[0].payload.entryId, repeats[0].entryId);
});

test('far future appointments do not prevent delivery of near-term reminders', async (t) => {
  const s = await setup(t);
  const future = baseline + 800 * 86400000;
  const response = await s.post({
    items: [item(), item({ key: 'far', at: future, expires: future + 3600000 })],
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).scheduled, 2);
  s.clock.now += 10001;
  await s.tick();
  assert.equal(s.calls.length, 1);
  assert.equal((await (await s.post({ action: 'status' })).json()).scheduled, 1);
});

test('background test delivery is delayed, survives restart and fires once', async (t) => {
  const s = await setup(t);
  await s.post({ action: 'test' });
  assert.equal((await s.post({ action: 'test' })).status, 429);
  s.clock.now += 5999;
  await s.tick();
  assert.equal(s.calls.length, 0);
  await s.restart();
  s.clock.now += 2;
  await s.tick();
  assert.equal(s.calls.length, 1);
  assert.match(s.calls[0].payload.body, /вкладку|Вкладку/);
  await s.tick();
  assert.equal(s.calls.length, 1);
});

test('temporary delivery failures retry and removed subscriptions require renewed permission', async (t) => {
  const s = await setup(t);
  await s.post();
  s.clock.now += 10001;
  s.fail(Object.assign(Error('private upstream detail'), { statusCode: 503 }));
  await s.tick();
  assert.equal(s.calls.length, 1);
  await s.tick();
  assert.equal(s.calls.length, 1);
  const status = await (await s.post({ action: 'status' })).json();
  assert.match(status.deliveryError, /временно/);
  assert.doesNotMatch(JSON.stringify(status), /private upstream/);
  s.fail(null);
  s.clock.now += 5001;
  await s.tick();
  assert.equal(s.calls.length, 2);
  await s.post({ items: [item({ key: 'second', at: s.clock.now + 5000 })] });
  s.clock.now += 5001;
  s.fail(Object.assign(Error('gone'), { statusCode: 410 }));
  await s.tick();
  assert.match((await (await s.post({ action: 'status' })).json()).deliveryError, /устарела/);
});

test('capabilities, origins, subscription destinations and reminder validation protect other schedules', async (t) => {
  const s = await setup(t);
  await s.post();
  assert.equal((await s.post({ token: 'b'.repeat(64), items: [] })).status, 403);
  assert.equal((await s.post({}, { Origin: 'https://other.example' })).status, 403);
  for (const endpoint of [
    'http://fcm.googleapis.com/x',
    'https://127.0.0.1/x',
    'https://attacker.example/x',
    'https://fcm.googleapis.com:8443/x',
    'https://user:pass@fcm.googleapis.com/x',
  ])
    assert.equal(
      (await s.post({ subscription: { ...subscription, endpoint } })).status,
      400,
      endpoint,
    );
  assert.equal((await s.post({ items: [item({ entryId: '../secret' })] })).status, 400);
  assert.equal((await s.post({ items: [item({ title: 'x'.repeat(201) })] })).status, 400);
  s.clock.now += 10001;
  await s.tick();
  assert.equal(s.calls.length, 1, 'rejected updates leave the real schedule intact');
});

test('a corrupted schedule file fails closed without replacing saved data', async (t) => {
  const s = await setup(t);
  await s.post();
  await writeFile(join(s.directory, 'state.json'), 'broken-data');
  await s.restart();
  assert.equal((await (await fetch(s.url)).json()).available, false);
  assert.equal((await s.post()).status, 503);
  assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), 'broken-data');
});

test('the push worker displays once across worker restarts and opens only its calendar', async () => {
  const source = await readFile('public/push-worker.js', 'utf8');
  const cacheEntries = new Map(),
    displayed = [],
    opened = [];
  const cache = {
    match: async (k) => cacheEntries.get(String(k)),
    put: async (k, v) => cacheEntries.set(String(k), v),
    keys: async () => [...cacheEntries.keys()],
    delete: async (k) => cacheEntries.delete(String(k)),
  };
  const create = () => {
    const events = {};
    const self = {
      addEventListener: (name, fn) => (events[name] = fn),
      skipWaiting: async () => {},
      registration: {
        scope: 'https://voxacode.online/VoiceTask/',
        showNotification: async (title, options) => displayed.push({ title, options }),
      },
      clients: {
        claim: async () => {},
        matchAll: async () => [],
        openWindow: async (url) => opened.push(url),
      },
    };
    vm.runInNewContext(source, { self, caches: { open: async () => cache }, Response, URL });
    return events;
  };
  const payload = {
    tag: 'a'.repeat(64),
    title: 'Встреча',
    body: '14:00',
    sound: false,
    entryId: 'entry@2026-10-29',
  };
  const push = async (events) => {
    let done;
    events.push({ data: { json: () => payload }, waitUntil: (p) => (done = p) });
    await done;
  };
  await push(create());
  await push(create());
  assert.equal(displayed.length, 1);
  let done;
  create().notificationclick({
    notification: { close() {}, data: { entryId: 'https://evil.example' } },
    waitUntil: (p) => (done = p),
  });
  await done;
  assert.deepEqual(opened, ['https://voxacode.online/VoiceTask/']);
  create().notificationclick({
    notification: { close() {}, data: { entryId: 'csv:imported@2026-10-29' } },
    waitUntil: (p) => (done = p),
  });
  await done;
  assert.equal(new URL(opened.at(-1)).searchParams.get('entry'), 'csv:imported@2026-10-29');
});
