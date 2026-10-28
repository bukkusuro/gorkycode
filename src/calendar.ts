export type Recurrence = {
  frequency: 'daily' | 'weekly' | 'monthly';
  weekdays?: number[];
  until?: string;
  ordinal?: number;
  exceptions?: string[];
};

export type Entry = {
  id: string;
  title: string;
  type: 'task' | 'meeting' | 'event';
  date: string;
  time: string;
  duration: number;
  color: string;
  important: boolean;
  description: string;
  comment?: string;
  completed?: boolean;
  startAt?: string;
  endAt?: string;
  allDay?: boolean;
  atTime?: boolean;
  recurrence?: Recurrence;
  sourceId?: string;
  occurrenceDate?: string;
  operationId?: string;
  importKey?: string;
  importedAt?: string;
  deadline?: string;
  completedAt?: string;
  activityAt?: string;
};

export const colors = ['#ddd8f5', '#d8eae2', '#f7e5cf', '#d7e7f8', '#f2dce1'];
export const entryTypes = {
  task: { label: 'Задача', plural: 'Задачи', color: colors[0] },
  meeting: { label: 'Встреча', plural: 'Встречи', color: colors[1] },
  event: { label: 'Событие', plural: 'События', color: colors[2] },
} as const;
export function entryColor(
  type: Entry['type'],
  prefs: { taskColor: string; meetingColor: string; eventColor: string },
) {
  return prefs[`${type}Color`];
}
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
export const validTime = (value: unknown): value is string =>
  typeof value === 'string' && timePattern.test(value);
export const validColor = (value: unknown): value is string =>
  typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);

export function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function fromKey(key: string) {
  return new Date(`${key}T12:00:00`);
}

export function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function weekStart(date: Date) {
  return addDays(date, -(date.getDay() + 6) % 7);
}

export function minutes(time: string) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
export function formatDate(date: Date, options: Intl.DateTimeFormatOptions) {
  if (!Number.isFinite(+date)) return date.toLocaleDateString('ru-RU', options);
  const key = JSON.stringify(options);
  let formatter = dateFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('ru-RU', options);
    if (dateFormatters.size >= 32) dateFormatters.delete(dateFormatters.keys().next().value!);
    dateFormatters.set(key, formatter);
  }
  return formatter.format(date);
}

export function validEntry(value: unknown): value is Entry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Entry;
  if (
    v.deadline !== undefined &&
    (typeof v.deadline !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(v.deadline) ||
      dateKey(fromKey(v.deadline)) !== v.deadline)
  )
    return false;
  for (const stamp of [v.completedAt, v.activityAt])
    if (stamp !== undefined && (typeof stamp !== 'string' || !Number.isFinite(Date.parse(stamp))))
      return false;
  if (typeof v.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.date)) return false;
  const date = fromKey(v.date);
  if (!(
    typeof v.id === 'string' &&
    typeof v.title === 'string' &&
    v.title.trim().length > 0 &&
    Object.hasOwn(entryTypes, v.type) &&
    Number.isFinite(+date) &&
    dateKey(date) === v.date &&
    validTime(v.time) &&
    Number.isFinite(v.duration) &&
    (v.atTime ? !v.allDay && v.duration === 0 : v.duration >= 5) &&
    v.duration <= 5256000 &&
    validColor(v.color) &&
    typeof v.important === 'boolean' &&
    (typeof v.description === 'string' || typeof v.comment === 'string') &&
    (v.completed === undefined || typeof v.completed === 'boolean') &&
    (v.atTime === undefined || typeof v.atTime === 'boolean')
  ))
    return false;
  if (v.atTime)
    return (
      v.endAt === undefined && (v.startAt === undefined || Number.isFinite(Date.parse(v.startAt)))
    );
  if (v.startAt === undefined) return true;
  const start = Date.parse(v.startAt),
    end = Date.parse(v.endAt || '');
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

export const helpText =
  'Я понимаю команды:\nзадача Название; сегодня; 14:00\nвстреча Название; завтра; 10:00\nсобытие Название; 2026-12-31; 18:00\nВместо «сегодня» можно указать дату ГГГГ-ММ-ДД. Запись привязана только к указанному времени. При необходимости добавьте длительность в минутах или дату и время окончания. Добавьте «; важно» для важной записи. Команда «помощь» покажет эту подсказку.';

export function parseCommand(
  input: string,
  today = dateKey(new Date()),
): { entry?: Entry; end?: { date: string; time: string }; reply: string } {
  const command = input.trim();
  if (/^(помощь|help|команды)$/i.test(command)) return { reply: helpText };
  const match = command.match(
    /^(задача|встреча|событие)\s+([^;]+);\s*([^;]+);\s*([^;]+)(?:;\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}|\d+))?(?:;\s*(важно))?$/i,
  );
  if (!match)
    return {
      reply:
        'Пока я работаю только с командами и не умею понимать свободные запросы.\n\n' + helpText,
    };
  const [, type, title, day, time, duration, important] = match;
  const key = day.trim().toLowerCase();
  const entryType =
    type.toLowerCase() === 'задача'
      ? 'task'
      : type.toLowerCase() === 'встреча'
        ? 'meeting'
        : 'event';
  const [endDate, endTime] = duration?.includes('-') ? duration.trim().split(/\s+/) : [];
  const end = endDate ? { date: endDate, time: endTime } : undefined;
  const entry: Entry = {
    id: crypto.randomUUID(),
    title: title.trim(),
    type: entryType,
    date: key === 'сегодня' ? today : key === 'завтра' ? dateKey(addDays(fromKey(today), 1)) : key,
    time: time.trim(),
    duration: end ? 60 : duration ? Number(duration) : 0,
    atTime: !duration,
    important: !!important,
    color: entryTypes[entryType].color,
    description: '',
  };
  if (end) {
    if (dateKey(fromKey(end.date)) !== end.date || !validTime(end.time)) {
      return { reply: 'Проверьте дату и время окончания.' };
    }
    entry.duration =
      (Date.parse(`${end.date}T${end.time}:00Z`) - Date.parse(`${entry.date}T${entry.time}:00Z`)) /
      60000;
  }
  if (!validEntry(entry))
    return {
      reply: 'Проверьте дату (ГГГГ-ММ-ДД), время (ЧЧ:ММ) и длительность. Минимум — 5 минут.',
    };
  return {
    entry,
    end,
    reply: `Готово! ${entryTypes[entry.type].label} «${entry.title}» ${entry.type === 'event' ? 'добавлено' : 'добавлена'} на ${formatDate(fromKey(entry.date), { day: 'numeric', month: 'long' })} в ${entry.time}. Нажмите на карточку в календаре, чтобы изменить детали.`,
  };
}
