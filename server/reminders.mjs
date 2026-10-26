import { assertSameOrigin, sendJSON, readJSON } from './http.mjs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { setupNotifications } from '../scripts/setup-notifications.mjs';
const run = promisify(execFile);
const fail = (status, message) => Object.assign(Error(message), { status });
const escape = (text) =>
  text.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c],
  );
export function reminderXml(item) {
  const launch = item.entryId ? `entry=${encodeURIComponent(item.entryId)}` : '';
  return `<toast launch="${escape(launch)}"><visual><binding template="ToastGeneric"><text>${escape(item.title)}</text><text>${escape(item.body)}</text></binding></visual>${item.sound ? '' : '<audio silent="true"/>'}</toast>`;
}
export async function nativeReminders(command, request, root) {
  const binary = await setupNotifications(root);
  if (!binary) throw fail(503, 'Фоновые напоминания доступны в Windows.');
  const folder = await mkdtemp(join(tmpdir(), 'voksa-reminders-')),
    input = join(folder, 'input.json'),
    output = join(folder, 'output.json');
  try {
    await writeFile(input, JSON.stringify(request));
    await run(binary, [command, input, output], {
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 65536,
    }).catch(async (error) => {
      const data = await readFile(output, 'utf8').then(JSON.parse, () => null);
      if (data?.error?.includes('disabled'))
        throw fail(409, 'Разрешите уведомления ВОКСА в настройках Windows.');
      throw error;
    });
    const result = JSON.parse(await readFile(output, 'utf8'));
    if (!result.ok) throw Error('Native notification failed');
    return result;
  } finally {
    await Promise.allSettled([unlink(input), unlink(output)]);
    await rmdir(folder).catch(() => {});
  }
}
export function prepareReminders(items, ledger, now = Date.now()) {
  const next = new Map(Object.entries(ledger || {}).filter(([, at]) => Number.isFinite(at))),
    native = [];
  for (const item of items) {
    const at = next.get(item.key) ?? Math.max(item.at, now + 3000);
    next.set(item.key, at);
    if (at > now)
      native.push({
        key: item.key,
        at,
        expires: Math.max(item.expires, at + 60000),
        xml: reminderXml(item),
      });
  }
  for (const [key, at] of next) if (at < now - 90 * 86400000) next.delete(key);
  return { ledger: Object.fromEntries(next), items: native };
}
export function createReminderMiddleware({
  root = process.cwd(),
  execute = nativeReminders,
  platform = process.platform,
  now = Date.now,
} = {}) {
  let queue = Promise.resolve();
  return async (req, res, next) => {
    if (!['/api/reminders', '/VoiceTask/api/reminders'].includes(req.url?.split('?')[0]))
      return next();

    try {
      assertSameOrigin(req);
      if (req.method === 'GET') return sendJSON(res, 200, { available: platform === 'win32' });
      if (req.method !== 'POST') throw fail(405, 'Используйте GET или POST.');
      if (platform !== 'win32') throw fail(503, 'Фоновые напоминания доступны в Windows.');
      const input = await readJSON(req, { limit: 2097152, tooLarge: 'Слишком много напоминаний.' });
      if (
        !input ||
        typeof input.owner !== 'string' ||
        !/^[-\w]{1,100}$/.test(input.owner) ||
        !['sync', 'test', 'status'].includes(input.action) ||
        !Array.isArray(input.items) ||
        input.items.length > 4000
      )
        throw fail(400, 'Некорректные параметры напоминаний.');
      for (const item of input.items)
        if (
          !item ||
          typeof item.key !== 'string' ||
          item.key.length > 300 ||
          !Number.isFinite(item.at) ||
          !Number.isFinite(item.expires) ||
          typeof item.title !== 'string' ||
          item.title.length > 200 ||
          typeof item.body !== 'string' ||
          item.body.length > 500 ||
          typeof item.sound !== 'boolean' ||
          (item.entryId !== undefined &&
            (typeof item.entryId !== 'string' || !/^[\w@.-]{1,200}$/.test(item.entryId)))
        )
          throw fail(400, 'Некорректное напоминание.');
      const owner = createHash('sha256')
        .update(input.owner + (input.action === 'test' ? ':test' : ''))
        .digest('hex')
        .slice(0, 16);
      const work = async () => {
        if (input.action === 'status') return execute('status', { owner }, root);
        const folder = join(root, '.tools', 'notifications', 'plans');
        await mkdir(folder, { recursive: true });
        const file = join(folder, `${owner}.json`),
          saved = await readFile(file, 'utf8').then(JSON.parse, () => ({}));
        const items =
          input.action === 'test'
            ? [
                {
                  key: `test:${now()}`,
                  at: now() + 6000,
                  expires: now() + 600000,
                  title: 'ВОКСА',
                  body: 'Фоновые напоминания работают. Можно закрыть вкладку.',
                  sound: false,
                },
              ]
            : input.items;
        const prepared = prepareReminders(items, saved, now());
        const result = await execute('sync', { owner, items: prepared.items }, root);
        await writeFile(`${file}.tmp`, JSON.stringify(prepared.ledger));
        await rename(`${file}.tmp`, file);
        return result;
      };
      const pending = queue.then(work, work);
      queue = pending.catch(() => {});
      return sendJSON(res, 200, await pending);
    } catch (error) {
      sendJSON(res, error.status || 502, {
        error: error.status
          ? error.message
          : 'Не удалось настроить фоновые напоминания. Повторите попытку.',
      });
    }
  };
}
export function remindersPlugin() {
  const attach = (server) => {
    server.middlewares.use(createReminderMiddleware({ root: server.config.root }));
  };
  return { name: 'voksa-reminders', configureServer: attach, configurePreviewServer: attach };
}
