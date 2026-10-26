import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function downloadAsset(
  path,
  url,
  checksum,
  { verifyExisting = false, attempts = 1, timeoutMs = 60000, fetchImpl = fetch } = {},
) {
  if (existsSync(path)) {
    if (verifyExisting && (await fileHash(path)) !== checksum)
      throw Error('Asset checksum mismatch');
    return;
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    const temporary = `${path}.${randomUUID()}.download`;
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok || !response.body)
        throw Error(`Asset download failed (HTTP ${response.status})`);
      const hash = createHash('sha256');
      const digest = new Transform({
        transform(chunk, encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(response.body, digest, createWriteStream(temporary, { flags: 'wx' }));
      if (hash.digest('hex') !== checksum) throw Error('Asset checksum mismatch');
      await rename(temporary, path);
      return;
    } catch (error) {
      if (attempt === attempts - 1) throw error;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
}
