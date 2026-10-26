import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tests = readdirSync(resolve(root, 'tests'))
  .filter(
    (file) => file.endsWith('.test.mjs') && !['browser.test.mjs', 'build.test.mjs'].includes(file),
  )
  .sort()
  .map((file) => resolve(root, 'tests', file));

for (const args of [
  [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.test.json'],
  ['--test', ...tests],
]) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) {
    process.exitCode = result.status || 1;
    break;
  }
}
