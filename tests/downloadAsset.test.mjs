import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { downloadAsset } from '../scripts/download-asset.mjs';

test('asset installation verifies bytes before publishing and removes incomplete downloads', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'voksa-asset-test-')),
    path = join(folder, 'asset.bin');
  const bytes = Buffer.from('verified bytes'),
    checksum = createHash('sha256').update(bytes).digest('hex');
  try {
    await assert.rejects(
      downloadAsset(path, 'https://example.invalid', checksum, {
        fetchImpl: async () => new Response('bad bytes'),
      }),
      /checksum/,
    );
    assert.deepEqual(await readdir(folder), []);
    let calls = 0;
    await downloadAsset(path, 'https://example.invalid', checksum, {
      attempts: 2,
      fetchImpl: async () => {
        calls++;
        return calls === 1 ? new Response('', { status: 503 }) : new Response(bytes);
      },
    });
    assert.equal(calls, 2);
    assert.deepEqual(await readFile(path), bytes);
    await downloadAsset(path, 'https://example.invalid', checksum, {
      verifyExisting: true,
      fetchImpl: () => assert.fail('Cached assets must not download again'),
    });
    await writeFile(path, 'corrupt');
    await assert.rejects(
      downloadAsset(path, 'https://example.invalid', checksum, { verifyExisting: true }),
      /checksum/,
    );
  } finally {
    assert.ok(folder.startsWith(join(tmpdir(), 'voksa-asset-test-')));
    await rm(folder, { recursive: true, force: true });
  }
});
