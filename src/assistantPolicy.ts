import type { Command, Context } from './assistantTypes.js';

export function planningRequest(
  text: string,
): 'plan_day' | 'create_batch' | 'productivity_report' | undefined {
  const s = text.toLowerCase().replace(/ё/g, 'е');
  if (/^(?:задача|встреча|событие)\s+[^;]+;/u.test(s)) return;
  if (
    /^(?:(?:вокса)[,\s]+)?(?:(?:покажи|дай|составь|подготовь|проанализируй|расскажи|какой|какая)\s+)?(?:мой\s+|мои\s+)?(?:недельный\s+отчет|отчет\s+(?:за|по)|аналитик[ау]\s+(?:за|по|выполн)|продуктивност[ьи]|процент\s+выполн|закономерност[ьи]|статистик[ау]\s+(?:за|по|выполн)|истори[яю]\s+выполн)/u.test(
      s,
    )
  )
    return 'productivity_report';
  if (
    /(?:перестрой|перепланир|оптимизир|перераспредел|пересобер)[\s\S]{0,80}(?:день|расписан|план|задач)|(?:ничего\s+не|не)\s+успеваю[\s\S]{0,100}(?:план|день|важн)/u.test(
      s,
    )
  )
    return 'plan_day';
  const actions =
    s.match(
      /(?:^|[\s,;])(?:закончить|завершить|сдать|подготовить(?:ся)?|сходить|купить|позвонить|написать|сделать|прочитать|отправить|оплатить|забрать|встретиться)(?=\s|[.,;]|$)/gu,
    ) || [];
  if (
    (actions.length >= 2 && /[,;\n]|\sи\s/u.test(s)) ||
    /(?:добавь|создай|запиши|запланируй)[\s\S]{0,35}(?:несколько|список|эти\s+задачи)/u.test(s)
  )
    return 'create_batch';
}

export const scopeMessage = 'Я помогаю только с задачами, встречами и событиями календаря.';
export const calendarHelp =
  'Помогаю планировать задачи, встречи и события. Например: «Напомни завтра в 10 позвонить Анне», «Что у меня сегодня?», «Перенеси её на пятницу», «Отметь задачу на сегодня в 10:15 выполненной». Удаление — после подтверждения. Могу перестроить день, подготовить несколько записей из одного сообщения и показать недельный отчёт. План применяется только после подтверждения.';

