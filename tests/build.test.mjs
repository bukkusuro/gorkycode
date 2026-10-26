import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
test('production index references existing assets under the GitHub Pages base', async () => {
  const html = await readFile('dist/index.html', 'utf8');
  const assets = [...html.matchAll(/(?:src|href)="(\/VoiceTask\/assets\/[^"?#]+)"/g)].map(
    (m) => m[1],
  );
  assert.ok(assets.some((a) => a.endsWith('.js')));
  assert.ok(assets.some((a) => a.endsWith('.css')));
  for (const asset of assets)
    assert.ok((await readFile(`dist/${asset.slice('/VoiceTask/'.length)}`)).length > 0);
  assert.match(
    await readFile('dist/recorder-worklet.js', 'utf8'),
    /registerProcessor\('voice-recorder'/,
  );
});
test('production bundle has no known secret formats and no configured remote AI endpoint', async () => {
  const files = (await readdir('dist/assets')).filter((f) => /\.(js|css)$/.test(f));
  for (const file of files) {
    const source = await readFile(`dist/assets/${file}`, 'utf8');
    assert.equal(
      /sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(
        source,
      ),
      false,
      `Secret signature in ${file}`,
    );
    assert.equal(
      /https:\/\/(?:api\.(?:openai|anthropic)\.com|openrouter\.ai\/api)/.test(source),
      false,
      'No direct provider calls in client',
    );
  }
});
