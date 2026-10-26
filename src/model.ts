import { type Entry, dateKey, validEntry, validTime, validColor } from './calendar.js';

export type Preferences = {
  theme: 'light' | 'dark' | 'system';
  accent: string;
  text: 'small' | 'medium' | 'large';
  density: 'standard' | 'brief' | 'full';
  zone: string;
  defaultPeriod: 'День' | 'Неделя' | 'Месяц' | 'Год';
  hourStart: number;
  hourEnd: number;
  dateFormat: string;
  taskColor: string;
  meetingColor: string;
  eventColor: string;
  highlight: boolean;
  weekNumbers: boolean;
  enabled: boolean;
  background: boolean;
  lead: number;
  tasks: boolean;
  meetings: boolean;
  events: boolean;
  important: boolean;
  sound: boolean;
  popup: boolean;
  daily: boolean;
};

export const defaults: Preferences = {
  theme: 'system',
  accent: '#805039',
  text: 'medium',
  density: 'standard',
  zone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow',
  defaultPeriod: 'Неделя',
  hourStart: 0,
  hourEnd: 24,
  dateFormat: 'DD.MM.YYYY',
  taskColor: '#ddd8f5',
  meetingColor: '#d8eae2',
  eventColor: '#f7e5cf',
  highlight: true,
  weekNumbers: false,
  enabled: true,
  background: false,
  lead: 15,
  tasks: true,
  meetings: true,
  events: true,
  important: true,
  sound: false,
  popup: true,
  daily: false,
};
export const ENTRY_KEY = 'voicetask.entries.v1';
const MINUTE_MS = 60_000,
  DAY_MS = 86_400_000;

export function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeJSON(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function loadPreferences(): Preferences {
  return parsePreferences(readJSON<Partial<Preferences>>('voicetask.preferences.v2', {}));
}
export function parsePreferences(value: unknown): Preferences {
  const raw = value as Partial<Preferences> | null;
  const p = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof Preferences)[]) {
    if (raw && typeof raw[key] === typeof defaults[key]) Object.assign(p, { [key]: raw[key] });
  }
  if (!['light', 'dark', 'system'].includes(p.theme)) p.theme = defaults.theme;
  if (!['small', 'medium', 'large'].includes(p.text)) p.text = defaults.text;
  if (!['standard', 'brief', 'full'].includes(p.density)) p.density = defaults.density;
  if (!['День', 'Неделя', 'Месяц', 'Год'].includes(p.defaultPeriod))
    p.defaultPeriod = defaults.defaultPeriod;
  for (const key of ['accent', 'taskColor', 'meetingColor', 'eventColor'] as const) {
    if (!validColor(p[key])) p[key] = defaults[key];
  }
  try {
    new Intl.DateTimeFormat('ru', { timeZone: p.zone });
  } catch {
    p.zone = defaults.zone;
  }
  if (!(
    Number.isInteger(p.hourStart) &&
    Number.isInteger(p.hourEnd) &&
    p.hourStart >= 0 &&
    p.hourEnd <= 24 &&
    p.hourEnd > p.hourStart
  )) {
    p.hourStart = 0;
    p.hourEnd = 24;
  }
  if (![5, 15, 30, 60, 1440].includes(p.lead)) p.lead = 15;
  if (!['DD.MM.YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY'].includes(p.dateFormat))
    p.dateFormat = defaults.dateFormat;
  return p;
}

export function loadRecords(): unknown[] {
  const raw = localStorage.getItem(ENTRY_KEY);
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw Error('Неверный формат сохранённых записей');
  return parsed;
}

export const commentOf = (e: Entry) => e.comment ?? e.description ?? '';
const wallFormatters = new Map<string, Intl.DateTimeFormat>();
const wallCache = new Map<string, { date: string; time: string }>();
const instantCache = new Map<string, string>();
function remember<K, V>(cache: Map<K, V>, key: K, value: V) {
  if (cache.size >= 2048) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}

