import type { Entry } from '../calendar.js';
import { type Preferences, dateLabel, displayEntry, toInstant, wallParts } from '../model.js';
import { expandEntries, shiftDay } from '../recurrence.js';
export type NativeReminder = {
  key: string;
  at: number;
  expires: number;
  title: string;
  body: string;
  entryId?: string;
  sound: boolean;
};
export function reminderPlan(entries: Entry[], p: Preferences, now = Date.now()): NativeReminder[] {
  if (!p.enabled || !p.background) return [];
  const today = wallParts(new Date(now), p.zone).date,
    end = shiftDay(today, 366),
    expanded = [
      ...entries.filter((e) => !e.recurrence),
      ...expandEntries(
        entries.filter((e) => e.recurrence),
        today,
        end,
        p.zone,
      ),
    ],
    plan: NativeReminder[] = [];
  for (const raw of expanded) {
    const e = displayEntry(raw, p.zone);
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
    if (
      start <= now ||
      !Number.isFinite(start) ||
      (e.importedAt && start < Date.parse(e.importedAt))
    )
      continue;
    plan.push({
      key: `${e.id}:${start}:${p.lead}`,
      at: start - p.lead * 60000,
      expires: start + 3600000,
      title: `${e.important ? '! ' : ''}${e.title}`,
      body: `${dateLabel(e.date, p.dateFormat)} · ${e.time}`,
      entryId: e.id,
      sound: p.sound,
    });
  }
  if (p.daily)
    for (let day = today; day < end; day = shiftDay(day, 1)) {
      const at = Date.parse(toInstant(day, '09:00', p.zone));
      if (at > now)
        plan.push({
          key: `daily:${day}:${p.zone}`,
          at,
          expires: at + 12 * 3600000,
          title: 'ВОКСА — планы на день',
          body: dateLabel(day, p.dateFormat),
          sound: p.sound,
        });
    }
  return plan.sort((a, b) => a.at - b.at);
}
