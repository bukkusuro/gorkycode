import webpush from 'web-push';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { assertSameOrigin, httpError, readJSON, sendJSON } from './http.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const validId = (value) => typeof value === 'string' && /^[-\w]{1,100}$/.test(value);
const day = 86400000;

export function validatePushSubscription(value) {
  let url;
  try {
    url = new URL(value?.endpoint);
  } catch {
    throw httpError(400, 'Некорректная подписка.');
  }
  const host = url.hostname;
  const allowed =
    ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'].includes(
      host,
    ) || /^[a-z0-9-]+\.notify\.windows\.com$/.test(host);
  if (
    !allowed ||
    url.protocol !== 'https:' ||
    (url.port && url.port !== '443') ||
    url.username ||
    url.password ||
    url.hash ||
    url.href.length > 4096
  )
    throw httpError(400, 'Адрес службы уведомлений не поддерживается.');
  const { p256dh, auth } = value.keys || {};
  if (
    typeof p256dh !== 'string' ||
    !/^[\w-]{87}$/.test(p256dh) ||
    typeof auth !== 'string' ||
    !/^[\w-]{22}$/.test(auth) ||
    Buffer.from(p256dh, 'base64url')[0] !== 4
  )
    throw httpError(400, 'Некорректные ключи подписки.');
  return { endpoint: url.href, keys: { p256dh, auth } };
}

function validateItems(items, now) {
  if (!Array.isArray(items) || items.length > 4000)
    throw httpError(400, 'Допустимо до 4 000 напоминаний.');
  return items.map((item) => {
    if (
      !item ||
      typeof item.key !== 'string' ||
      !item.key ||
      item.key.length > 300 ||
      !Number.isSafeInteger(item.at) ||
      !Number.isSafeInteger(item.expires) ||
      item.expires <= now ||
      item.expires > 8640000000000000 ||
      item.expires <= item.at ||
      typeof item.title !== 'string' ||
      !item.title ||
      item.title.length > 200 ||
      typeof item.body !== 'string' ||
      item.body.length > 500 ||
      typeof item.sound !== 'boolean' ||
      (item.entryId !== undefined &&
        (typeof item.entryId !== 'string' || !/^[\w:@.-]{1,200}$/.test(item.entryId)))
    )
      throw httpError(400, 'Некорректное напоминание.');
    return {
      key: hash(item.key),
      at: Math.max(item.at, now + 3000),
      expires: item.expires,
      title: item.title,
      body: item.body,
      sound: item.sound,
      ...(item.entryId ? { entryId: item.entryId } : {}),
    };
  });
}

