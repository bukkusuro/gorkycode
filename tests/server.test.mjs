import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiServer } from '../server/index.mjs';

test('production API serves health and existing routes without exposing files', async (t) => {
  const server = createApiServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/api/health', '/VoiceTask/api/health']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  }
  const assistant = await fetch(base + '/VoiceTask/api/assistant');
  assert.equal(assistant.status, 200);
  assert.equal(typeof (await assistant.json()).configured, 'boolean');
  const reminders = await fetch(base + '/VoiceTask/api/reminders');
  assert.equal((await reminders.json()).available, process.platform === 'win32');
  const blocked = await fetch(base + '/VoiceTask/api/assistant', {
    headers: { Origin: 'https://another-site.example' },
  });
  assert.equal(blocked.status, 403);
  for (const path of ['/.env', '/server/index.mjs', '/unknown']) {
    assert.equal((await fetch(base + path)).status, 404);
  }
});
