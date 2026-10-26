import { type Entry, entryColor, validEntry } from './calendar.js';
import { type Preferences, displayEntry, endParts } from './model.js';
import { changeOccurrence, nextOccurrence, shiftDay, validRecurrence } from './recurrence.js';

export function applyTypeColors(
  records: unknown[],
  prefs: Preferences,
  types: Entry['type'][] = ['task', 'meeting', 'event'],
) {
  return records.map((entry) => {
    if (!validEntry(entry) || !types.includes(entry.type)) return entry;
    const color = entryColor(entry.type, prefs);
    return entry.color === color ? entry : { ...entry, color };
  });
}

export function completePastTasks(
  records: unknown[],
  cutoff = '2026-10-20',
  zone = 'Europe/Moscow',
) {
  const ended = (entry: Entry) => {
    const end = endParts(displayEntry(entry, zone));
    const finish = `${end.date}T${end.time}`,
      boundary = `${cutoff}T00:00`;
    return entry.atTime ? finish < boundary : finish <= boundary;
  };
  let next = records.map((entry) =>
    validEntry(entry) &&
    entry.type === 'task' &&
    !entry.completed &&
    !entry.recurrence &&
    ended(entry)
      ? { ...entry, completed: true }
      : entry,
  );
  for (const entry of records) {
    if (
      !validEntry(entry) ||
      entry.type !== 'task' ||
      entry.completed ||
      !entry.recurrence ||
      !validRecurrence(entry.recurrence)
    )
      continue;
    const first = nextOccurrence(entry, entry.date, zone);
    if (!first || !ended(first)) continue;
    let future = nextOccurrence(
      entry,
      shiftDay(cutoff, -Math.ceil(entry.duration / 1440) - 1),
      zone,
    );
    while (future && ended(future)) future = nextOccurrence(entry, shiftDay(future.date, 1), zone);
    if (future) next = changeOccurrence(next, future, { completed: false }, 'future', zone);
    next = next.map((row) =>
      validEntry(row) && row.id === entry.id ? { ...row, completed: true } : row,
    );
  }
  return next;
}

export function importedEntriesAtTime(records: unknown[]) {
  return records.map((entry) =>
    validEntry(entry) && entry.importKey
      ? { ...entry, atTime: true, allDay: false, duration: 0, endAt: undefined }
      : entry,
  );
}
