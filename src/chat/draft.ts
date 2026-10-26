import type { Context } from '../assistantTypes.js';
export type DraftStep = { context: Context; question: string };
export function hasDraft(context: Context) {
  return !!context.numeric || !!context.pending?.intent.startsWith('create');
}
export function editDraft(previous: Context, field: 'date' | 'time' | 'title', now = Date.now()) {
  if (!previous.pending?.intent.startsWith('create')) return;
  const context = structuredClone(previous);
  context.pending = {
    ...context.pending!,
    fields: { ...context.pending!.fields, [field]: undefined },
  };
  if (field === 'time') context.pending.fields!.allDay = false;
  context.updatedAt = now;
  context.numeric = { next: field };
  return {
    context,
    question:
      field === 'date'
        ? 'На какую дату?'
        : field === 'time'
          ? 'На какое время?'
          : context.pending.intent === 'create_meeting'
            ? 'Как называется встреча?'
            : context.pending.intent === 'create_event'
              ? 'Как называется событие?'
              : 'Как называется задача?',
  };
}
export function restoreStep(step: DraftStep, now = Date.now()) {
  const context = structuredClone(step.context);
  context.updatedAt = now;
  if (context.numeric && 'questionId' in context.numeric)
    context.numeric.questionId = crypto.randomUUID();
  return {
    context,
    reply: step.question,
    numericChoiceId:
      context.numeric && 'questionId' in context.numeric ? context.numeric.questionId : undefined,
  };
}
