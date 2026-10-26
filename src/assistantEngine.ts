import { guardCalendarRequest, normalizeCalendarText } from './assistantPolicy.js';
import { type Command, type Context, type Fields, validateCommand } from './assistantTypes.js';
import { type Entry, entryColor, entryTypes, validEntry } from './calendar.js';
import { temporal } from './localInterpreter.js';
import {
  type Preferences,
  commentOf,
  displayEntry,
  segment,
  toInstant,
  wallParts,
} from './model.js';
import { isNumericInput, numericParts } from './numericInput.js';
import { changeOccurrence, expandEntries, nextOccurrence, validRecurrence } from './recurrence.js';
export type Outcome = {
  reply: string;
  context: Context;
  records?: unknown[];
  entries?: Entry[];
  openId?: string;
  numericChoiceId?: string;
};
export type Interpreter = (
  text: string,
  context: Context,
  prefs: Preferences,
  now: Date,
) => Command | Promise<Command>;
const ignoredWords = new Set([
  'про',
  'по',
  'на',
  'задачу',
  'задача',
  'встречу',
  'встреча',
  'событие',
  'события',
  'событию',
  'событием',
  'мне',
  'задаче',
  'к',
  'с',
  'у',
]);
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !ignoredWords.has(w))
    .map((w) => w.replace(/(?:иями|ами|ого|ему|ию|ия|ую|ой|ом|а|у|е|ы|и)$/u, ''));
const searchWords = new WeakMap<Entry, { text: string; words: string[] }>();
function queryMatcher(query: string) {
  const words = norm(query);
  return (e: Entry) => {
    const text = `${e.title} ${commentOf(e)}`;
    let cached = searchWords.get(e);
    if (!cached || cached.text !== text) {
      cached = { text, words: norm(text) };
      searchWords.set(e, cached);
    }
    const hay = cached.words;
    return words.every((q) => hay.some((w) => w.startsWith(q) || q.startsWith(w)));
  };
}
export function matches(e: Entry, query: string) {
  return queryMatcher(query)(e);
}
export function selectEntries(
  entries: Entry[],
  command: Pick<Command, 'query' | 'type' | 'start' | 'end' | 'time' | 'incomplete'>,
  zone: string,
) {
  const match = command.query ? queryMatcher(command.query) : () => true;
  const matching = entries.filter(
    (entry) =>
      (!command.type || entry.type === command.type) &&
      (!command.incomplete || (entry.type === 'task' && !entry.completed)) &&
      match(entry),
  );
  const source = command.start
    ? expandEntries(matching, command.start, command.end || command.start, zone)
    : matching;
  return source
    .map((entry) => displayEntry(entry, zone))
    .filter(
      (entry) =>
        (!command.time || (!entry.allDay && entry.time === command.time)) &&
        (!command.start ||
          (!command.time && !!segment(entry, command.start)) ||
          (entry.date >= command.start && entry.date <= (command.end || command.start))) &&
        (command.start || !command.end || entry.date <= command.end),
    );
}
export const describe = (e: Entry) =>
  `${entryTypes[e.type].label} «${e.title}» · ${e.date}${e.allDay ? ' · без времени' : ` · ${e.time}`}${e.type === 'task' ? (e.completed ? ' · выполнено' : ' · не выполнено') : ''}${e.recurrence ? ' · повторяется' : ''}`;
