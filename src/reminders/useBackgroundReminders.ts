import { useEffect, useMemo, useRef, useState } from 'react';
import type { Entry } from '../calendar';
import type { Preferences } from '../model';
import { postReminders } from './api';
import { reminderPlan } from './plan';
import { getPushRegistration, subscribeToPush, supportsPush } from './webPush';

export type BackgroundState = {
  available: boolean;
  mode: 'native' | 'web' | null;
  busy: boolean;
  ready: boolean;
  scheduled: number;
  error: string;
  message: string;
  needsPermission: boolean;
  enable: () => Promise<void>;
  test: () => Promise<void>;
};
const initialSync = { busy: false, ready: false, scheduled: 0, error: '' };
const ownerError = 'Разрешите сохранение данных в браузере для фоновых напоминаний.';
function identity() {
  try {
    const key = 'voicetask.reminders.owner.v1';
    let owner = localStorage.getItem(key) || '';
    if (!/^[-\w]{1,100}$/.test(owner)) {
      owner = crypto.randomUUID();
      localStorage.setItem(key, owner);
    }
    let token = localStorage.getItem('voicetask.push.token.v1') || '';
    if (!/^[\da-f]{64}$/.test(token)) {
      token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      localStorage.setItem('voicetask.push.token.v1', token);
    }
    return { owner, token };
  } catch {
    return { owner: '', token: '' };
  }
}
async function postPush(body: string) {
  const response = await fetch('./api/push-reminders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: new Blob([body]).size < 60000,
    signal: AbortSignal.timeout(25000),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Не удалось сохранить уведомления.');
  return result as { scheduled: number; deliveryError?: string };
}
export function useBackgroundReminders(
  entries: Entry[],
  prefs: Preferences,
  now: Date,
): BackgroundState {
  const [{ owner, token }] = useState(identity);
  const [config, setConfig] = useState<{
    mode: 'native' | 'web' | null;
    available: boolean;
    publicKey: string;
    error: string;
  }>({ mode: null, available: false, publicKey: '', error: '' });
  const [subscription, setSubscription] = useState<PushSubscriptionJSON | null>(null);
  const [sync, setSync] = useState(initialSync);
  const [check, setCheck] = useState({ busy: false, error: '', message: '' });
  const revision = useRef(0),
    outbound = useRef<Promise<void>>(Promise.resolve());
  const hour = Math.floor(+now / 3600000);
  const plan = useMemo(() => reminderPlan(entries, prefs, +now), [entries, prefs, hour]);
  const enabled = prefs.enabled && prefs.background;
  const payload = useMemo(
    () =>
      JSON.stringify({
        owner,
        token,
        action: enabled ? 'sync' : 'disable',
        subscription,
        items: plan,
      }),
    [owner, token, enabled, subscription, plan],
  );
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const native = await (await fetch('./api/reminders', { signal: controller.signal })).json();
        if (native.available) {
          setConfig({ mode: 'native', available: true, publicKey: '', error: '' });
          return;
        }
        const web = await (
          await fetch('./api/push-reminders', { signal: controller.signal })
        ).json();
        if (!controller.signal.aborted)
          setConfig({
            mode: 'web',
            available: web.available && supportsPush(),
            publicKey: web.publicKey || '',
            error: !web.available
              ? 'Фоновые уведомления ещё не настроены на сервере.'
              : !supportsPush()
                ? 'Этот браузер не поддерживает фоновые уведомления. Откройте сайт по HTTPS в браузере с поддержкой Web Push.'
                : '',
          });
      } catch {
        if (!controller.signal.aborted)
          setConfig({
            mode: 'web',
            available: false,
            publicKey: '',
            error: 'Не удалось проверить подключение уведомлений.',
          });
      }
    })();
    return () => controller.abort();
  }, []);
  useEffect(() => {
    let stopped = false;
    if (
      config.mode === 'web' &&
      config.available &&
      enabled &&
      Notification.permission === 'granted'
    )
      void getPushRegistration()
        .then((registration) => {
          registration.active?.postMessage({
            type: 'push-owner',
            owner,
            token,
            publicKey: config.publicKey,
          });
          return registration.pushManager.getSubscription();
        })
        .then((value) => {
          if (!stopped) setSubscription(value?.toJSON() || null);
        })
        .catch(() => {
          if (!stopped)
            setSync({ ...initialSync, error: 'Не удалось запустить службу фоновых уведомлений.' });
        });
    return () => {
      stopped = true;
    };
  }, [config.mode, config.available, enabled]);
  useEffect(() => {
    const generation = ++revision.current;
    if (!config.mode || !config.available) return;
    const marker = `voicetask.reminders.active.${owner}`;
    let active = false;
    try {
      active = localStorage.getItem(marker) === 'true';
    } catch {}
    if (!enabled && !active) {
      setSync(initialSync);
      return;
    }
    if (!owner) {
      setSync({ ...initialSync, error: ownerError });
      return;
    }
    if (config.mode === 'web' && enabled && !subscription) {
      setSync(initialSync);
      return;
    }
    setSync((previous) => ({ ...previous, busy: true, ready: false, error: '' }));
    if (enabled)
      try {
        localStorage.setItem(marker, 'true');
      } catch {}
    outbound.current = outbound.current
      .catch(() => {})
      .then(async () => {
        if (generation !== revision.current) return;
        try {
          const result =
            config.mode === 'native'
              ? await postReminders(JSON.stringify({ owner, action: 'sync', items: plan }))
              : await postPush(payload);
          if (generation !== revision.current) return;
          const error = 'deliveryError' in result ? String(result.deliveryError || '') : '';
          setSync({ busy: false, ready: enabled && !error, scheduled: result.scheduled, error });
          if (!enabled) localStorage.removeItem(marker);
        } catch (error) {
          if (generation === revision.current)
            setSync((previous) => ({
              ...previous,
              busy: false,
              ready: false,
              error: (error as Error).message,
            }));
        }
      });
    return () => {
      revision.current++;
    };
  }, [payload, config.mode, config.available]);
  async function enable() {
    if (config.mode === 'native') return;
    setCheck({ busy: true, error: '', message: '' });
    try {
      if (!config.available)
        throw Error(config.error || 'Подождите проверки подключения уведомлений.');
      if (!owner) throw Error(ownerError);
      const permission = await Notification.requestPermission();
      if (permission !== 'granted')
        throw Error(
          permission === 'denied'
            ? 'Уведомления заблокированы. Разрешите их в настройках сайта в браузере.'
            : 'Разрешите уведомления в запросе браузера и нажмите кнопку ещё раз.',
        );
      const value = await subscribeToPush(config.publicKey, sync.error.includes('устарела'));
      const registration = await getPushRegistration();
      registration.active?.postMessage({
        type: 'push-owner',
        owner,
        token,
        publicKey: config.publicKey,
      });
      setSubscription(value.toJSON());
      setCheck({ busy: false, error: '', message: '' });
    } catch (error) {
      setCheck({ busy: false, error: (error as Error).message, message: '' });
    }
  }
  async function test() {
    setCheck({ busy: true, error: '', message: '' });
    try {
      if (!owner) throw Error(ownerError);
      if (config.mode === 'web') {
        if (!subscription) throw Error('Сначала нажмите «Разрешить уведомления».');
        await postPush(JSON.stringify({ owner, token, action: 'test', subscription }));
      } else await postReminders(JSON.stringify({ owner, action: 'test', items: [] }));
      setCheck({
        busy: false,
        error: '',
        message:
          'Тестовое уведомление запланировано. Оно придёт примерно через 6 секунд — вкладку можно закрыть.',
      });
    } catch (error) {
      setCheck({ busy: false, error: (error as Error).message, message: '' });
    }
  }
  return {
    available: config.available,
    mode: config.mode,
    ready: sync.ready,
    scheduled: sync.scheduled,
    busy: sync.busy || check.busy,
    error: check.error || sync.error || config.error,
    message: check.message,
    needsPermission:
      config.mode === 'web' &&
      (!subscription ||
        ('Notification' in window && Notification.permission !== 'granted') ||
        sync.error.includes('устарела')),
    enable,
    test,
  };
}
