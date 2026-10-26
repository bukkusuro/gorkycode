import { useEffect, useRef, useState } from 'react';
import type { Entry } from '../calendar';
import { type Preferences, type Reminder, dueReminders, readJSON, wallParts } from '../model';
import { expandEntries, shiftDay } from '../recurrence';
import { useBackgroundReminders } from './useBackgroundReminders';
export function useReminders(
  entries: Entry[],
  prefs: Preferences,
  now: Date,
  persist: (key: string, value: unknown) => boolean,
  setNotice: (text: string) => void,
) {
  const background = useBackgroundReminders(entries, prefs, now);
  const [notifications, setNotifications] = useState<Reminder[]>([]);
  const [seen] = useState(() => {
    const saved = readJSON<unknown>('voicetask.reminders.v2', []);
    return new Set<string>(
      Array.isArray(saved) ? saved.filter((key) => typeof key === 'string') : [],
    );
  });
  const audio = useRef<AudioContext | null>(null);
  const todayKey = wallParts(now, prefs.zone).date;
  useEffect(() => {
    if (!prefs.sound) return;
    const unlock = () => {
      if (!audio.current) {
        try {
          audio.current = new AudioContext();
        } catch {}
      }
      if (audio.current?.state === 'suspended') void audio.current.resume();
    };

    document.addEventListener('pointerdown', unlock);
    return () => {
      document.removeEventListener('pointerdown', unlock);
      void audio.current?.close();
      audio.current = null;
    };
  }, [prefs.sound]);
  useEffect(() => {
    let due: Reminder[] = [];
    let upcoming: Reminder[];
    try {
      const expanded = expandEntries(
        entries,
        shiftDay(todayKey, -1),
        shiftDay(todayKey, 1),
        prefs.zone,
      );
      const reminders = dueReminders(expanded, prefs, +now, []);
      due = reminders.filter((reminder) => !seen.has(reminder.key));
      upcoming = reminders.filter((reminder) => reminder.key.endsWith(':soon'));
    } catch {
      return;
    }
    setNotifications((previous) => {
      const overdue = previous.filter(
        (r) =>
          r.key.endsWith(':overdue') &&
          entries.some(
            (e) =>
              e.id === r.entryId &&
              !e.completed &&
              r.key.startsWith(`${e.id}:${e.startAt || e.date + 'T' + e.time}:`),
          ),
      );
      return prefs.enabled ? [...upcoming, ...overdue].slice(0, 40) : [];
    });
    if (!due.length) return;
    const next = [...seen, ...due.map((r) => r.key)];
    if (!persist('voicetask.reminders.v2', next)) return;
    for (const reminder of due) seen.add(reminder.key);
    setNotifications((n) =>
      [
        ...due.filter((r) => !!r.entryId),
        ...n.filter((r) => !due.some((v) => v.key === r.key)),
      ].slice(0, 40),
    );
    if (!background.ready && (prefs.popup || due.some((r) => !r.entryId)))
      setNotice(
        due
          .filter((r) => prefs.popup || !r.entryId)
          .map((r) => r.text)
          .join('\n'),
      );
    if (!background.ready && prefs.sound && audio.current?.state === 'running') {
      const oscillator = audio.current.createOscillator(),
        gain = audio.current.createGain();
      oscillator.connect(gain);
      gain.connect(audio.current.destination);
      gain.gain.value = 0.07;
      oscillator.frequency.value = 660;
      oscillator.start();
      oscillator.stop(audio.current.currentTime + 0.2);
    }
  }, [entries, prefs, now]);

  return { notifications, setNotifications, background };
}
