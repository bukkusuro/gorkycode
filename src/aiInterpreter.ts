import { selectEntries } from './assistantEngine.js';
import {
  guardCalendarRequest,
  guardCalendarResponse,
  normalizeCalendarText,
} from './assistantPolicy.js';
import { type ChatMessage, type Context, validateCommand } from './assistantTypes.js';
import type { Entry } from './calendar.js';
import { interpretLocal, localFallback, temporal } from './localInterpreter.js';
import type { Preferences } from './model.js';
import { validDay } from './recurrence.js';

export type AIStatus = { configured: boolean; model: string };

export async function assistantStatus(signal?: AbortSignal): Promise<AIStatus | null> {
  try {
    const response = await fetch('./api/assistant', {
      cache: 'no-store',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(2000)])
        : AbortSignal.timeout(2000),
    });
    if (!response.ok) return null;
    const status = await response.json();
    return typeof status.configured === 'boolean' && typeof status.model === 'string'
      ? status
      : null;
  } catch {
    return null;
  }
}

export async function interpretAI(
  text: string,
  context: Context,
  preferences: Preferences,
  now: Date,
  history: ChatMessage[],
  entries: Entry[],
  conversationId: string,
  requestId: string,
  signal?: AbortSignal,
) {
  text = normalizeCalendarText(text, context);
  const ids = [
    context.lastId,
    ...(context.candidates || []),
    ...(context.resultIds || []),
    context.confirmation?.id,
  ].filter((id): id is string => !!id);
  const referenced = entries
    .filter((entry) => ids.some((id) => id === entry.id || id.startsWith(`${entry.id}@`)))
    .slice(0, 20)
    .flatMap((entry) => {
      const occurrences = ids.filter((id) => id.startsWith(`${entry.id}@`));
      return entry.recurrence && occurrences.length
        ? occurrences.flatMap((id) => {
            const day = id.slice(entry.id.length + 1);
            return validDay(day)
              ? selectEntries([entry], { start: day, end: day }, preferences.zone).filter(
                  (item) => item.id === id,
                )
              : [];
          })
        : [entry];
    });
  const dates = temporal(text, preferences, now);
  const selection = {
    start: dates.start || dates.fields.date,
    end: dates.end || dates.fields.date,
    time: dates.fields.time,
  };
  const relevant =
    (validDay(selection.start) || selection.time) && (!selection.start || validDay(selection.start))
      ? selectEntries(entries, selection, preferences.zone)
      : [];
  const selected = [
    ...new Map(
      [...referenced, ...relevant.slice(0, 60)].map((entry) => [entry.id, entry]),
    ).values(),
  ];
  let response: Response;
  try {
    response = await fetch('./api/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(25000)])
        : AbortSignal.timeout(25000),
      body: JSON.stringify({
        text,
        context,
        conversationId,
        requestId,
        now: now.toISOString(),
        preferences: {
          zone: preferences.zone,
          taskColor: preferences.taskColor,
          meetingColor: preferences.meetingColor,
          eventColor: preferences.eventColor,
        },
        history: history
          .filter((message) => !message.error)
          .slice(-12)
          .map(({ role, text }) => ({ role, text: text.slice(0, 1200) })),
        calendar: {
          ...selection,
          partial: true,
          matchingCount: relevant.length,
          truncated: relevant.length > 60,
        },
        entries: selected.map(
          ({ id, title, type, date, time, completed, important, recurrence }) => ({
            id,
            title,
            type,
            date,
            time,
            completed,
            important,
            recurrence,
          }),
        ),
      }),
    });
  } catch {
    signal?.throwIfAborted();
    throw Object.assign(Error('Не удалось связаться с ИИ.'), { retryable: true });
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw Object.assign(Error('ИИ не завершил ответ.'), { retryable: true });
  }
  if (!response.ok)
    throw Object.assign(Error(data?.error || 'ИИ недоступен. Повторите запрос.'), {
      retryable: data?.retryable ?? [408, 429, 500, 502, 503, 504].includes(response.status),
    });
  return guardCalendarResponse(validateCommand(data?.command));
}

export async function interpretAssistant(...args: Parameters<typeof interpretAI>) {
  const [text, context, preferences, now, , , , , signal] = args,
    guarded = guardCalendarRequest(text, context, +now);
  if (guarded) return guarded;
  signal?.throwIfAborted();
  const fallback = localFallback(text, context, preferences, now);
  if (fallback) return fallback;
  const status = await cachedStatus(signal);
  signal?.throwIfAborted();
  if (!status?.configured) return interpretLocal(text, context, preferences, now);
  try {
    return await interpretAI(...args);
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof Error) || !('retryable' in error) || !error.retryable) throw error;
    return {
      intent: 'answer_question' as const,
      answer:
        'Уточните действие, название, дату и время записи. Например: «Создай встречу с Анной завтра в 10:00».',
    };
  }
}

let statusCache: { value: AIStatus | null; until: number; fetch: typeof fetch } | undefined;
async function cachedStatus(signal?: AbortSignal) {
  if (statusCache?.fetch === fetch && statusCache.until > Date.now()) return statusCache.value;
  const value = await assistantStatus(signal);
  signal?.throwIfAborted();
  statusCache = { value, until: Date.now() + (value?.configured ? 30000 : 1000), fetch };
  return value;
}
