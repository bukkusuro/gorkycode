import { fromKey, validEntry } from '../calendar.js';
import { displayEntry, wallParts } from '../model.js';
import { expandEntries, shiftDay } from '../recurrence.js';

export function trackCompletion(before: unknown[], after: unknown[], now = new Date()) {
  const index = new Map(before.filter(validEntry).map((e) => [e.id, e]));
  return after.map((row) => {
    if (!validEntry(row) || row.type !== 'task') return row;
    const old = index.get(row.id);
    // Recurrence detachment makes a new ID; it is still a real completion action.
    if (old ? !!old.completed === !!row.completed : !row.completed) return row;
    return {
      ...row,
      activityAt: now.toISOString(),
      completedAt: row.completed ? now.toISOString() : undefined,
    };
  });
}
export function productivity(records: unknown[], zone: string, now = new Date()) {
  const today = wallParts(now, zone).date,
    first = shiftDay(today, -13),
    weekStart = shiftDay(today, -6);
  const valid = records.filter(validEntry).filter((e) => e.type === 'task');
  // Bundled/demo CSV entries and their historic auto-completion are not evidence of user behaviour.
  const genuine = valid.filter((e) => !e.importKey || e.activityAt);
  const tasks = expandEntries(genuine, first, today, zone)
    .map((e) => displayEntry(e, zone))
    .filter((e) => e.date >= first && e.date <= today);
  const summarize = (start: string, end: string) => {
    const planned = tasks.filter((e) => e.date >= start && e.date <= end),
      done = planned.filter((e) => e.completed).length;
    return {
      start,
      end,
      total: planned.length,
      done,
      percent: planned.length ? Math.round((done / planned.length) * 100) : null,
    };
  };
  const days = [
    'Понедельник',
    'Вторник',
    'Среда',
    'Четверг',
    'Пятница',
    'Суббота',
    'Воскресенье',
  ].map((label, index) => {
    const weekday = (index + 1) % 7;
    const scheduled = tasks.filter((e) => fromKey(e.date).getDay() === weekday);
    const completed = genuine.filter((e) => {
      if (!e.completed || !e.completedAt) return false;
      const day = wallParts(e.completedAt, zone).date;
      return day >= first && day <= today && fromKey(day).getDay() === weekday;
    }).length;
    return {
      label,
      completed,
      planned: scheduled.length,
      unfinished: scheduled.filter((e) => !e.completed).length,
    };
  });
  const datedCompletions = days.reduce((n, d) => n + d.completed, 0);
  const best = [...days].sort((a, b) => b.completed - a.completed),
    worst = [...days].sort((a, b) => b.unfinished - a.unfinished);
  const recommendations: string[] = [];
  if (datedCompletions >= 5 && best[0].completed >= 2 && best[0].completed > best[2].completed) {
    const leaders = best
      .filter((d) => d.completed === best[0].completed)
      .slice(0, 2)
      .map((d) => d.label.toLowerCase());
    recommendations.push(
      `Больше завершений: ${leaders.join(' и ')}. Планируйте сложные задачи на эти дни.`,
    );
  } else recommendations.push('Пока мало данных. Отмечайте выполненные задачи.');
  if (
    worst[0].planned >= 3 &&
    worst[0].unfinished >= 2 &&
    worst[0].unfinished / worst[0].planned >= 0.5
  )
    recommendations.push(
      `${worst[0].label}: не выполнено ${worst[0].unfinished} из ${worst[0].planned} задач. Снизьте нагрузку на этот день.`,
    );
  const week = summarize(weekStart, today),
    previous = summarize(first, shiftDay(weekStart, -1));
  if (week.percent !== null && week.percent < 50 && week.total >= 3)
    recommendations.push('Выбирайте до трёх главных задач на день и оставляйте запас времени.');
  return {
    first,
    today,
    week,
    previous,
    days,
    datedCompletions,
    recommendations,
    excluded: valid.length - genuine.length,
    undated: genuine.filter((e) => e.completed && !e.completedAt).length,
  };
}
export function productivityText(records: unknown[], zone: string, now = new Date()) {
  const r = productivity(records, zone, now),
    w = r.week,
    p = r.previous;
  return (
    `Отчёт за ${w.start} — ${w.end}: ${w.done} из ${w.total} задач выполнено${w.percent === null ? ' (нет запланированных задач)' : ` (${w.percent}%)`}.\nПредыдущие 7 дней: ${p.done} из ${p.total}${p.percent === null ? '' : ` (${p.percent}%)`}.\n` +
    `Дни завершения за две недели (${r.datedCompletions} с известным временем):\n` +
    r.days
      .map(
        (d) =>
          `${d.label}: завершено ${d.completed}; осталось из запланированных — ${d.unfinished}.`,
      )
      .join('\n') +
    '\n' +
    r.recommendations.join('\n') +
    '\nПроцент считается по текущему состоянию задач, запланированных на период. Дни завершения — по фактическому времени отметки.' +
    (r.excluded ? `\nИмпортированные записи без новых отметок исключены: ${r.excluded}.` : '') +
    (r.undated
      ? `\nСтарые выполненные задачи без времени завершения (${r.undated}) не участвуют в сравнении дней.`
      : '')
  );
}
