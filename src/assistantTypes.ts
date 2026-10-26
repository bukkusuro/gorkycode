import { type Entry, type Recurrence, entryTypes, validTime, validColor } from './calendar.js';
import { assistantIntents as intents } from './assistantIntents.js';
import { validDay, validRecurrence, type Scope } from './recurrence.js';
import { isNumericInput } from './numericInput.js';
export type Fields = {
  title?: string;
  date?: string;
  time?: string;
  duration?: number;
  endDate?: string;
  endTime?: string;
  comment?: string;
  important?: boolean;
  color?: string;
  allDay?: boolean;
  recurrence?: Recurrence;
};
export type Intent = (typeof intents)[number];
export type Command = {
  intent: Intent;
  fields?: Fields;
  query?: string;
  id?: string;
  index?: number;
  start?: string;
  end?: string;
  time?: string;
  type?: Entry['type'];
  incomplete?: boolean;
  free?: boolean;
  scope?: Scope;
  answer?: string;
};
export type Context = {
  updatedAt?: number;
  lastId?: string;
  resultIds?: string[];
  pending?: Command;
  candidates?: string[];
  confirmation?: { command: Command; snapshot: string; id: string };
  awaitingScope?: Command;
  numeric?:
    { value: string; questionId: string } | { next: 'date' | 'time' | 'title'; first?: true };
};
export type ChatMessage = {
  role: 'assistant' | 'user';
  text: string;
  id?: string;
  at?: string;
  error?: boolean;
  retry?: string;
  entryIds?: string[];
  numericChoiceId?: string;
};
const commandKeys = [
  'intent',
  'fields',
  'query',
  'id',
  'index',
  'start',
  'end',
  'time',
  'type',
  'incomplete',
  'free',
  'scope',
  'answer',
];
const fieldKeys = [
  'title',
  'date',
  'time',
  'duration',
  'endDate',
  'endTime',
  'comment',
  'important',
  'color',
  'allDay',
  'recurrence',
];
const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const keys = (x: Record<string, unknown>, allowed: string[]) =>
  Object.keys(x).every((k) => allowed.includes(k));
