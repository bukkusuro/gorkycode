import { parseCommand, weekStart, dateKey, fromKey, type Recurrence } from './calendar.js';
import { type Preferences, wallParts } from './model.js';
import type { Command, Context, Fields } from './assistantTypes.js';
import { shiftDay } from './recurrence.js';
import { guardCalendarRequest, normalizeCalendarText } from './assistantPolicy.js';
const weekdays = ['воскресень', 'понедельник', 'вторник', 'сред', 'четверг', 'пятниц', 'суббот'];
const numberWords: Record<string, number> = {
  один: 1,
  одну: 1,
  одна: 1,
  два: 2,
  две: 2,
  три: 3,
  четыре: 4,
  пять: 5,
  шесть: 6,
  семь: 7,
  восемь: 8,
  девять: 9,
  десять: 10,
  двенадцать: 12,
  пятнадцать: 15,
  тридцать: 30,
};
const numberPattern = new RegExp(Object.keys(numberWords).join('|'), 'gu');
const numeric = (s: string) => s.replace(numberPattern, (w) => String(numberWords[w]));
const creationIntent = (type: Command['type']) =>
  type === 'event' ? 'create_event' : type === 'meeting' ? 'create_meeting' : 'create_task';
function clock(hour: string, minute = '00', period?: string) {
  let h = Number(hour);
  if ((period === 'вечера' || period === 'дня') && h < 12) h += 12;
  return `${String(h).padStart(2, '0')}:${minute}`;
}
export function temporal(text: string, prefs: Preferences, now: Date) {
  let rest = text.toLowerCase().replace(/ё/g, 'е');
  const today = wallParts(now, prefs.zone).date,
    day = fromKey(today);
  const fields: Fields = {};
  let start: string | undefined, end: string | undefined, boundary: string | undefined;
  const consume = (re: RegExp, fn: (m: RegExpMatchArray) => void) => {
    const m = rest.match(re);
    if (m) {
      fn(m);
      rest = rest.replace(m[0], ' ');
      return true;
    }
    return false;
  };
  consume(/(\d{4}-\d{2}-\d{2})/u, (m) => {
    fields.date = m[1];
  });
  if (!fields.date)
    consume(/послезавтра|завтра[а-я]*|сегодня[а-я]*|вчера[а-я]*/u, (m) => {
      fields.date = shiftDay(
        today,
        m[0] === 'послезавтра'
          ? 2
          : m[0].startsWith('завтра')
            ? 1
            : m[0].startsWith('вчера')
              ? -1
              : 0,
      );
    });
  consume(/(следующ[а-я]*|прошл[а-я]*|эт[а-я]*)\s+недел[а-я]*/u, (m) => {
    start = shiftDay(
      dateKey(weekStart(day)),
      m[1].startsWith('след') ? 7 : m[1].startsWith('прош') ? -7 : 0,
    );
    end = shiftDay(start, 6);
  });
  consume(/до конца (недели|месяца)/u, (m) => {
    boundary =
      m[1] === 'недели'
        ? shiftDay(dateKey(weekStart(day)), 6)
        : dateKey(new Date(day.getFullYear(), day.getMonth() + 1, 0));
    if (!fields.date) fields.date = boundary;
  });
  const relative = rest.match(/через\s+([а-я]+|\d+)\s+(час[а-я]*|минут[а-я]*|д[а-я]*)/u);
  if (relative) {
    const count = Number(numeric(relative[1]));
    if (Number.isFinite(count)) {
      if (relative[2].startsWith('д')) fields.date = shiftDay(today, count);
      else
        Object.assign(
          fields,
          wallParts(
            new Date(+now + count * (relative[2].startsWith('час') ? 60 : 1) * 60000),
            prefs.zone,
          ),
        );
      rest = rest.replace(relative[0], ' ');
    }
  }
  let recurrence: Recurrence | undefined;
  if (/кажд[а-я]*\s+день|ежедневно/u.test(rest)) {
    recurrence = { frequency: 'daily' };
    rest = rest.replace(/кажд[а-я]*\s+день|ежедневно/u, ' ');
  }
  if (/ежемесячно|кажд[а-я]*\s+месяц/u.test(rest)) {
    recurrence = { frequency: 'monthly' };
    rest = rest.replace(/ежемесячно|кажд[а-я]*\s+месяц/u, ' ');
  }
  const days = weekdays.flatMap((stem, i) => (rest.includes(stem) ? [i] : []));
  if (days.length) {
    const repeating = /кажд[а-я]*|еженедельно/u.test(rest);
    if (repeating) recurrence = { frequency: 'weekly', weekdays: days };
    if (/перв[а-я]*.*месяц/u.test(rest))
      recurrence = { frequency: 'monthly', weekdays: [days[0]], ordinal: 1 };
    if (!fields.date) {
      const dow = day.getDay();
      let delta = (days[0] - dow + 7) % 7;
      if (/следующ[а-я]*/u.test(rest)) delta = ((days[0] + 6) % 7) + 7 - ((dow + 6) % 7);
      fields.date = shiftDay(today, delta);
    }
    for (const stem of weekdays)
      rest = rest.replace(
        new RegExp(
          `(?:(?:в|во|на|к|ко|по)\\s+)?(?:(?:эт[а-я]*|ближайш[а-я]*|кажд[а-я]*|следующ[а-я]*|перв[а-я]*)\\s+)?${stem}[а-я]*`,
          'gu',
        ),
        ' ',
      );
    rest = rest.replace(/месяца|еженедельно/gu, ' ');
  }
  if (/еженедельно/u.test(rest)) {
    recurrence = { frequency: 'weekly' };
    rest = rest.replace(/еженедельно/u, ' ');
  }
  if (recurrence) {
    fields.recurrence = recurrence;
    if (boundary) {
      recurrence.until = boundary;
      if (fields.date === boundary) fields.date = today;
    }
    if (!fields.date) fields.date = today;
  }
  if (recurrence)
    consume(
      /до конца (января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/u,
      (m) => {
        const month = [
          'января',
          'февраля',
          'марта',
          'апреля',
          'мая',
          'июня',
          'июля',
          'августа',
          'сентября',
          'октября',
          'ноября',
          'декабря',
        ].indexOf(m[1]);
        let year = day.getFullYear();
        if (month < day.getMonth()) year++;
        recurrence!.until = dateKey(new Date(year, month + 1, 0));
      },
    );
  consume(/(?:с |в |на |^)(\d{1,2})[:.](\d{2})(?:\s*(утра|вечера|дня|ночи))?/u, (m) => {
    fields.time = clock(m[1], m[2], m[3]);
  });
  if (!fields.time)
    consume(/(?:в |на |^)(\d{1,2})(?:\s*(утра|вечера|дня|ночи))?(?=\s|$|[?.,])/u, (m) => {
      fields.time = clock(m[1], '00', m[2]);
    });
  consume(/до\s+(\d{1,2}):(\d{2})(?:\s*(следующего дня))?/u, (m) => {
    fields.endTime = `${m[1].padStart(2, '0')}:${m[2]}`;
    fields.endDate = fields.date;
    if (fields.date && (m[3] || (fields.time && fields.endTime <= fields.time)))
      fields.endDate = shiftDay(fields.date, 1);
  });
  consume(/на\s+полчаса/u, () => {
    fields.duration = 30;
  });
  consume(/(?:на |продолжительностью )([а-я]+|\d+)\s+(час[а-я]*|минут[а-я]*)/u, (m) => {
    const n = Number(numeric(m[1]));
    if (Number.isFinite(n)) fields.duration = n * (m[2].startsWith('час') ? 60 : 1);
  });
  const priority = rest.match(
    /(?:^|\s)(не\s+)?(?:важн[а-я]*|срочн[а-я]*|дедлайн[а-я]*)(?=\s|[,.!?;]|$)/u,
  );
  if (priority) {
    fields.important = !priority[1];
    rest = rest.replace(priority[0], ' ');
  }
  const color = rest.match(/зелен[а-я]*|красн[а-я]*|син[а-я]*|#[\da-f]{6}/u);
  if (color) {
    fields.color = color[0].startsWith('#')
      ? color[0]
      : color[0].startsWith('зелен')
        ? '#d8eae2'
        : color[0].startsWith('красн')
          ? '#f2dce1'
          : '#d7e7f8';
    rest = rest.replace(color[0], ' ');
  }
  if (/без времени|весь день/u.test(rest)) {
    fields.allDay = true;
    rest = rest.replace(/без времени|весь день/gu, ' ');
  }
  if (fields.time) fields.allDay = false;
  return { fields: fields, rest: rest.replace(/\s+/g, ' ').trim(), start, end };
}
export const localHelp =
  'Я работаю в локальном режиме: понимаю распространённые запросы о задачах, встречах и событиях, но могу попросить уточнение.\nНапример: «Напомни завтра в 10 утра позвонить Ивану», «Создай событие концерт завтра в 19:00», «Что у меня на следующей неделе?», «Найди задачу про презентацию», «Перенеси её на завтра». Удаление — только после подтверждения. Для произвольных формулировок потребуется подключение LLM.';
export function localFallback(text: string, context: Context, prefs: Preferences, now: Date) {
  const guarded = guardCalendarRequest(text, context, +now);
  if (guarded) return guarded;
  const normalized = normalizeCalendarText(text, context),
    command = interpretLocal(normalized, context, prefs, now);
  if (command.intent === 'answer_question') return;
  if (['cancel_action', 'confirm_action'].includes(command.intent)) return command;
  if (context.awaitingScope && command.scope) return command;
  if (context.pending?.answer === 'comment' && command.fields?.comment !== undefined)
    return command;
  // The semicolon format has already passed the strict parser in interpretLocal.
  if (normalized.includes(';') && command.intent.startsWith('create')) return command;
  const temporalWords =
      /сегодня|завтра|вчера|недел|месяц|понедельник|вторник|сред[ау]|четверг|пятниц|суббот|воскресень|через|январ|феврал|март|апрел|ма[йяе](?=\s|$)|июн|июл|август|сентябр|октябр|ноябр|декабр|\d/iu,
    quotes = normalized.match(/«[^»]*»|"[^"]*"|'[^']*'/gu) || [],
    unquoted = normalized.replace(/«[^»]*»|"[^"]*"|'[^']*'/gu, ' название '),
    parsed = temporal(normalized.toLowerCase(), prefs, now),
    dates =
      unquoted.match(
        /\d{4}-\d{2}-\d{2}|сегодня|завтра|вчера|недел[а-я]*|месяц[а-я]*|понедельник[а-я]*|вторник[а-я]*|сред[ау]|четверг[а-я]*|пятниц[а-я]*|суббот[а-я]*|воскресень[а-я]*|через/giu,
      ) || [],
    remaining = parsed.rest.replace(/«[^»]*»|"[^"]*"|'[^']*'/gu, ' название ');
  if (
    quotes.some((quote) => temporalWords.test(quote)) ||
    /(?:^|\s)(?:и|или|либо|если|после|перед|кроме|между)\s|[;\n]/iu.test(unquoted) ||
    (dates.length > 1 && !parsed.fields.recurrence) ||
    temporalWords.test(remaining)
  )
    return;
  return command;
}
export function interpretLocal(
  text: string,
  context: Context,
  prefs: Preferences,
  now = new Date(),
): Command {
  const guarded = guardCalendarRequest(text, context, +now);
  if (guarded) return guarded;
  text = normalizeCalendarText(text, context);
  const normalized = text.trim().toLowerCase().replace(/ё/g, 'е').replace(/[?!]$/, '');
  if (/^(отмена|не нужно|забудь|оставь как было|нет)$/u.test(normalized))
    return { intent: 'cancel_action' };
  if (/^(да|подтверждаю|удалить)$/u.test(normalized)) return { intent: 'confirm_action' };
  if (/^(помощь|help|команды)$/u.test(normalized))
    return { intent: 'answer_question', answer: localHelp };
  if (
    context.pending?.answer === 'comment' &&
    !/^(создай|добавь|поставь|найди|что |какие |удали|перенеси|измени|открой)/u.test(normalized)
  )
    return { ...context.pending, fields: { ...context.pending.fields, comment: text.trim() } };
  if (context.awaitingScope) {
    const scope = /всю|все|вся/u.test(normalized)
      ? 'all'
      : /последующ/u.test(normalized)
        ? 'future'
        : /только|это повторение/u.test(normalized)
          ? 'one'
          : undefined;
    if (scope) return { ...context.awaitingScope, scope };
  }
  if (text.includes(';')) {
    const legacy = parseCommand(text, wallParts(now, prefs.zone).date);
    if (legacy.entry) {
      const e = legacy.entry;
      return {
        intent: creationIntent(e.type),
        fields: {
          title: e.title,
          date: e.date,
          time: e.time,
          duration: e.atTime ? undefined : e.duration,
          important: e.important,
          ...(legacy.end ? { endDate: legacy.end.date, endTime: legacy.end.time } : {}),
        },
      };
    }
    return { intent: 'answer_question', answer: legacy.reply };
  }
  const parsed = temporal(normalized, prefs, now),
    fields = parsed.fields;
  const indexWord = parsed.rest.match(/(?:^|\s)(первую|вторую|третью|четвертую|пятую|\d+)[.!]?$/u);
  const index = indexWord
    ? ['первую', 'вторую', 'третью', 'четвертую', 'пятую'].indexOf(indexWord[1]) + 1 ||
      Number(indexWord[1])
    : undefined;
  const type = /задач/u.test(normalized)
    ? 'task'
    : /встреч|созвон/u.test(normalized)
      ? 'meeting'
      : /событи/u.test(normalized)
        ? 'event'
        : undefined;
  let intent: Command['intent'] | undefined;
  if (/^(?:а )?(?:удали|убери|отмени|удалить)/u.test(normalized)) intent = 'delete_event';
  else if (
    /верни.*невыполн|открой.*заново|сними.*(?:отметк|выполн)|(?:отметь|сделай).*не\s?выполн/u.test(
      normalized,
    )
  )
    intent = 'reopen_task';
  else if (/выполнен|закончила|закончил|готова|завершила/u.test(normalized))
    intent = 'complete_task';
  else if (/^(?:а )?(?:перенеси|измени|добавь комментарий|сделай|продли)/u.test(normalized))
    intent = 'update_event';
  else if (/^открой|^выбери/u.test(normalized)) intent = 'open_event';
  else if (/^найди|^когда .*была|^покажи.*(?:про |по |с )/u.test(normalized))
    intent = 'search_events';
  else if (/^что |^какие |^есть ли |^покажи |^расписание/u.test(normalized)) intent = 'list_events';
  else if (
    /^(?:создай|создавай|добавь|поставь|запланируй|назначь|событие(?:\s|$))|напомни|напоминай|нужно|кажд[а-я]*|ежедневно|еженедельно|ежемесячно/u.test(
      normalized,
    )
  )
    intent = creationIntent(type || (/планерка/u.test(normalized) ? 'meeting' : undefined));
  const clean = parsed.rest
    .replace(
      /^(?:а )?(?:создай|создавай|добавь|поставь|запланируй|назначь|напомни мне|напомни|напоминай|найди все|найди|покажи|перенеси|измени время|измени цвет|измени|удали|удалить|убери|отмени|открой|выбери|сделай|продли|верни|отметь|сними|я закончила|я закончил|задача с)\s*/u,
      '',
    )
    .replace(
      /(?:отметку выполнения|не\s?выполнен[а-я]*|выполнен[а-я]*|готова|готов|заново|нужно|цвет|время)/gu,
      '',
    )
    .trim()
    .replace(/^(?:задачу|задачи|задача|встречу|встречи|встреча|событие|события|событию)\s*/u, '')
    .replace(/^(?:про|по|на|в|к)\s+/u, '')
    .replace(/\s+(?:на|в|к|до|с|ее|его|эту|это)$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!intent && context.pending) {
    const pending = context.pending,
      empty = !Object.keys(fields).length,
      creating = pending.intent.startsWith('create');
    if (!creating && pending.intent !== 'update_event')
      return {
        ...pending,
        ...(fields.date || parsed.start
          ? { start: parsed.start || fields.date, end: parsed.end || fields.date }
          : {}),
        ...(fields.time ? { time: fields.time } : {}),
        ...(empty && !index && clean ? { query: clean, id: undefined } : {}),
        ...(index ? { index } : { index: undefined }),
      };
    return {
      ...pending,
      fields: {
        ...pending.fields,
        ...fields,
        ...(empty && pending.fields?.title === undefined && creating ? { title: text.trim() } : {}),
      },
      ...(empty && !index && !creating ? { query: text.trim(), id: undefined } : {}),
      ...(index ? { index } : {}),
    };
  }
  if (!intent && fields.recurrence) intent = creationIntent(type);
  if (!intent && type && /^(?:задач|встреч|событи|созвон|планерк)/u.test(normalized))
    intent = creationIntent(type);
  if (!intent && (type === 'meeting' || type === 'event') && fields.date)
    intent = creationIntent(type);
  if (!intent)
    return { intent: 'answer_question', answer: 'Не удалось уверенно понять запрос. ' + localHelp };
  if (intent.startsWith('create')) {
    const title = clean.replace(/^(?:в |к )/u, '').trim();
    if (title && !/^(встреча|встречу|задача|задачу|событие)$/u.test(title)) fields.title = title;
    return { intent, fields: fields };
  }
  if (intent === 'list_events') {
    const incomplete = /не выпол|не сдел/u.test(normalized);
    return {
      intent,
      type,
      incomplete,
      free: /свободн/u.test(normalized),
      start:
        parsed.start || fields.date || (incomplete ? undefined : wallParts(now, prefs.zone).date),
      end: parsed.end || fields.date || (incomplete ? undefined : wallParts(now, prefs.zone).date),
      time: fields.time,
    };
  }
  const query = index
    ? ''
    : clean
        .replace(/^с\s+(?=нее|ее|него|его)/u, '')
        .replace(/^(?:комментарий к |к задаче |задаче |задачу |к событию |событию |событие )/u, '')
        .replace(
          /^(?:нее|ее|его|эту встречу|эту задачу|это событие|это|эту|встречу|задачу|событие|в|на|к)$/u,
          '',
        );
  const command: Command = {
    intent,
    ...(intent === 'update_event' ? { fields: fields } : {}),
    ...(query ? { query } : {}),
    ...(type ? { type } : {}),
    ...(index ? { index } : {}),
  };
  if (intent !== 'update_event') {
    command.start = parsed.start || fields.date;
    command.end = parsed.end || fields.date;
    command.time = fields.time;
  }
  if (intent === 'update_event') {
    if (/добавь комментарий/u.test(normalized)) command.answer = 'comment';
    const comment = text.match(/комментарий.*?:\s*(.+)$/u);
    if (comment) {
      fields.comment = comment[1];
      command.query = query.split(':')[0].replace(/^комментарий к\s*/u, '');
    }
    if (/продли/u.test(normalized) && fields.duration) {
      command.answer = 'extend';
    }
  }
  return command;
}