const vocabulary = {
  action:
    'создай создавай добавь поставь запиши запланируй назначь напомни напоминай перенеси измени переименуй отметь пометь заверши открой выбери продли покажи найди сделай напиши расскажи объясни переведи реши вычисли сгенерируй',
  category:
    'задача задачу задачи задаче задачами задачах встреча встречу встречи встрече встречами встречах событие события событию событии событиями событиях созвон созвоны планерка планерку календарь календаре расписание напоминание',
  time: 'сегодня завтра послезавтра вчера понедельник понедельнику понедельника вторник вторника среда среду среды четверг четверга пятница пятницу пятницы суббота субботу субботы воскресенье воскресенья неделю недели неделе ежедневно еженедельно ежемесячно',
  modifier:
    'важно важная важную важной срочно срочная срочную срочной выполненной выполненным выполненную невыполненной невыполненные',
};
type WordKind = keyof typeof vocabulary;
const dictionary = Object.entries(vocabulary).flatMap(([kind, words]) =>
  words.split(' ').map((word) => ({ word, kind: kind as WordKind })),
);
const knownWords = new Map(dictionary.map((item) => [item.word, item]));
const exactActions = new Set('удали удалить убери отмени отменить сними верни'.split(' '));
const commandFillers = new Set(
  'вокса пожалуйста привет а тогда также еще мне надо нужно можешь ли ты помоги давай на в к до через у меня мои моих мою эту это ее его не все с со про по для каждый каждую каждое следующую следующий какую какие что есть я удали удалить убери отмени отменить сними верни'.split(
    ' ',
  ),
);
const comparable = (word: string) =>
  word
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(
      /[aceopxy]/g,
      (letter) => ({ a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у' })[letter]!,
    );
function spellingDistance(a: string, b: string) {
  let older = new Uint8Array(b.length + 1),
    previous = Uint8Array.from({ length: b.length + 1 }, (_, index) => index),
    current = new Uint8Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + Number(a[i - 1] !== b[j - 1]),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        current[j] = Math.min(current[j], older[j - 2] + 1);
    }
    [older, previous, current] = [previous, current, older];
  }
  return previous[b.length];
}
const spellingCache = new Map<string, (typeof dictionary)[number] | undefined>();
function closestWord(word: string, kinds: WordKind[]) {
  const key = comparable(word),
    exact = knownWords.get(key);
  if (exact) return kinds.includes(exact.kind) ? exact : undefined;
  if (key.length < 4 || key.length > 20) return;
  const cacheKey = `${kinds.join(',')}:${key}`;
  if (spellingCache.has(cacheKey)) return spellingCache.get(cacheKey);
  const limit = key.length >= 9 ? 2 : 1;
  let best = limit + 1,
    candidates: typeof dictionary = [];
  for (const item of dictionary) {
    if (!kinds.includes(item.kind) || Math.abs(key.length - item.word.length) > limit) continue;
    const distance = spellingDistance(key, item.word);
    if (distance < best) {
      best = distance;
      candidates = [item];
    } else if (distance === best) candidates.push(item);
  }
  const result = best <= limit && candidates.length === 1 ? candidates[0] : undefined;
  if (spellingCache.size >= 512) spellingCache.delete(spellingCache.keys().next().value!);
  spellingCache.set(cacheKey, result);
  return result;
}
export function normalizeCalendarText(text: string, context: Context = {}) {
  const first = text.match(/[а-яёa-z]+/iu)?.[0];
  if (
    context?.pending &&
    (context.pending.answer === 'comment' ||
      (context.pending.intent?.startsWith('create') && !context.pending.fields?.title)) &&
    !closestWord(first || '', ['action']) &&
    !exactActions.has(comparable(first || ''))
  ) {
    if (context.pending.answer === 'comment' || !closestWord(first || '', ['time'])) return text;
  }
  let header = true,
    categorySeen = false,
    previous = '';
  return text.replace(/«[^»]*»|"[^"]*"|'[^']*'|[а-яёa-z]+/giu, (word, offset: number) => {
    if (/^[«"']/u.test(word)) {
      header = false;
      previous = '';
      return word;
    }
    const key = comparable(word);
    if (commandFillers.has(key)) {
      if (categorySeen && /^(?:с|со|про|по|для)$/u.test(key)) header = false;
      previous = key;
      return word;
    }
    const tail = text.slice(offset + word.length);
    const timeSlot =
      !/^(?:с|со|у|для|про|по)$/u.test(previous) &&
      !(offset > 0 && /^[А-ЯЁA-Z]/u.test(word) && !/^(?:в|на|к|до|через)$/u.test(previous)) &&
      (header ||
        (!/^[А-ЯЁA-Z]/u.test(word) &&
          (/^(?:в|на|к|до|через)$/u.test(previous) ||
            /^[\s,.!?;]*(?:(?:в|на|к)\s*\d{1,2}(?::\d{2})?[\s.!?]*)?$/iu.test(tail))));
    const kinds: WordKind[] = [
      ...(header && !categorySeen ? (['action', 'category'] as const) : []),
      ...(header ? (['modifier'] as const) : []),
      ...(timeSlot ? (['time'] as const) : []),
    ];
    const corrected = closestWord(word, kinds);
    previous = corrected?.word || key;
    if (!corrected) {
      header = false;
      return word;
    }
    if (corrected.kind === 'category') categorySeen = true;
    if (corrected.word === key && word.toLowerCase().replace(/ё/g, 'е') === key) return word;
    return word === word.toUpperCase()
      ? corrected.word.toUpperCase()
      : /^[А-ЯЁA-Z]/u.test(word)
        ? corrected.word[0].toUpperCase() + corrected.word.slice(1)
        : corrected.word;
  });
}

const calendar =
  /задач|встреч|событи|созвон|планерк|календар|расписани|напоминани|запис[ьиь]|план(?:ы|ов|ах|а)?(?:\s|$)|\b(?:tasks?|meetings?|events?|calendar|schedule|reminders?)(?=\s|[;:,.!?]|$)/u;
const dateTime =
  /сегодня|завтра|вчера|недел|месяц|понедельник|вторник|сред[ау]|четверг|пятниц|суббот|воскресень|через\s+\S+\s+(?:дн|день|час|минут)|\d{1,2}[:.\-]\d{2}|(?:^|\s)(?:в|на|к)\s*\d{1,2}(?=\s|[.!?]|$)|\d{4}-\d{2}-\d{2}|\b(?:today|tomorrow)(?=\s|[;:,.!?]|$)/u;