function resolve(entries: Entry[], id: string | undefined, zone: string): Entry | undefined {
  if (!id) return;
  const direct = entries.find((e) => e.id === id);
  if (direct) return displayEntry(direct, zone);
  const base = entries.find((e) => id.startsWith(`${e.id}@`));
  const day = base && id.slice(base.id.length + 1);
  if (base?.recurrence && day) {
    const found = expandEntries([base], day, day, zone).find((e) => e.id === id);
    return found && displayEntry(found, zone);
  }
}
function applyFields(
  base: Entry,
  fields: Fields,
  preferences: Preferences,
  creating = false,
): Entry {
  const next = { ...base };
  for (const key of [
    'title',
    'date',
    'time',
    'duration',
    'important',
    'color',
    'allDay',
    'recurrence',
  ] as const)
    if (fields[key] !== undefined) Object.assign(next, { [key]: fields[key] });
  if (base.allDay && fields.time && !fields.duration) next.duration = 60;
  if (fields.comment !== undefined) {
    next.comment = fields.comment;
    next.description = fields.comment;
  }
  if (next.allDay) {
    next.atTime = false;
    next.time = '00:00';
    next.duration = 1440;
    delete next.startAt;
    delete next.endAt;
  } else if (next.atTime && fields.duration === undefined && fields.endTime === undefined) {
    next.duration = 0;
    if (creating || base.startAt) next.startAt = toInstant(next.date, next.time, preferences.zone);
    delete next.endAt;
  } else if (creating || base.startAt) {
    if (next.atTime) next.atTime = false;
    next.startAt = toInstant(next.date, next.time, preferences.zone);
    next.endAt = fields.endTime
      ? toInstant(fields.endDate || next.date, fields.endTime, preferences.zone)
      : new Date(Date.parse(next.startAt) + next.duration * 60000).toISOString();
    next.duration = (Date.parse(next.endAt) - Date.parse(next.startAt)) / 60000;
  } else if (fields.endTime) {
    if (next.atTime) next.atTime = false;
    next.duration =
      (Date.parse(`${fields.endDate || next.date}T${fields.endTime}:00Z`) -
        Date.parse(`${next.date}T${next.time}:00Z`)) /
      60000;
  } else if (next.atTime && fields.duration !== undefined) next.atTime = false;
  if (next.type !== 'task' && next.allDay)
    throw Error(
      next.type === 'meeting'
        ? 'Для встречи укажите точное время.'
        : 'Для события укажите точное время.',
    );
  if (!validEntry(next)) throw Error('Проверьте дату, время и продолжительность записи.');
  if (
    next.recurrence &&
    (!validRecurrence(next.recurrence) ||
      (next.recurrence.until && next.recurrence.until < next.date))
  )
    throw Error('Проверьте правило и окончание повторения.');
  return next;
}
export function executeCommand(
  raw: unknown,
  records: unknown[],
  previous: Context,
  preferences: Preferences,
  requestId: string,
  userText: string,
  now = new Date(),
): Outcome {
  if (previous.updatedAt && +now - previous.updatedAt > 30 * 60000) previous = {};
  const parsed = validateCommand(raw);
  const targeting = [
    'complete_task',
    'reopen_task',
    'open_event',
    'delete_event',
    'search_events',
    'list_events',
  ].includes(parsed.intent);
  const command = targeting
    ? {
        ...parsed,
        start: parsed.start || parsed.fields?.date,
        end: parsed.end || parsed.fields?.date,
        time: parsed.time || parsed.fields?.time,
      }
    : parsed;
  const entries = records.filter(validEntry);
  const context: Context = { ...previous, updatedAt: +now };
  const reply = (text: string, extra: Partial<Outcome> = {}): Outcome => ({
    reply: text,
    context,
    ...extra,
  });
  if (command.intent === 'cancel_action') {
    return { reply: 'Действие отменено. Записи не изменены.', context: { updatedAt: +now } };
  }
  if (command.intent === 'answer_question')
    return {
      reply: command.answer || 'Уточните, что нужно сделать.',
      context: { ...context, confirmation: undefined },
    };
  if (command.intent === 'confirm_action') {
    if (!/^(да|подтверждаю|удалить)[.!]?$/iu.test(userText.trim()))
      return reply('Подтвердите удаление словом «Да» или отмените словом «Нет».');
    const pending = context.confirmation;
    if (!pending) return reply('Нет действия, ожидающего подтверждения.');
    const selected = resolve(entries, pending.id, preferences.zone),
      base = selected && entries.find((e) => e.id === (selected.sourceId || selected.id));
    context.confirmation = undefined;
    if (!selected || JSON.stringify(base) !== pending.snapshot)
      return reply('Запись изменилась или удалена. Повторите запрос на удаление.');
    const next = changeOccurrence(
      records,
      selected,
      null,
      pending.command.scope || 'all',
      preferences.zone,
    );
    context.lastId = undefined;
    context.resultIds = undefined;
    context.pending = undefined;
    return reply('Запись удалена.', { records: next });
  }
  context.confirmation = undefined;
  context.numeric = undefined;
  context.pending = undefined;
  context.candidates = undefined;
  context.awaitingScope = undefined;
  if (
    ['create_task', 'create_meeting', 'create_event', 'create_recurrence'].includes(command.intent)
  ) {
    context.resultIds = undefined;
    context.lastId = undefined;
    const exists = entries.find((e) => e.operationId === requestId);
    if (exists) return reply('Этот запрос уже сохранён.', { entries: [exists] });
    const fields = command.fields || {},
      type =
        command.intent === 'create_event'
          ? 'event'
          : command.intent === 'create_meeting'
            ? 'meeting'
            : command.type || 'task';
    const ask = (question: string) => {
      context.pending = command;
      return reply(question);
    };
    if (!fields.title?.trim() || /^(встреча|встречу|задача|задачу|событие)$/iu.test(fields.title))
      return ask(
        type === 'meeting'
          ? 'С кем или по какому поводу встреча?'
          : type === 'event'
            ? 'Как называется событие?'
            : 'Как называется задача?',
      );
    if (!fields.date) return ask('На какую дату запланировать запись?');
    if (type !== 'task' && !fields.time)
      return ask(
        type === 'meeting'
          ? 'На какое время назначить встречу?'
          : 'На какое время назначить событие?',
      );
    if (command.intent === 'create_recurrence' && !fields.recurrence)
      return ask('Как повторять запись: ежедневно, еженедельно или ежемесячно?');
    const allDay = type === 'task' && !fields.time;
    const atTime = !allDay && fields.duration === undefined && fields.endTime === undefined;
    const e = applyFields(
      {
        id: `ai-${requestId}`,
        title: fields.title,
        type,
        date: fields.date,
        time: fields.time || '00:00',
        duration: atTime ? 0 : fields.duration || 60,
        atTime,
        description: '',
        color: entryColor(type, preferences),
        important: false,
        completed: false,
        allDay,
        operationId: requestId,
      },
      fields,
      preferences,
      true,
    );
    const created = e.recurrence ? nextOccurrence(e, e.date, preferences.zone) || e : e;
    context.lastId = created.id;
    return reply(`Сохранено: ${describe(created)}.`, {
      records: [...records, e],
      entries: [created],
    });
  }
  if (command.intent === 'list_events' || command.intent === 'search_events') {
    const today = wallParts(now, preferences.zone).date;
    const pool = selectEntries(entries, command, preferences.zone);
    pool.sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
    if (command.free) {
      const day = command.start || today;
      if (command.end && command.end !== day)
        return reply('Для поиска свободного времени выберите один день.');
      const busy = pool
        .filter((e) => e.type !== 'task' && !e.allDay && !e.atTime)
        .map((e) => segment(e, day))
        .filter((e): e is Entry => !!e)
        .map((e) => {
          const [h, m] = e.time.split(':').map(Number);
          return [h * 60 + m, h * 60 + m + e.duration];
        })
        .sort((a, b) => a[0] - b[0]);
      let cursor = preferences.hourStart * 60;
      const slots: string[] = [];
      const clock = (n: number) =>
        `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
      for (const [a, b] of busy) {
        if (a > cursor)
          slots.push(`${clock(cursor)}–${clock(Math.min(a, preferences.hourEnd * 60))}`);
        cursor = Math.max(cursor, b);
        if (cursor >= preferences.hourEnd * 60) break;
      }
      if (cursor < preferences.hourEnd * 60)
        slots.push(`${clock(cursor)}–${clock(preferences.hourEnd * 60)}`);
      return reply(
        `Свободное время ${day} (${preferences.zone}): ${slots.join(', ') || 'в рабочем интервале нет'}.`,
      );
    }
    const visible = pool.slice(0, 100);
    context.resultIds = visible.map((e) => e.id);
    context.lastId = pool.length === 1 ? pool[0].id : undefined;
    return reply(
      pool.length
        ? visible.map((e, i) => `${i + 1}. ${describe(e)}`).join('\n') +
            (pool.length > 100 ? '\nПоказаны первые 100 записей; уточните период.' : '')
        : 'На выбранный период или по этому запросу записей нет.',
      { entries: visible },
    );
  }
  let selected = resolve(entries, command.id, preferences.zone);
  if (command.index)
    selected = resolve(
      entries,
      (previous.candidates || previous.resultIds)?.[command.index - 1],
      preferences.zone,
    );
  const hasSelector = !!(command.query || command.start || command.end || command.time);
  if (!command.index && hasSelector) {
    const source =
      command.time && !command.start && !command.end && previous.resultIds?.length
        ? previous.resultIds
            .map((id) => resolve(entries, id, preferences.zone))
            .filter((entry): entry is Entry => !!entry)
        : entries;
    const pool = selectEntries(
      source,
      {
        ...command,
        type:
          command.type ||
          (['complete_task', 'reopen_task'].includes(command.intent) ? 'task' : undefined),
      },
      preferences.zone,
    );
    selected = pool.find(
      (entry) =>
        entry.id === selected?.id ||
        (selected?.recurrence && !selected.occurrenceDate && entry.sourceId === selected.id),
    );
    if (!selected && pool.length > 1) {
      const visible = pool.slice(0, 100);
      context.lastId = undefined;
      context.pending = command;
      context.candidates = visible.map((e) => e.id);
      context.resultIds = context.candidates;
      return reply(
        'Найдено несколько записей. Укажите номер:\n' +
          visible.map((e, i) => `${i + 1}. ${describe(e)}`).join('\n') +
          (pool.length > 100 ? '\nПоказаны первые 100 записей; уточните дату или время.' : ''),
        { entries: visible },
      );
    }
    selected ||= pool[0];
  }
  if (!selected && !hasSelector && !command.index && !command.id)
    selected = resolve(entries, previous.lastId, preferences.zone);
  if (!selected) {
    context.pending = command;
    if (hasSelector) context.lastId = undefined;
    if (command.start || command.time)
      return reply(
        `Не найдена ${command.type === 'meeting' ? 'встреча' : command.type === 'event' ? 'запись' : 'задача'}${command.start ? ` на ${command.start}` : ''}${command.time ? ` в ${command.time}` : ''}. Уточните дату, время или название.`,
      );
    return reply('Какую именно запись выбрать? Укажите название или номер из последнего списка.');
  }
  if (selected.recurrence && !selected.occurrenceDate) {
    const day = command.fields?.date || wallParts(now, preferences.zone).date;
    const next = nextOccurrence(
      entries.find((e) => e.id === selected!.id)!,
      day,
      preferences.zone,
    );
    if (next) selected = displayEntry(next, preferences.zone);
  }
  context.lastId = selected.id;
  if (command.intent === 'open_event')
    return reply(describe(selected), { openId: selected.id, entries: [selected] });
  if (['complete_task', 'reopen_task'].includes(command.intent) && selected.type !== 'task')
    return reply('Статус выполнения предусмотрен только для задач.');
  const base = entries.find((e) => e.id === (selected!.sourceId || selected!.id))!;
  if (base.recurrence && !command.scope) {
    context.awaitingScope = { ...command, id: selected.id };
    return reply('Изменить только это повторение, это и последующие или всю серию?');
  }
  if (command.intent === 'delete_event') {
    context.confirmation = {
      command: { ...command, id: selected.id },
      id: selected.id,
      snapshot: JSON.stringify(base),
    };
    return reply(
      `Удалить ${describe(selected)}${base.recurrence ? ` (${command.scope === 'one' ? 'только это повторение' : command.scope === 'future' ? 'это и последующие' : 'всю серию'})` : ''}? Ответьте «Да» или «Нет».`,
    );
  }
  let fields = command.fields || {};
  if (
    command.intent === 'update_event' &&
    command.answer === 'comment' &&
    fields.comment === undefined
  ) {
    context.pending = { ...command, id: selected.id };
    return reply('Какой комментарий добавить?');
  }
  const completing = command.intent === 'complete_task' || command.intent === 'reopen_task';
  const patch: Partial<Entry> = {};
  let updated: Entry;
  if (completing) {
    patch.completed = command.intent === 'complete_task';
    updated = { ...selected, ...patch };
  } else {
    if (command.intent !== 'update_event') throw Error('Действие не поддерживается.');
    if (!Object.keys(fields).length) {
      context.pending = { ...command, id: selected.id };
      return reply('Что изменить: дату, время, комментарий, цвет или важность?');
    }
    if (command.answer === 'extend' && fields.duration)
      fields = { ...fields, duration: selected.duration + fields.duration };
    updated = applyFields(selected, fields, preferences);
    for (const k of [
      'title',
      'date',
      'time',
      'duration',
      'color',
      'important',
      'description',
      'comment',
      'allDay',
      'atTime',
      'startAt',
      'endAt',
      'recurrence',
    ] as const)
      if (updated[k] !== selected[k]) Object.assign(patch, { [k]: updated[k] });
  }
  const next = changeOccurrence(records, selected, patch, command.scope || 'all', preferences.zone);
  const ids = new Set(entries.map((e) => e.id));
  const detached = next.find((e): e is Entry => validEntry(e) && !ids.has(e.id));
  const saved = detached || updated;
  context.lastId = saved.id;
  return reply(
    completing
      ? patch.completed
        ? 'Задача отмечена выполненной.'
        : 'Задача возвращена в невыполненные.'
      : `Запись обновлена: ${describe(saved)}.`,
    { records: next, entries: [saved] },
  );
}
const numericQuestion = (field: 'date' | 'time') =>
  field === 'date' ? 'На какую дату?' : 'На какое время?';
const newAction = (text: string, context: Context) =>
  /^(?:создай|создавай|добавь|поставь|запланируй|назначь|напомни|напоминай|перенеси|измени|переименуй|удали|убери|отмени|отметь|пометь|заверши|верни|сними|открой|покажи|найди|что у меня|какие)(?:\s|$)|^(?:нет|отмена|не нужно|забудь|оставь как было)[.!]?$/iu.test(
    normalizeCalendarText(text, context).trim(),
  );
function askNumericTitle(command: Command, previous: Context, now: Date): Outcome {
  return {
    reply:
      command.intent === 'create_meeting'
        ? 'Как называется встреча?'
        : command.intent === 'create_event'
          ? 'Как называется событие?'
          : 'Как называется задача?',
    context: { ...previous, updatedAt: +now, pending: command, numeric: { next: 'title' } },
  };
}
function clarifyNumeric(
  text: string,
  records: unknown[],
  previous: Context,
  preferences: Preferences,
  id: string,
  now: Date,
): Outcome | undefined {
  if (previous.pending?.answer === 'comment' || previous.confirmation || previous.awaitingScope)
    return;
  const input = text.trim(),
    numeric = previous.numeric;
  if (
    previous.pending?.intent.startsWith('create') &&
    /^(?:нет[,\s]|лучше\s|измени (?:дату|время)\s)/iu.test(input)
  ) {
    const corrected = temporal(
      input.replace(/^(?:нет[,\s]+|лучше\s+|измени (?:дату|время)\s+)/iu, ''),
      preferences,
      now,
    ).fields;
    if (corrected.date || corrected.time) {
      const command = { ...previous.pending, fields: { ...previous.pending.fields, ...corrected } };
      const missing = !command.fields.date
        ? 'date'
        : !command.fields.time && !command.fields.allDay
          ? 'time'
          : undefined;
      if (missing)
        return {
          reply: numericQuestion(missing),
          context: { ...previous, updatedAt: +now, pending: command, numeric: { next: missing } },
        };
      return askNumericTitle(command, previous, now);
    }
  }
  if (numeric && 'next' in numeric && numeric.next === 'title') {
    const guarded = guardCalendarRequest(text, previous, +now);
    if (guarded) return executeCommand(guarded, records, previous, preferences, id, text, now);
    if (!previous.pending?.intent.startsWith('create') || newAction(text, previous)) return;
    if (/^(задач[ау]|встреч[ау]|событие)$/iu.test(input))
      return askNumericTitle(previous.pending, previous, now);
    return executeCommand(
      { ...previous.pending, fields: { ...previous.pending.fields, title: input } },
      records,
      previous,
      preferences,
      id,
      text,
      now,
    );
  }
  const choice = input.toLowerCase().match(/^(?:это\s+)?(время|дат[ау])[.!]?$/u),
    selecting = numeric && 'value' in numeric && choice,
    value = selecting ? numeric.value : isNumericInput(input) ? input : undefined;
  if (!value) return;
  if (
    !numeric &&
    previous.pending &&
    /^\d{1,3}$/.test(input) &&
    Number(input) >= 1 &&
    Number(input) <= (previous.candidates?.length || 0)
  )
    return executeCommand(
      { ...previous.pending, index: Number(input) },
      records,
      previous,
      preferences,
      id,
      text,
      now,
    );
  const { date, time } = numericParts(value, wallParts(now, preferences.zone).date),
    context = { ...previous, updatedAt: +now },
    reply = (message: string): Outcome => ({ reply: message, context });
  const kind = selecting
    ? choice[1] === 'время'
      ? 'time'
      : 'date'
    : numeric && 'next' in numeric
      ? numeric.next
      : undefined;
  if (!kind) {
    context.numeric = { value, questionId: id };
    return { ...reply(`«${value}» — это время или дата?`), numericChoiceId: id };
  }
  const first = selecting || (numeric && 'next' in numeric && numeric.first);
  if (kind === 'date' ? !date : !time) {
    if (selecting) context.numeric = { next: kind, first: true };
    return reply(
      kind === 'date'
        ? `«${value}» не является датой. Укажите день и месяц, например 1508 или 15.08.`
        : `«${value}» не является временем. Укажите время от 00:00 до 23:59.`,
    );
  }
  const pending =
      previous.pending ||
      (numeric && 'next' in numeric && !numeric.first && previous.lastId
        ? { intent: 'update_event' as const, id: previous.lastId }
        : { intent: 'create_task' as const }),
    editing = pending.intent.startsWith('create') || pending.intent === 'update_event',
    fields = kind === 'date' ? { date } : { time, allDay: false },
    command: Command = editing
      ? { ...pending, fields: { ...pending.fields, ...fields } }
      : {
          ...pending,
          index: undefined,
          ...(kind === 'date' ? { start: date, end: date } : { time }),
        },
    next = kind === 'date' ? 'time' : 'date',
    hasOther = editing
      ? next === 'time'
        ? command.fields?.time || command.fields?.allDay
        : command.fields?.date
      : next === 'time'
        ? command.time || command.fields?.time
        : command.start || command.fields?.date;
  const creating = command.intent.startsWith('create');
  if (first && (creating || !hasOther)) {
    if (creating) {
      command.fields = {
        ...command.fields,
        [next]: undefined,
        ...(next === 'time' ? { allDay: false } : {}),
      };
      context.lastId = undefined;
      context.resultIds = undefined;
      context.candidates = undefined;
    }
    context.pending = command;
    context.numeric = { next };
    return reply(numericQuestion(next));
  }
  if (creating) return askNumericTitle(command, context, now);
  const result = executeCommand(command, records, context, preferences, id, text, now);
  if (first) result.context.numeric = { next };
  return result;
}
export async function processRequest(
  interpreter: Interpreter,
  text: string,
  records: unknown[],
  context: Context,
  preferences: Preferences,
  id: string,
  now = new Date(),
) {
  if (context.updatedAt && +now - context.updatedAt > 30 * 60000) context = {};
  const numeric = clarifyNumeric(text, records, context, preferences, id, now);
  if (numeric) return numeric;
  const command =
    guardCalendarRequest(text, context, +now) ||
    (await interpreter(text, context, preferences, now));
  if (
    context.numeric &&
    'next' in context.numeric &&
    context.numeric.next !== 'title' &&
    context.pending?.intent.startsWith('create') &&
    command.intent === context.pending.intent &&
    !newAction(text, context)
  ) {
    const kind = context.numeric.next,
      allDay =
        kind === 'time' && command.fields?.allDay && context.pending.intent === 'create_task';
    if (!command.fields?.[kind] && !allDay)
      return { reply: numericQuestion(kind), context: { ...context, updatedAt: +now } };
    const fields = {
      ...context.pending.fields,
      ...(allDay ? { allDay: true, time: undefined } : { [kind]: command.fields![kind] }),
      ...(kind === 'time' && !allDay ? { allDay: false } : {}),
    };
    const pending = validateCommand({ ...context.pending, fields });
    return askNumericTitle(pending, context, now);
  }
  return executeCommand(command, records, context, preferences, id, text, now);
}