export function createPushReminderService({
  directory = process.env.PUSH_REMINDERS_DIR || '',
  now = Date.now,
  send = (subscription, payload, options) =>
    webpush.sendNotification(subscription, payload, options),
  automatic = true,
} = {}) {
  let state = { owners: {} },
    vapid,
    failed = false,
    closed = false,
    timer,
    ticking = false;
  let queue = Promise.resolve();
  let windowStart = now(),
    requests = 0,
    registrations = 0;
  const exclusive = (work) => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };
  const save = async () => {
    const path = join(directory, 'state.json');
    await writeFile(path + '.tmp', JSON.stringify(state), { mode: 0o600 });
    await rename(path + '.tmp', path);
  };
  const ready = (async () => {
    if (!directory) return;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      vapid = JSON.parse(await readFile(join(directory, 'vapid.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      vapid = webpush.generateVAPIDKeys();
      await writeFile(join(directory, 'vapid.json'), JSON.stringify(vapid), {
        mode: 0o600,
        flag: 'wx',
      });
    }
    webpush.getVapidHeaders(
      'https://fcm.googleapis.com',
      'https://voxacode.online',
      vapid.publicKey,
      vapid.privateKey,
      'aes128gcm',
    );
    try {
      state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!state.owners || typeof state.owners !== 'object' || Array.isArray(state.owners))
      throw Error('Invalid push state');
    if (automatic && !closed) {
      timer = setInterval(() => {
        void tick().catch(() => console.error('Background push scheduler failed'));
      }, 1000);
      timer.unref();
    }
  })().catch(() => {
    failed = true;
  });

  const status = (record) => ({
    scheduled: record?.items.length || 0,
    ...(record?.error ? { deliveryError: record.error } : {}),
  });

  async function handle(req, res, next) {
    if (!['/api/push-reminders', '/VoiceTask/api/push-reminders'].includes(req.url?.split('?')[0]))
      return next();
    try {
      assertSameOrigin(req);
      await ready;
      if (req.method === 'GET')
        return sendJSON(res, 200, {
          available: !!directory && !failed,
          mode: 'web',
          ...(directory && !failed ? { publicKey: vapid.publicKey } : {}),
        });
      if (req.method !== 'POST') throw httpError(405, 'Используйте GET или POST.');
      if (!directory || failed)
        throw httpError(503, 'Фоновые уведомления ещё не настроены на сервере.');
      if (now() - windowStart > 60000) {
        windowStart = now();
        requests = 0;
        registrations = 0;
      }
      if (++requests > 300) throw httpError(429, 'Слишком много запросов. Повторите через минуту.');
      const input = await readJSON(req, { limit: 2097152, tooLarge: 'Слишком много напоминаний.' });
      if (
        !input ||
        !validId(input.owner) ||
        typeof input.token !== 'string' ||
        !/^[\da-f]{64}$/.test(input.token) ||
        !['sync', 'test', 'disable', 'status', 'subscribe'].includes(input.action)
      )
        throw httpError(400, 'Некорректные параметры уведомлений.');
      const id = hash(input.owner),
        tokenHash = hash(input.token);
      const items = input.action === 'sync' ? validateItems(input.items, now()) : [];
      const subscription = input.subscription ? validatePushSubscription(input.subscription) : null;
      const result = await exclusive(async () => {
        let record = Object.hasOwn(state.owners, id)
          ? structuredClone(state.owners[id])
          : undefined;
        if (record && !timingSafeEqual(Buffer.from(record.tokenHash), Buffer.from(tokenHash)))
          throw httpError(403, 'Нет доступа к этой подписке.');
        if (!record && ['disable', 'status'].includes(input.action)) return status(null);
        if (!record) {
          if (!subscription) throw httpError(400, 'Сначала разрешите уведомления в браузере.');
          for (const [key, old] of Object.entries(state.owners))
            if (
              old.updatedAt < now() - 400 * day &&
              !old.items.some((item) => item.expires > now())
            )
              delete state.owners[key];
          if (Object.keys(state.owners).length >= 200 || ++registrations > 10)
            throw httpError(429, 'Лимит новых подписок. Повторите позже.');
          record = {
            tokenHash,
            subscription,
            items: [],
            tests: [],
            delivered: {},
            updatedAt: now(),
            retryAt: 0,
            failures: 0,
            error: '',
          };
        }
        if (input.action === 'status') return status(record);
        if (subscription && input.action !== 'disable') {
          if (subscription.endpoint === record.invalidEndpoint)
            throw httpError(410, 'Подписка устарела. Нажмите «Разрешить уведомления» ещё раз.');
          if (subscription.endpoint !== record.subscription?.endpoint) {
            record.error = '';
            record.retryAt = 0;
            record.failures = 0;
          }
          record.subscription = subscription;
        }
        if (input.action !== 'disable' && !record.subscription)
          throw httpError(410, 'Подписка устарела. Нажмите «Разрешить уведомления» ещё раз.');
        if (input.action === 'sync') {
          const old = new Map(record.items.map((item) => [item.key, item]));
          const unique = new Map(items.map((item) => [item.key, item]));
          const pending = [...unique.values()]
            .filter((item) => !Object.hasOwn(record.delivered, item.key))
            .map((item) => ({ ...item, at: old.get(item.key)?.at ?? item.at }));
          const total = Object.entries(state.owners)
            .filter(([key]) => key !== id)
            .reduce((sum, [, value]) => sum + value.items.length, 0);
          if (total + pending.length > 50000)
            throw httpError(429, 'Лимит напоминаний сервера. Повторите позже.');
          record.items = pending;
        }
        if (input.action === 'test') {
          if (record.tests.some((item) => item.expires > now()))
            throw httpError(429, 'Тест уже запланирован. Подождите немного.');
          record.tests = [
            {
              key: hash(randomUUID()),
              at: now() + 6000,
              expires: now() + 600000,
              title: 'ВОКСА',
              body: 'Фоновые уведомления работают. Вкладку можно закрыть.',
              sound: false,
            },
          ];
        }
        if (input.action === 'disable') {
          record.items = [];
          record.tests = [];
          record.error = '';
        }
        record.delivered = Object.fromEntries(
          Object.entries(record.delivered).filter(([, at]) => at > now() - 7 * day),
        );
        record.updatedAt = now();
        state.owners[id] = record;
        await save();
        return status(record);
      });
      sendJSON(res, 200, result);
    } catch (error) {
      sendJSON(res, error.status || 503, {
        error: error.status
          ? error.message
          : 'Не удалось сохранить фоновые уведомления. Повторите попытку.',
      });
    }
  }

  async function tick() {
    await ready;
    if (!directory || failed || closed || ticking) return;
    ticking = true;
    try {
      for (let i = 0; i < 20 && !closed; i++) {
        const sent = await exclusive(async () => {
          let changed = false;
          for (const record of Object.values(state.owners)) {
            for (const field of ['items', 'tests']) {
              const kept = record[field].filter((item) => item.expires > now());
              if (kept.length !== record[field].length) {
                record[field] = kept;
                changed = true;
              }
            }
            if (!record.subscription || record.retryAt > now()) continue;
            const item = [...record.tests, ...record.items]
              .filter((item) => item.at <= now())
              .sort((a, b) => a.at - b.at)[0];
            if (!item) continue;
            try {
              await send(
                record.subscription,
                JSON.stringify({
                  title: item.title,
                  body: item.body,
                  tag: item.key,
                  entryId: item.entryId,
                  sound: item.sound,
                  expires: item.expires,
                }),
                {
                  vapidDetails: { subject: 'https://voxacode.online', ...vapid },
                  TTL: Math.max(1, Math.min(86400, Math.floor((item.expires - now()) / 1000))),
                  urgency: 'high',
                  timeout: 10000,
                  ...(process.env.HTTPS_PROXY ? { proxy: process.env.HTTPS_PROXY } : {}),
                },
              );
              record.items = record.items.filter((value) => value.key !== item.key);
              record.tests = record.tests.filter((value) => value.key !== item.key);
              record.delivered[item.key] = now();
              record.failures = 0;
              record.retryAt = 0;
              record.error = '';
            } catch (error) {
              if ([404, 410].includes(error.statusCode)) {
                record.invalidEndpoint = record.subscription.endpoint;
                record.subscription = null;
                record.error = 'Подписка устарела. Нажмите «Разрешить уведомления» ещё раз.';
              } else {
                record.failures++;
                record.retryAt =
                  now() + Math.min(300000, 5000 * 2 ** Math.min(record.failures - 1, 6));
                record.error = 'Служба доставки временно недоступна. Сервер повторит отправку.';
              }
            }
            await save();
            return true;
          }
          if (changed) await save();
          return false;
        });
        if (!sent) break;
      }
    } finally {
      ticking = false;
    }
  }
  return {
    handle,
    tick,
    ready,
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}

export function pushRemindersPlugin() {
  const attach = (server) => {
    const service = createPushReminderService();
    server.middlewares.use(service.handle);
    server.httpServer?.once('close', service.close);
  };
  return { name: 'voxa-push-reminders', configureServer: attach, configurePreviewServer: attach };
}
