import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { downloadAsset } from './download-asset.mjs';
const run = promisify(execFile);
const available = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
export async function setupNotifications(
  root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
) {
  if (process.platform !== 'win32') return null;
  const folder = join(root, '.tools', 'notifications');
  await mkdir(folder, { recursive: true });
  const source = join(root, 'scripts', 'VoksaNotifier.cs'),
    binary = join(folder, 'VoksaNotifier.exe'),
    fingerprint = createHash('sha256')
      .update(await readFile(source))
      .digest('hex'),
    marker = join(folder, 'build.sha256');
  if (
    (await available(binary)) &&
    (await available(join(folder, 'Microsoft.Toolkit.Uwp.Notifications.dll'))) &&
    (await readFile(marker, 'utf8').catch(() => '')) === fingerprint
  )
    return binary;
  const packages = [
    {
      name: 'toolkit',
      id: 'microsoft.toolkit.uwp.notifications',
      version: '7.1.3',
      hash: 'b328139ad101ccb810e9d8741e9abf0b3f71f9d70397bdfef6668ebd9bcd6c5e',
    },
    {
      name: 'contracts',
      id: 'microsoft.windows.sdk.contracts',
      version: '10.0.19041.1',
      hash: '7dc674587605f02b0b22266071834dd6e23efaeed0d615c2a7f1c2601c18698d',
    },
  ];
  for (const pkg of packages) {
    const archive = join(folder, `${pkg.name}.zip`),
      output = join(folder, pkg.name);
    const url = `https://api.nuget.org/v3-flatcontainer/${pkg.id}/${pkg.version}/${pkg.id}.${pkg.version}.nupkg`;
    await downloadAsset(archive, url, pkg.hash, {
      verifyExisting: true,
      attempts: 3,
      timeoutMs: 45000,
    });
    if (!(await available(output)))
      await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(root, 'scripts', 'expand-notifications.ps1'),
          archive,
          output,
        ],
        { windowsHide: true, timeout: 60000 },
      );
  }
  await copyFile(
    join(folder, 'toolkit', 'lib', 'net461', 'Microsoft.Toolkit.Uwp.Notifications.dll'),
    join(folder, 'Microsoft.Toolkit.Uwp.Notifications.dll'),
  );
  const framework = join(
      process.env.SystemRoot || 'C:\\Windows',
      'Microsoft.NET',
      'Framework64',
      'v4.0.30319',
    ),
    gac = join(
      process.env.SystemRoot || 'C:\\Windows',
      'Microsoft.NET',
      'assembly',
      'GAC_MSIL',
      'System.Runtime',
    ),
    runtime = join(gac, (await readdir(gac))[0], 'System.Runtime.dll'),
    contracts = join(folder, 'contracts', 'ref', 'netstandard2.0');
  const references = [
    join(folder, 'Microsoft.Toolkit.Uwp.Notifications.dll'),
    runtime,
    join(framework, 'System.Runtime.WindowsRuntime.dll'),
    join(framework, 'System.Web.Extensions.dll'),
    ...(await readdir(contracts))
      .filter((f) => f.endsWith('.winmd'))
      .map((f) => join(contracts, f)),
  ];
  await run(
    join(framework, 'csc.exe'),
    [
      '/nologo',
      '/target:winexe',
      '/platform:x64',
      '/codepage:65001',
      `/out:${binary}`,
      ...references.map((f) => `/reference:${f}`),
      source,
    ],
    { windowsHide: true, timeout: 30000 },
  );
  await writeFile(marker, fingerprint);
  return binary;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await setupNotifications();
  process.stdout.write('Windows reminders are ready.\n');
}
