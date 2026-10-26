import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { assertSameOrigin, readJSON } from '../server/http.mjs';

function request(chunks, headers = {}) {
  return Object.assign(Readable.from(chunks), {
    headers: { 'content-type': 'application/json', ...headers },
  });
}
test('request limits count bytes and UTF-8 remains intact across stream chunks', async () => {
  const text = JSON.stringify({ text: 'Встреча 🐶' }),
    buffer = Buffer.from(text);
  const chunks = Array.from(buffer, (byte) => Buffer.from([byte]));
  assert.deepEqual(
    await readJSON(request(chunks), { limit: buffer.length, tooLarge: 'limit' }),
    JSON.parse(text),
  );
  await assert.rejects(
    readJSON(request(chunks), { limit: buffer.length - 1, tooLarge: 'limit' }),
    (error) => error.status === 413,
  );
  await assert.rejects(
    readJSON(request(['{}'], { 'content-length': 100 }), { limit: 10, tooLarge: 'limit' }),
    (error) => error.status === 413,
  );
  await assert.rejects(
    readJSON(request(['{']), { limit: 10, tooLarge: 'limit' }),
    (error) => error.status === 400,
  );
});
test('malformed and cross-site origins are rejected before processing a request', () => {
  for (const origin of ['null', 'bad-url', 'https://other.example'])
    assert.throws(
      () => assertSameOrigin({ headers: { origin, host: 'localhost:5173' } }),
      (error) => error.status === 403,
    );
  assert.doesNotThrow(() =>
    assertSameOrigin({ headers: { origin: 'http://localhost:5173', host: 'localhost:5173' } }),
  );
  assert.doesNotThrow(() => assertSameOrigin({ headers: { host: 'localhost:5173' } }));
});