const manipulation =
  /(?:игнорируй|игнорировать|забудь|отмени|обойди|отключи|не\s+учитывай).{0,70}(?:инструкц|правил|ограничен|фильтр|промпт)|(?:системн|скрыт)[а-я]*\s+(?:промпт|инструкц)|(?:ignore|override|bypass|disable).{0,60}(?:instructions?|rules?|restrictions?|filters?|prompts?)|(?:system|developer|assistant)\s*:|<\|(?:im_start|system|assistant)/u;
const generation =
  /^(?:напиши|пиши|сгенерируй|сочини|переведи|реши|посчитай|вычисли|нарисуй|разработай|программируй|расскажи|объясни|ответь|дай\s+(?:код|рецепт|совет)|выполни\s+(?:код|скрипт)|запусти\s+(?:код|скрипт)|write|generate|translate|solve|calculate|draw|explain|tell\s+me)(?=\s|[;:,.!?]|$)/u;
const externalOperation =
  /^(?:создай|добавь|сделай|измени|перенеси|открой|удали|убери|запусти|выполни)\s+(?:мне\s+)?(?:код|скрипт|программу|калькулятор|файл[ы]?|папку|браузер|терминал|сайт|картинку|изображение|историю|рассказ|стих|рецепт)(?=\s|[;:,.!?]|$)/u;
const selectorWord =
  /^(?:на|в|к|до|а|нет|лучше|ее|его|это|эту|сегодня|завтра|послезавтра|вчера|через|один|два|три|четыре|пять|шесть|семь|перв[а-я]*|втор[а-я]*|трет[а-я]*|следующ[а-я]*|эт[а-я]*|понедельник[а-я]*|вторник[а-я]*|сред[ау]|четверг[а-я]*|пятниц[а-я]*|суббот[а-я]*|воскресень[а-я]*|недел[а-я]*|месяц[а-я]*|день|дня|дней|час[а-я]*|минут[а-я]*|утра|вечера|ночи|январ[а-я]*|феврал[а-я]*|март[а-я]*|апрел[а-я]*|ма[йяе]|июн[а-я]*|июл[а-я]*|август[а-я]*|сентябр[а-я]*|октябр[а-я]*|ноябр[а-я]*|декабр[а-я]*)$/u;
const normalize = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F]/g, '')
    .trim();
const answer = (text: string): Command => ({ intent: 'answer_question', answer: text });
const direct = (text: string) =>
  text
    .replace(
      /^(?:(?:вокса|привет|пожалуйста|а|тогда|также|еще|но|сначала|затем|и|давай|можешь(?:\s+ли)?(?:\s+ты)?|помоги(?:\s+мне)?)[,!\s]+)+/u,
      '',
    )
    .trim();

