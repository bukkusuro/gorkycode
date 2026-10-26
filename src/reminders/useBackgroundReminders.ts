import { useEffect, useMemo, useRef, useState } from 'react';
import type { Entry } from '../calendar';
import type { Preferences } from '../model';
import { postReminders } from './api';
import { reminderPlan } from './plan';

export type BackgroundState = {
  available: boolean;
  busy: boolean;
  ready: boolean;
  scheduled: number;
  error: string;
  test: () => Promise<void>;
};
const initialSync = { busy: false, ready: false, scheduled: 0, error: '' };
const ownerError = 'Разрешите сохранение данных в браузере для фоновых напоминаний.';

export function useBackgroundReminders(
  entries: Entry[],
  prefs: Preferences,
  now: Date,
): BackgroundState {
  const [owner] = useState(() => {
    const key = 'voicetask.reminders.owner.v1';
    try {
      const saved = localStorage.getItem(key);
      if (saved && /^[-\w]{1,100}$/.test(saved)) return saved;
      const id = crypto.randomUUID();
      localStorage.setItem(key, id);
      return id;
    } catch {
      return '';
    }
  });
  const [available, setAvailable] = useState(false);
  const [sync, setSync] = useState(initialSync);
  const [check, setCheck] = useState({ busy: false, error: '' });
  const revision = useRef(0);
  const hour = Math.floor(+now / 3600000);
  const plan = useMemo(() => reminderPlan(entries, prefs, +now), [entries, prefs, hour]);
  const payload = useMemo(
    () => JSON.stringify({ owner, action: 'sync', items: plan }),
    [owner, plan],
  );
  const enabled = prefs.enabled && prefs.background;
  useEffect(() => {
    const controller = new AbortController();
    void fetch('./api/reminders', { signal: controller.signal })
      .then((r) => r.json())
      .then((r) => setAvailable(r.available === true))
      .catch(() => {});
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const generation = ++revision.current;
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
    setSync((previous) => ({ ...previous, busy: true, ready: false, error: '' }));
    if (enabled)
      try {
        localStorage.setItem(marker, 'true');
      } catch {}
    void postReminders(payload)
      .then((result) => {
        if (generation !== revision.current) return;
        setSync({ busy: false, ready: enabled, scheduled: result.scheduled, error: '' });
        if (!enabled) localStorage.removeItem(marker);
      })
      .catch((e) => {
        if (generation === revision.current)
          setSync((previous) => ({ ...previous, busy: false, error: e.message }));
      });
    return () => {
      revision.current++;
    };
  }, [payload, enabled, owner]);
  async function test() {
    setCheck({ busy: true, error: '' });
    try {
      if (!owner) throw Error(ownerError);
      await postReminders(JSON.stringify({ owner, action: 'test', items: [] }));
      setCheck({ busy: false, error: '' });
    } catch (e) {
      setCheck({ busy: false, error: (e as Error).message });
    }
  }
  return {
    available,
    ready: sync.ready,
    scheduled: sync.scheduled,
    busy: sync.busy || check.busy,
    error: check.error || sync.error,
    test,
  };
}
