import { type Entry, entryColor, validEntry, validTime } from './calendar.js';
import type { Preferences } from './model.js';
import { validDay } from './recurrence.js';

function parseCsv(text: string) {
  if (text.length > 5_000_000) throw Error('Размер CSV не должен превышать 5 МБ.');
  const source = text.replace(/^\uFEFF/, '');
  const delimiter = source.split(/[\r\n]/, 1)[0].includes(';') ? ';' : ',';
  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [],
    field = '',
    quoted = false,
    closed = false,
    line = 1,
    start = 1;
  const finishField = () => {
    cells.push(field);
    field = '';
    closed = false;
  };
  const finishRow = () => {
    finishField();
    if (cells.some((cell) => cell.trim())) rows.push({ line: start, cells });
    cells = [];
    start = line + 1;
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else {
        field += char;
        if (char === '\n') line++;
      }
    } else if (char === delimiter) finishField();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      finishRow();
      line++;
    } else if (char === '"' && field === '' && !closed) quoted = true;
    else if (closed || char === '"') throw Error(`Строка ${line}: некорректные кавычки CSV.`);
    else field += char;
  }
  if (quoted) throw Error(`Строка ${start}: незакрытые кавычки CSV.`);
  if (field || cells.length || closed) finishRow();
  return rows;
}

export function classifyEntry(text: string): Entry['type'] {
  const title = text.trim().toLocaleLowerCase('ru').replace(/ё/g, 'е');
  if (/^демо\s+проекта(?:\s|$)/u.test(title)) return 'event';
  return /^(?:встреча\s|созвон\s|провести\s+планерк|обсудить\s.+\sс\s)/u.test(title)
    ? 'meeting'
    : 'task';
}

function isImportant(text: string) {
  const positive = text.replace(
    /(?:^|[^\p{L}])не\s+(?:важн\p{L}*|срочн\p{L}*|дедлайн\p{L}*)(?=$|[^\p{L}])/giu,
    ' ',
  );
  return /(?:^|[^\p{L}])(?:важн\p{L}*|срочн\p{L}*|дедлайн\p{L}*)(?=$|[^\p{L}])/iu.test(positive);
}

function importKey(values: string[]) {
  let hash = 0xcbf29ce484222325n;
  for (const char of JSON.stringify(values)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0)!)) * 0x100000001b3n);
  }
  return `csv:${hash.toString(36)}`;
}

export function importCsv(
  text: string,
  prefs: Pick<Preferences, 'taskColor' | 'meetingColor' | 'eventColor'>,
  existing: unknown[] = [],
  now = new Date(),
) {
  const [header, ...rows] = parseCsv(text);
  const names = header?.cells.map((name) => name.trim().toLowerCase()) || [];
  if (
    new Set(names).size !== names.length ||
    !['id', 'date', 'time', 'text'].every((name) => names.includes(name))
  ) {
    throw Error('Нужны столбцы id, date, time, text без повторяющихся заголовков.');
  }
  if (!rows.length || rows.length > 10_000)
    throw Error('CSV должен содержать от 1 до 10 000 записей.');
  const ids = new Set<string>();
  const columns = new Map(names.map((name, index) => [name, index]));
  const parsed = rows.map(({ cells, line }) => {
    if (cells.length !== names.length) throw Error(`Строка ${line}: неверное число столбцов.`);
    const value = (name: string) => cells[columns.get(name)!];
    const id = value('id').trim(),
      date = value('date').trim(),
      time = value('time').trim(),
      title = value('text');
    if (!id || ids.has(id)) throw Error(`Строка ${line}: пустой или повторяющийся id.`);
    if (!validDay(date) || !validTime(time) || !title.trim()) {
      throw Error(`Строка ${line}: проверьте дату, время и текст.`);
    }
    ids.add(id);
    return { date, time, title, line, key: importKey([id, date, time, title]) };
  });
  const known = new Set(
    existing.filter(validEntry).flatMap((entry) => [entry.id, entry.importKey]),
  );
  const entries: Entry[] = [],
    counts = { task: 0, meeting: 0, event: 0 };
  let duplicates = 0;
  const importedAt = now.toISOString();
  for (const row of parsed) {
    const type = classifyEntry(row.title);
    const entry: Entry = {
      id: row.key,
      importKey: row.key,
      importedAt,
      title: row.title,
      type,
      date: row.date,
      time: row.time,
      duration: 0,
      atTime: true,
      color: entryColor(type, prefs),
      important: isImportant(row.title),
      description: '',
      completed: false,
    };
    if (!validEntry(entry)) throw Error(`Строка ${row.line}: некорректная запись.`);
    counts[type]++;
    if (known.has(row.key)) duplicates++;
    else {
      entries.push(entry);
      known.add(row.key);
    }
  }
  let start = parsed[0].date,
    end = start;
  for (const row of parsed) {
    if (row.date < start) start = row.date;
    if (row.date > end) end = row.date;
  }
  return { entries, duplicates, total: parsed.length, counts, start, end };
}