export function guardCalendarRequest(
  text: string,
  context: Context = {},
  now = Date.now(),
): Command | undefined {
  if (!context || typeof context !== 'object' || Array.isArray(context)) context = {};
  if (context.updatedAt && now - context.updatedAt > 30 * 60000) context = {};
  const s = normalize(normalizeCalendarText(text, context)),
    unquoted = s.replace(/«[^»]*»|"[^"]*"|'[^']*'/gu, ' название ');
  const value = direct(s);
  const help =
    /^(?:помощь|help|команды|что\s+ты\s+умеешь|чем\s+(?:ты\s+)?(?:можешь\s+)?помочь|как\s+(?:мне\s+)?(?:пользоваться|работать\s+с))/u.test(
      value,
    ) ||
    (/^(?:как|объясни\s+как|расскажи\s+как)\s+.*(?:созда|добав|перен|измени|удал|отмет|заверш|пользова)/u.test(
      value,
    ) &&
      calendar.test(value));
  const listing =
    /^(?:что\s+у\s+меня|какие|сколько|когда|есть\s+ли|покажи|найди|расписание|напиши\s+список|расскажи\s+(?:про|о)\s+мои)/u.test(
      value,
    ) &&
    (calendar.test(value) || (/у\s+меня|мои|моих/u.test(value) && dateTime.test(value)));
  const clauses = unquoted.split(
    /[.!?;\n]+|[,\s]+(?:а\s+еще|но\s+сначала|также|затем)\s+|\s+и\s+/u,
  );
  if (
    manipulation.test(unquoted) ||
    externalOperation.test(value) ||
    clauses.some((clause, index) => {
      const request = direct(normalizeCalendarText(clause));
      return (
        externalOperation.test(request) ||
        (generation.test(request) &&
          !(index === 0 && (help || listing || planningRequest(value) === 'productivity_report')))
      );
    })
  )
    return answer(scopeMessage);
  if (planningRequest(value)) return;
  if (
    /^(?:привет|здравствуй(?:те)?|доброе\s+утро|добрый\s+(?:день|вечер)|hello|hi)[!.,\s]*$/u.test(s)
  )
    return answer('Привет! Помогу с задачами, встречами и событиями. Что запланируем?');
  if (/^(?:спасибо|благодарю|понятно|хорошо|ок|окей|thanks)[!.,\s]*$/u.test(s))
    return answer('Пожалуйста! Обращайтесь, если нужно что-то запланировать.');
  if (help) return answer(calendarHelp);
  if (
    /^(?:да|нет|отмена|подтверждаю|удалить|не\s+нужно|забудь|оставь\s+как\s+было)[.!\s]*$/u.test(s)
  )
    return;
  if (listing) return;
  if (
    /^(?:напомни|напоминай|запланируй|запланировать|назначь|назначить|планируй|remind|schedule)(?=\s|[;:,.!?]|$)/u.test(
      value,
    )
  )
    return;
  if (
    /^(?:создай|создавай|добавь|поставь|запиши|организуй|создать|добавить|create|add)(?=\s|[;:,.!?]|$)/u.test(
      value,
    ) &&
    (calendar.test(value) || dateTime.test(value))
  )
    return;
  if (/^(?:задач[ауи]?|встреч[ауи]?|событие|события|созвон|планерка)(?:\s|;|:)/u.test(value))
    return;
  if (
    /^(?:перенеси|перенести|сдвинь|измени|изменить|переименуй|удали|удалить|убери|отмени|отметь|пометь|заверши|закрой|верни|сними|открой|выбери|продли|добавь\s+комментарий|я\s+закончил[а]?|move|reschedule|complete|reopen|delete|cancel)(?=\s|[;:,.!?]|$)/u.test(
      value,
    ) &&
    (calendar.test(value) ||
      dateTime.test(value) ||
      context.lastId ||
      context.resultIds?.length ||
      context.pending ||
      context.candidates?.length)
  )
    return;
  if (
    /^(?:сделай|сделать)(?=\s|[;:,.!?]|$)/u.test(value) &&
    (calendar.test(value) ||
      (/важн|срочн|выполнен|красн|зелен|син/u.test(value) && !!context.lastId))
  )
    return;
  if (
    /^(?:сегодня|завтра|послезавтра|через|кажд[а-я]*|ежедневно|еженедельно|ежемесячно|в\s|на\s|к\s)/u.test(
      value,
    ) &&
    dateTime.test(value) &&
    !/[?]/u.test(value) &&
    !/(?:^|\s)(?:кто|почему|зачем|какая|какой|какие|как)\s/u.test(value)
  )
    return;
  if (
    context.pending ||
    context.awaitingScope ||
    context.candidates?.length ||
    context.lastId ||
    context.resultIds?.length
  ) {
    if (
      /^(?:первую|вторую|третью|четвертую|пятую|\d{1,2}|только\s+это\s+повторение|это\s+и\s+последующие|всю\s+серию|все|всю|вся|ее|его|эту|это)[.!\s]*$/u.test(
        value,
      )
    )
      return;
    if (
      (dateTime.test(value) || /\d/u.test(value)) &&
      value.length <= 100 &&
      (value.match(/[а-яa-z]+/gu) || []).every((word) => selectorWord.test(word))
    )
      return;
    if (
      context.pending &&
      !/^(?:кто|что|как|какая|какие|почему|зачем)/u.test(value) &&
      (value.length <= 150 || context.pending.answer === 'comment')
    )
      return;
  }
  return answer(scopeMessage);
}

export function guardCalendarResponse(command: Command): Command {
  return command.intent === 'answer_question' ? answer(calendarHelp) : command;
}

export function calendarHistory(history: unknown, context: Context = {}, now = Date.now()) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (message) =>
        message &&
        ['user', 'assistant'].includes(message.role) &&
        typeof message.text === 'string' &&
        message.text !== scopeMessage &&
        (message.role !== 'user' ||
          guardCalendarRequest(message.text, context, now)?.answer !== scopeMessage),
    )
    .slice(-12)
    .map(({ role, text }) => ({ role, text: text.slice(0, 1200) }));
}