export function wallParts(instant: string | Date, zone: string) {
  const date = new Date(instant),
    key = `${zone}:${+date}`;
  const cached = wallCache.get(key);
  if (cached) return { ...cached };
  let formatter = wallFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('sv-SE', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    wallFormatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const result = {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
  remember(wallCache, key, result);
  return { ...result };
}

const wallNumber = (day: string, time: string) => Date.parse(`${day}T${time}:00Z`);

export function toInstant(day: string, time: string, zone: string) {
  const key = `${zone}:${day}T${time}`,
    cached = instantCache.get(key);
  if (cached) return cached;
  const wanted = wallNumber(day, time);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !validTime(time) ||
    !Number.isFinite(wanted) ||
    new Date(wanted).toISOString().slice(0, 10) !== day
  ) {
    throw Error('Некорректная дата или время');
  }
  let candidate = wanted;
  for (let i = 0; i < 5; i++) {
    const parts = wallParts(new Date(candidate), zone);
    const difference = wanted - wallNumber(parts.date, parts.time);
    if (!difference) return remember(instantCache, key, new Date(candidate).toISOString());
    candidate += difference;
  }
  throw Error('Такого местного времени нет в выбранном часовом поясе');
}

const displayedEnds = new WeakMap<Entry, { date: string; time: string }>();

export function displayEntry(e: Entry, zone: string): Entry {
  if (!e.startAt) return e;
  const start = wallParts(e.startAt, zone);
  if (e.atTime) return { ...e, ...start, duration: 0 };
  const end = wallParts(e.endAt!, zone);
  const civilDuration =
    (wallNumber(end.date, end.time) - wallNumber(start.date, start.time)) / MINUTE_MS;
  const displayed = { ...e, ...start, duration: Math.max(1, civilDuration) };
  displayedEnds.set(displayed, end);
  return displayed;
}

export function endParts(e: Entry) {
  if (e.atTime) return { date: e.date, time: e.time };
  const exact = displayedEnds.get(e);
  if (exact) return exact;
  const date = new Date(wallNumber(e.date, e.time) + e.duration * MINUTE_MS);
  if (!Number.isFinite(+date)) return { date: '', time: '' };
  const iso = date.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

export function segment(e: Entry, day: string): Entry | null {
  if (e.atTime) return e.date === day ? { ...e } : null;
  const start = wallNumber(e.date, e.time),
    midnight = wallNumber(day, '00:00');
  const a = Math.max(start, midnight),
    b = Math.min(start + e.duration * MINUTE_MS, midnight + DAY_MS);
  if (b <= a) return null;
  return {
    ...e,
    date: day,
    time: new Date(a).toISOString().slice(11, 16),
    duration: (b - a) / MINUTE_MS,
  };
}

export function searchEntries(entries: Entry[], query: string) {
  const q = query.trim().toLocaleLowerCase('ru');
  return q
    ? entries
        .filter((e) => `${e.title} ${commentOf(e)}`.toLocaleLowerCase('ru').includes(q))
        .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`))
    : [];
}

export function dateLabel(day: string, format: string) {
  const [year, month, date] = day.split('-');
  return format === 'YYYY-MM-DD'
    ? day
    : format === 'MM/DD/YYYY'
      ? `${month}/${date}/${year}`
      : `${date}.${month}.${year}`;
}

export function weekNumber(day: Date) {
  const date = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  return Math.ceil(((+date - Date.UTC(date.getUTCFullYear(), 0, 1)) / DAY_MS + 1) / 7);
}

export type Reminder = { key: string; entryId?: string; text: string };

export function dueReminders(entries: Entry[], p: Preferences, now: number, seen: string[]) {
  if (!p.enabled) return [];
  const reminders: Reminder[] = [],
    seenKeys = new Set(seen);
  for (const e of entries) {
    if (
      e.allDay ||
      e.completed ||
      !(
        (e.important && p.important) ||
        (e.type === 'task' && p.tasks) ||
        (e.type === 'meeting' && p.meetings) ||
        (e.type === 'event' && p.events)
      )
    )
      continue;
    let start: number;
    try {
      start = e.startAt ? Date.parse(e.startAt) : Date.parse(toInstant(e.date, e.time, p.zone));
    } catch {
      continue;
    }
    if (e.importedAt && start < Date.parse(e.importedAt)) continue;
    const delta = start - now,
      overdue = delta < 0;
    if ((overdue && e.type !== 'task') || delta > p.lead * MINUTE_MS) continue;
    const key = `${e.id}:${e.startAt || e.date + 'T' + e.time}:${overdue ? 'overdue' : 'soon'}`;
    if (!seenKeys.has(key)) {
      reminders.push({
        key,
        entryId: e.id,
        text: `${e.important ? '! ' : ''}${overdue ? 'Просроченная задача' : e.type === 'task' ? 'Скоро задача' : e.type === 'meeting' ? 'Скоро встреча' : 'Скоро событие'}: ${e.title}`,
      });
    }
  }
  if (p.daily) {
    const day = wallParts(new Date(now), p.zone).date,
      key = `daily:${day}`;
    if (!seenKeys.has(key)) {
      reminders.push({
        key,
        text: `Обзор дня: ${entries.filter((e) => segment(displayEntry(e, p.zone), day)).length} записей на ${dateLabel(day, p.dateFormat)}`,
      });
    }
  }
  return reminders;
}

export { validEntry, dateKey };

export function standardAppearance(p: Preferences): Preferences {
  return { ...p, theme: 'system', accent: '#805039', text: 'medium', density: 'standard' };
}