export function validateCommand(raw: unknown): Command {
  if (!object(raw) || !keys(raw, commandKeys) || !intents.includes(raw.intent as Intent))
    throw Error('Недопустимая команда ассистента.');
  for (const k of ['query', 'id', 'answer'])
    if (raw[k] !== undefined && (typeof raw[k] !== 'string' || (raw[k] as string).length > 4000))
      throw Error('Недопустимый текст команды.');
  for (const k of ['start', 'end'])
    if (raw[k] !== undefined && !validDay(raw[k])) throw Error('Некорректная дата.');
  if (raw.time !== undefined && !validTime(raw.time))
    throw Error('Некорректное время выбора записи.');
  if (raw.start && raw.end && raw.start > raw.end) throw Error('Окончание периода раньше начала.');
  if (
    (raw.type !== undefined &&
      (typeof raw.type !== 'string' || !Object.hasOwn(entryTypes, raw.type))) ||
    (raw.scope !== undefined && !['one', 'future', 'all'].includes(raw.scope as string))
  )
    throw Error('Недопустимый тип или область изменения.');
  if (
    raw.index !== undefined &&
    (!Number.isInteger(raw.index) || (raw.index as number) < 1 || (raw.index as number) > 100)
  )
    throw Error('Неверный номер записи.');
  for (const k of ['incomplete', 'free'])
    if (raw[k] !== undefined && typeof raw[k] !== 'boolean') throw Error('Недопустимый фильтр.');
  if (raw.fields !== undefined) {
    if (!object(raw.fields) || !keys(raw.fields, fieldKeys))
      throw Error('Недопустимые поля записи.');
    const f = raw.fields;
    for (const k of ['date', 'endDate'])
      if (f[k] !== undefined && !validDay(f[k])) throw Error('Некорректная дата.');
    for (const k of ['time', 'endTime'])
      if (f[k] !== undefined && !validTime(f[k])) throw Error('Некорректное время.');
    if (
      f.duration !== undefined &&
      (typeof f.duration !== 'number' ||
        !Number.isFinite(f.duration) ||
        f.duration < 5 ||
        f.duration > 5256000)
    )
      throw Error('Продолжительность должна быть от 5 минут до 10 лет.');
    for (const k of ['title', 'comment'])
      if (
        f[k] !== undefined &&
        (typeof f[k] !== 'string' || (f[k] as string).length > (k === 'title' ? 150 : 4000))
      )
        throw Error('Слишком длинный текст.');
    for (const k of ['important', 'allDay'])
      if (f[k] !== undefined && typeof f[k] !== 'boolean')
        throw Error('Недопустимый признак записи.');
    if (f.color !== undefined && !validColor(f.color)) throw Error('Некорректный цвет.');
    if (f.recurrence !== undefined && !validRecurrence(f.recurrence))
      throw Error('Некорректное правило повторения.');
  }
  return raw as Command;
}
export const assistantText = (text: string) => text.replace(/^ИИ временно недоступен\.\s*/u, '');
export function loadChat(value: unknown, fallback: ChatMessage[]): ChatMessage[] {
  if (!Array.isArray(value)) return fallback;
  const messages = value
    .filter(
      (v) =>
        object(v) && ['assistant', 'user'].includes(v.role as string) && typeof v.text === 'string',
    )
    .slice(-300)
    .map((v) => ({
      role: v.role,
      text: (v.role === 'assistant' ? assistantText(v.text) : v.text).slice(0, 12000),
      ...(typeof v.at === 'string' && Number.isFinite(Date.parse(v.at)) ? { at: v.at } : {}),
      ...(typeof v.id === 'string' ? { id: v.id } : {}),
      ...(v.role === 'assistant' && typeof v.numericChoiceId === 'string'
        ? { numericChoiceId: v.numericChoiceId }
        : {}),
      ...(v.error === true ? { error: true } : {}),
      ...(typeof v.retry === 'string' ? { retry: v.retry.slice(0, 4000) } : {}),
      ...(Array.isArray(v.entryIds)
        ? { entryIds: v.entryIds.filter((id: unknown) => typeof id === 'string').slice(0, 100) }
        : {}),
    })) as ChatMessage[];
  return messages.length ? messages : fallback;
}
export function restoreContext(value: unknown, entries: Entry[], now = Date.now()): Context {
  if (!object(value) || typeof value.updatedAt !== 'number' || now - value.updatedAt > 30 * 60000)
    return {};
  const exists = (id: unknown) =>
    typeof id === 'string' && entries.some((e) => e.id === id || id.startsWith(`${e.id}@`));
  const command = (raw: unknown) => {
    try {
      return validateCommand(raw);
    } catch {
      return undefined;
    }
  };
  const pending = command(value.pending),
    awaitingScope = command(value.awaitingScope);
  const numeric: Context['numeric'] = object(value.numeric)
    ? isNumericInput(value.numeric.value) && typeof value.numeric.questionId === 'string'
      ? { value: value.numeric.value, questionId: value.numeric.questionId }
      : ['date', 'time'].includes(value.numeric.next as string) ||
          (value.numeric.next === 'title' && pending?.intent.startsWith('create'))
        ? {
            next: value.numeric.next as 'date' | 'time' | 'title',
            ...(value.numeric.first === true ? { first: true } : {}),
          }
        : undefined
    : undefined;
  return {
    updatedAt: value.updatedAt,
    ...(exists(value.lastId) ? { lastId: value.lastId as string } : {}),
    ...(Array.isArray(value.resultIds)
      ? { resultIds: value.resultIds.filter(exists).slice(0, 100) as string[] }
      : {}),
    ...(pending ? { pending } : {}),
    ...(pending && Array.isArray(value.candidates)
      ? { candidates: value.candidates.filter(exists).slice(0, 100) as string[] }
      : {}),
    ...(awaitingScope ? { awaitingScope } : {}),
    ...(numeric ? { numeric } : {}),
  };
}
