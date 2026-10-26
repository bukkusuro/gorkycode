import { type Entry, type Recurrence, addDays, dateKey, fromKey, validEntry } from './calendar.js';
import { displayEntry, toInstant } from './model.js';

export const shiftDay = (day: string, count: number) => dateKey(addDays(fromKey(day), count));

export function validDay(day: unknown): day is string {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const date = fromKey(day);
  return Number.isFinite(+date) && dateKey(date) === day;
}

export function validRecurrence(value: unknown): value is Recurrence {
  if (!value || typeof value !== 'object') return false;
  const r = value as Recurrence;
  return (
    Object.keys(r).every((key) =>
      ['frequency', 'weekdays', 'until', 'ordinal', 'exceptions'].includes(key),
    ) &&
    ['daily', 'weekly', 'monthly'].includes(r.frequency) &&
    (r.until === undefined || validDay(r.until)) &&
    (r.weekdays === undefined ||
      (Array.isArray(r.weekdays) &&
        r.weekdays.length > 0 &&
        r.weekdays.length <= 7 &&
        r.weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6))) &&
    (r.ordinal === undefined ||
      (r.frequency === 'monthly' &&
        Number.isInteger(r.ordinal) &&
        r.ordinal >= 1 &&
        r.ordinal <= 5 &&
        r.weekdays?.length === 1)) &&
    (r.exceptions === undefined || (Array.isArray(r.exceptions) && r.exceptions.every(validDay)))
  );
}

function recurrenceMatcher(e: Entry) {
  const r = e.recurrence!;
  const first = fromKey(e.date),
    weekdays = new Set(r.weekdays || [first.getDay()]),
    exceptions = new Set(r.exceptions);
  return (day: string) => {
    if (day < e.date || (r.until && day > r.until) || exceptions.has(day)) return false;
    if (r.frequency === 'daily') return true;
    const date = fromKey(day);
    if (r.frequency === 'weekly') return weekdays.has(date.getDay());
    return r.ordinal
      ? weekdays.has(date.getDay()) && Math.ceil(date.getDate() / 7) === r.ordinal
      : date.getDate() === first.getDate();
  };
}

export function occurs(e: Entry, day: string) {
  return !!e.recurrence && validRecurrence(e.recurrence) && recurrenceMatcher(e)(day);
}

export function occurrence(e: Entry, day: string, zone: string): Entry {
  return makeOccurrence(e, displayEntry(e, zone), day, zone);
}
function makeOccurrence(e: Entry, base: Entry, day: string, zone: string): Entry {
  const next: Entry = {
    ...base,
    id: `${e.id}@${day}`,
    sourceId: e.id,
    occurrenceDate: day,
    date: day,
  };
  if (e.startAt) {
    next.startAt = toInstant(day, base.time, zone);
    next.endAt = e.atTime
      ? undefined
      : new Date(Date.parse(next.startAt) + e.duration * 60000).toISOString();
  }
  return next;
}

export function nextOccurrence(e: Entry, start: string, zone: string) {
  if (!e.recurrence || !validRecurrence(e.recurrence)) return;
  const matches = recurrenceMatcher(e);
  let base: Entry;
  try {
    base = displayEntry(e, zone);
  } catch {
    return;
  }
  let day = start > e.date ? start : e.date;
  for (let i = 0; i < 3660; i++, day = shiftDay(day, 1)) {
    if (e.recurrence.until && day > e.recurrence.until) return;
    if (!matches(day)) continue;
    try {
      return makeOccurrence(e, base, day, zone);
    } catch {}
  }
}

export function expandEntries(entries: Entry[], start: string, end: string, zone: string): Entry[] {
  const output: Entry[] = [];
  for (const e of entries) {
    if (!e.recurrence || !validRecurrence(e.recurrence)) {
      output.push(e);
      continue;
    }
    const first = shiftDay(start, -Math.min(3660, Math.ceil(e.duration / 1440)));
    const matches = recurrenceMatcher(e);
    let base: Entry;
    try {
      base = displayEntry(e, zone);
    } catch {
      continue;
    }
    let day = first > e.date ? first : e.date;
    for (let i = 0; day <= end && i < 4400; i++, day = shiftDay(day, 1)) {
      if (e.recurrence.until && day > e.recurrence.until) break;
      if (!matches(day)) continue;
      try {
        output.push(makeOccurrence(e, base, day, zone));
      } catch {}
    }
  }
  return output;
}

export type Scope = 'one' | 'future' | 'all';

export function changeOccurrence(
  records: unknown[],
  selected: Entry,
  patch: Partial<Entry> | null,
  scope: Scope,
  zone: string,
): unknown[] {
  const id = selected.sourceId || selected.id;
  const base = records.find((e) => validEntry(e) && e.id === id) as Entry | undefined;
  if (!base) throw Error('Запись больше не существует.');
  const replace = (next: Entry) => records.map((e) => (e === base ? next : e));
  if (!base.recurrence) {
    return patch === null ? records.filter((e) => e !== base) : replace({ ...base, ...patch });
  }
  if (!selected.occurrenceDate && scope !== 'all')
    throw Error('Сначала выберите конкретное повторение.');
  if (scope === 'all') {
    if (patch === null) return records.filter((e) => e !== base);
    const changes = { ...patch };
    if (changes.date === selected.date) changes.date = base.date;
    const next = { ...base, ...changes };
    if (next.startAt) {
      next.startAt = toInstant(next.date, next.time, zone);
      next.endAt = next.atTime
        ? undefined
        : new Date(Date.parse(next.startAt) + next.duration * 60000).toISOString();
    }
    return replace(next);
  }
  const day = selected.occurrenceDate!;
  if (scope === 'one') {
    const next = replace({
      ...base,
      recurrence: {
        ...base.recurrence,
        exceptions: [...new Set([...(base.recurrence.exceptions || []), day])],
      },
    });
    if (patch !== null) {
      next.push({
        ...occurrence(base, day, zone),
        ...patch,
        id: crypto.randomUUID(),
        recurrence: undefined,
        sourceId: undefined,
        occurrenceDate: undefined,
      });
    }
    return next;
  }
  const next = replace({ ...base, recurrence: { ...base.recurrence, until: shiftDay(day, -1) } });
  if (patch !== null) {
    next.push({
      ...occurrence(base, day, zone),
      ...patch,
      id: crypto.randomUUID(),
      sourceId: undefined,
      occurrenceDate: undefined,
      recurrence: {
        ...base.recurrence,
        exceptions: base.recurrence.exceptions?.filter((date) => date >= day),
      },
    });
  }
  return next;
}
