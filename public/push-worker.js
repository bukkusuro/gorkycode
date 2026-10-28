const deliveredCache = 'voxa-push-delivered-v1';
let queue = Promise.resolve();
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  const data = event.data;
  if (
    data?.type !== 'push-owner' ||
    !/^[-\w]{1,100}$/.test(data.owner) ||
    !/^[\da-f]{64}$/.test(data.token) ||
    !/^[\w-]{87}$/.test(data.publicKey)
  )
    return;
  event.waitUntil(
    caches
      .open('voxa-push-config-v1')
      .then((cache) =>
        cache.put(
          new URL('__push-config', self.registration.scope).href,
          new Response(JSON.stringify(data)),
        ),
      ),
  );
});
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open('voxa-push-config-v1');
      const response = await cache.match(new URL('__push-config', self.registration.scope).href);
      if (!response) return;
      const config = await response.json();
      const binary = atob(config.publicKey.replace(/-/g, '+').replace(/_/g, '/'));
      const subscription =
        event.newSubscription ||
        (await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: Uint8Array.from(binary, (c) => c.charCodeAt(0)),
        }));
      const result = await fetch(new URL('api/push-reminders', self.registration.scope), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner: config.owner,
          token: config.token,
          action: 'subscribe',
          subscription: subscription.toJSON(),
        }),
      });
      if (!result.ok) throw Error('Subscription renewal failed');
    })(),
  );
});
self.addEventListener('push', (event) => {
  queue = queue
    .catch(() => {})
    .then(async () => {
      let data;
      try {
        data = event.data.json();
      } catch {
        return;
      }
      if (!data || !/^[\da-f]{64}$/.test(data.tag) || typeof data.title !== 'string') return;
      const cache = await caches.open(deliveredCache);
      const key = new URL(`__push/${data.tag}`, self.registration.scope).href;
      if (await cache.match(key)) return;
      await self.registration.showNotification(data.title.slice(0, 200), {
        body: String(data.body || '').slice(0, 500),
        tag: data.tag,
        silent: !data.sound,
        data: { entryId: data.entryId || '' },
      });
      await cache.put(key, new Response(JSON.stringify({ at: Date.now() })));
      const keys = await cache.keys();
      for (const old of keys.slice(0, Math.max(0, keys.length - 512))) await cache.delete(old);
    });
  event.waitUntil(queue);
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const url = new URL('./', self.registration.scope);
      const entryId = event.notification.data?.entryId;
      if (typeof entryId === 'string' && /^[\w:@.-]{1,200}$/.test(entryId))
        url.searchParams.set('entry', entryId);
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const target = windows.find((client) => client.url.startsWith(self.registration.scope));
      if (target) {
        await target.navigate(url.href);
        await target.focus();
      } else await self.clients.openWindow(url.href);
    })(),
  );
});
