import type { Command, Fields } from '../assistantTypes.js';
import { type Entry, entryColor, minutes, validEntry } from '../calendar.js';
import {
  type Preferences,
  displayEntry,
  endParts,
  segment,
  toInstant,
  wallParts,
} from '../model.js';
import { changeOccurrence, expandEntries, shiftDay, validDay } from '../recurrence.js';

export type PlanRow = { before?: Entry; after: Entry; suggested: boolean; note: string };
export type PlanProposal = {
  id: string;
  kind: 'create_batch' | 'plan_day';
  createdAt: number;
  snapshot: string;
  preferences: string;
  rows: PlanRow[];
  warnings: string[];
  day: string;
};
const clock = (n: number) =>
  `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
export const planningPreferences = (p: Preferences) =>
  JSON.stringify([p.zone, p.hourStart, p.hourEnd, p.taskColor, p.meetingColor, p.eventColor]);
function hours(p: Preferences) {
  // The default calendar shows 24 hours; planning uses a practical daytime window.
  return p.hourStart === 0 && p.hourEnd === 24
    ? [9 * 60, 18 * 60]
    : [p.hourStart * 60, p.hourEnd * 60];
}
function blocks(entries: Entry[], day: string, zone: string) {
  return expandEntries(entries, shiftDay(day, -1), day, zone)
    .map((e) => displayEntry(e, zone))
    .flatMap((e) => {
      if (e.type === 'task' && e.completed) return [];
      const part = segment(e, day);
      if (!part) return [];
      const start = minutes(part.time);
      return [[start, Math.min(1440, start + (part.atTime ? 30 : part.duration))]];
    })
    .sort((a, b) => a[0] - b[0]);
}
function findSlot(
  entries: Entry[],
  first: string,
  last: string,
  duration: number,
  p: Preferences,
  now: Date,
) {
  const today = wallParts(now, p.zone),
    [open, close] = hours(p);
  for (let day = first, i = 0; day <= last && i < 15; day = shiftDay(day, 1), i++) {
    let cursor = Math.max(
      open,
      day === today.date ? Math.ceil((minutes(today.time) + 5) / 5) * 5 : open,
    );
    for (const [start, end] of [...blocks(entries, day, p.zone), [close, close]]) {
      if (cursor + duration <= Math.min(start, close)) {
        try {
          const at = toInstant(day, clock(cursor), p.zone);
          if (Date.parse(at) > +now) return { date: day, time: clock(cursor) };
        } catch {
          /* Skip nonexistent wall times across a DST change. */
        }
      }
      cursor = Math.max(cursor, end);
    }
  }
}
function scheduled(
  base: Entry,
  date: string,
  time: string,
  duration: number,
  p: Preferences,
): Entry {
  const startAt = toInstant(date, time, p.zone);
  const after = {
    ...base,
    date,
    time,
    duration,
    atTime: false,
    allDay: false,
    startAt,
    endAt: new Date(Date.parse(startAt) + duration * 60000).toISOString(),
  };
  if (!validEntry(after)) throw Error('Не удалось составить корректный план.');
  return after;
}
function makeEntry(fields: Fields, type: Entry['type'], id: string, p: Preferences): Entry {
  return {
    id,
    title: fields.title!.trim(),
    type,
    date: fields.date || '',
    time: fields.time || '09:00',
    duration: fields.duration || 30,
    color: entryColor(type, p),
    important: fields.important || false,
    description: fields.comment || '',
    completed: false,
    deadline: fields.deadline,
  };
}
export function proposePlan(
  command: Command,
  records: unknown[],
  p: Preferences,
  requestId: string,
  now = new Date(),
): PlanProposal {
  const entries = records.filter(validEntry),
    today = wallParts(now, p.zone).date;
  const day = command.start || today;
  if (!validDay(day) || day < today) throw Error('Выберите сегодняшний или любой будущий день.');
  const proposal: PlanProposal = {
    id: requestId,
    kind: command.intent as PlanProposal['kind'],
    createdAt: +now,
    snapshot: JSON.stringify(records),
    preferences: planningPreferences(p),
    rows: [],
    warnings: [],
    day,
  };
  let busy = entries.slice();
  if (command.intent === 'create_batch') {
    if (!command.items?.length) throw Error('Не удалось выделить задачи. Перечислите их ещё раз.');
    const ordered = [...command.items.entries()].sort(
      ([, a], [, b]) =>
        Number(!!(b.fields.date && b.fields.time)) - Number(!!(a.fields.date && a.fields.time)) ||
        Number(!!b.fields.date) - Number(!!a.fields.date) ||
        (a.fields.deadline || '9999').localeCompare(b.fields.deadline || '9999') ||
        Number(!!b.fields.important) - Number(!!a.fields.important),
    );
    for (const [index, item] of ordered) {
      const f = item.fields,
        base = makeEntry(f, item.type, `plan-${requestId}-${index}`, p);
      if (f.recurrence || f.allDay || f.endDate || f.endTime)
        throw Error(
          'Для списка используйте обычные записи с длительностью. Повторения и записи на весь день добавляйте отдельно.',
        );
      if (f.date && f.date < today) throw Error(`Дата «${base.title}» уже прошла. Уточните срок.`);
      if (f.deadline && f.deadline < today)
        throw Error(`Срок «${base.title}» уже прошёл. Уточните его.`);
      const duration = f.duration || 30;
      let slot;
      if (f.date && f.time) {
        if (Date.parse(toInstant(f.date, f.time, p.zone)) <= +now)
          throw Error(`Время «${base.title}» уже прошло.`);
        const start = minutes(f.time),
          end = start + duration;
        if (end > 1440 || blocks(busy, f.date, p.zone).some(([a, b]) => start < b && a < end))
          throw Error(
            `«${base.title}» пересекается с другой записью. Уточните время и отправьте список снова.`,
          );
        slot = { date: f.date, time: f.time };
      } else {
        if (item.type !== 'task') throw Error(`Укажите дату и время для «${base.title}».`);
        const first = f.date || today,
          last =
            f.date ||
            (f.deadline && f.deadline < shiftDay(today, 7) ? f.deadline : shiftDay(today, 7));
        slot = findSlot(busy, first, last, duration, p, now);
        if (f.time) {
          const start = minutes(f.time);
          slot = undefined;
          for (let date = first; date <= last; date = shiftDay(date, 1)) {
            if (
              Date.parse(toInstant(date, f.time, p.zone)) > +now &&
              start + duration <= 1440 &&
              !blocks(busy, date, p.zone).some(([a, b]) => start < b && a < start + duration)
            ) {
              slot = { date, time: f.time };
              break;
            }
          }
        }
      }
      if (!slot)
        throw Error(
          `Для «${base.title}» нет свободного интервала. Уточните дату или длительность.`,
        );
      if (f.deadline && slot.date > f.deadline)
        throw Error(`«${base.title}» не укладывается в указанный срок.`);
      const after = scheduled(base, slot.date, slot.time, duration, p);
      proposal.rows.push({
        after,
        suggested: !f.date || !f.time || !f.duration,
        note: [
          !f.date ? 'Дата предложена' : '',
          !f.time ? 'Время предложено' : '',
          !f.duration ? 'Оценка: 30 мин.' : '',
        ]
          .filter(Boolean)
          .join(' · '),
      });
      busy.push(after);
    }
    proposal.rows.sort(
      (a, b) => Number(a.after.id.split('-').at(-1)) - Number(b.after.id.split('-').at(-1)),
    );
  } else if (command.intent === 'plan_day') {
    const pool = expandEntries(entries, day, day, p.zone)
      .map((e) => displayEntry(e, p.zone))
      .filter((e) => e.type === 'task' && !e.completed && e.date === day);
    const movable = pool.filter(
      (e) =>
        e.allDay ||
        e.atTime ||
        Date.parse(e.endAt || toInstant(endParts(e).date, endParts(e).time, p.zone)) > +now,
    );
    if (movable.length > 100) throw Error('На день больше 100 задач. Сначала сократите список.');
    const candidateIds = new Set(movable.map((e) => e.id));
    if (command.priorities?.some((id) => !candidateIds.has(id)))
      throw Error('ИИ выбрал задачу за пределами этого дня. Повторите запрос.');
    const ranks = new Map(command.priorities?.map((id, i) => [id, i]));
    movable.sort(
      (a, b) =>
        Number(b.important) - Number(a.important) ||
        (a.deadline || '9999').localeCompare(b.deadline || '9999') ||
        (ranks.get(a.id) ?? 1000) - (ranks.get(b.id) ?? 1000) ||
        a.time.localeCompare(b.time),
    );
    // Rebuild if something cannot fit: its original interval must stay reserved.
    const fixed = expandEntries(entries, shiftDay(day, -1), shiftDay(day, 7), p.zone)
      .filter((e) => !candidateIds.has(e.id))
      .map((e) => ({ ...e, recurrence: undefined }));
    const retained = new Set<string>();
    for (let pass = 0; pass <= movable.length; pass++) {
      busy = [
        ...fixed,
        ...movable.filter((e) => retained.has(e.id)).map((e) => ({ ...e, recurrence: undefined })),
      ];
      proposal.rows = [];
      let retry = false;
      for (const before of movable) {
        if (retained.has(before.id)) continue;
        const duration = before.allDay || before.atTime ? 30 : before.duration;
        const limit =
          before.deadline && before.deadline < shiftDay(day, 7)
            ? before.deadline
            : shiftDay(day, 7);
        const slot = findSlot(busy, day, limit, duration, p, now);
        if (!slot) {
          retained.add(before.id);
          proposal.warnings.push(
            `«${before.title}»: нет места${before.deadline ? ' до срока ' + before.deadline : ' в ближайшие 7 дней'}. Запись останется на прежнем месте.`,
          );
          retry = true;
          break;
        }
        const after = scheduled(before, slot.date, slot.time, duration, p);
        proposal.rows.push({
          before,
          after,
          suggested: true,
          note: `${before.important ? 'Важная задача · ' : ''}${slot.date !== day ? 'Перенос на другой день · ' : ''}${before.allDay || before.atTime ? 'Оценка: 30 мин.' : 'Длительность сохранена'}`,
        });
        busy.push({ ...after, recurrence: undefined });
      }
      if (!retry) break;
    }
    if (pool.length !== movable.length)
      proposal.warnings.push('Уже закончившиеся интервалы задач оставлены без изменений.');
    proposal.warnings.unshift(
      'Встречи, события и выполненные задачи остаются на месте. Меняется только выбранное повторение задачи.',
    );
  } else throw Error('Неподдерживаемый план.');
  const [open, close] = hours(p);
  proposal.warnings.push(
    `Интервал планирования: ${clock(open)}–${close === 1440 ? '24:00' : clock(close)} (${p.zone}). Длительность без оценки — 30 минут.`,
  );
  return proposal;
}
export function applyPlan(
  proposal: PlanProposal,
  records: unknown[],
  p: Preferences,
  now = new Date(),
) {
  if (
    +now - proposal.createdAt > 30 * 60000 ||
    +now < proposal.createdAt ||
    JSON.stringify(records) !== proposal.snapshot ||
    planningPreferences(p) !== proposal.preferences
  )
    throw Error(
      'Календарь или настройки изменились либо план устарел. Попросите Воксу составить новый план.',
    );
  if (!proposal.rows.length) throw Error('В плане нет изменений.');
  if (proposal.rows.some((row) => Date.parse(row.after.startAt!) <= +now))
    throw Error('Время начала уже прошло. Попросите составить новый план.');
  let next = records.slice();
  for (const row of proposal.rows) {
    if (!validEntry(row.after)) throw Error('Некорректная запись плана.');
    if (row.before) {
      const { date, time, duration, atTime, allDay, startAt, endAt } = row.after;
      next = changeOccurrence(
        next,
        row.before,
        { date, time, duration, atTime, allDay, startAt, endAt },
        row.before.sourceId ? 'one' : 'all',
        p.zone,
      );
    } else {
      if (next.some((e) => validEntry(e) && e.id === row.after.id))
        throw Error('Этот план уже применён.');
      next.push(row.after);
    }
  }
  return next;
}
export function describePlan(proposal: PlanProposal) {
  return (
    `${proposal.kind === 'plan_day' ? 'Предлагаю перестроить день' : 'Предлагаю добавить записи'}. Проверьте план и подтвердите изменения.\n` +
    proposal.rows
      .map(
        (row, i) =>
          `${i + 1}. ${row.after.important ? 'Важно: ' : ''}${row.after.title} · ${row.after.date} ${row.after.time} · ${row.after.duration} мин.${row.after.deadline ? ' · срок ' + row.after.deadline : ''}${row.before ? ` (было: ${row.before.date} ${row.before.allDay ? 'без времени' : row.before.time})` : ''}\n${row.note}`,
      )
      .join('\n') +
    '\n' +
    proposal.warnings.join('\n')
  );
}
