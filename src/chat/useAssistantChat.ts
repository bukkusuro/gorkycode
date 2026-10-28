import { useEffect, useRef, useState } from 'react';
import { interpretAssistant } from '../aiInterpreter';
import { processRequest } from '../assistantEngine';
import {
  type Context,
  loadChat,
  type ChatMessage as Message,
  restoreContext,
} from '../assistantTypes';
import { type Entry, validEntry } from '../calendar';
import { type Preferences, readJSON } from '../model';
import { useVoice } from '../useVoice';
import { type DraftStep, editDraft, hasDraft, restoreStep } from './draft';
import { applyPlan, type PlanProposal } from '../planning/plan';
import type { Outcome } from '../assistantEngine';
export type ChatOptions = {
  records: unknown[];
  entries: Entry[];
  prefs: Preferences;
  selectedDay: string;
  commit: (records: unknown[]) => boolean;
  persist: (key: string, value: unknown) => boolean;
  onResults: (entries: Entry[]) => void;
  onOpenEntry: (id: string) => void;
};
const greeting: Message[] = [
  {
    role: 'assistant',
    text: 'Привет! Я Вокса 🐶 Помогу тебе планировать задачи, создавать встречи и не забывать о важном. Напиши или скажи, что нужно сделать.',
  },
];

export function useAssistantChat({
  records,
  entries,
  prefs,
  commit,
  persist,
  onResults,
  onOpenEntry,
}: ChatOptions) {
  const [input, setInput] = useState('');
  const [chatInitial] = useState(() => {
    try {
      const raw = localStorage.getItem('voicetask.chat.v1');
      const parsed = raw === null ? greeting : JSON.parse(raw);
      if (
        !Array.isArray(parsed) ||
        parsed.some(
          (m) => !m || !['assistant', 'user'].includes(m.role) || typeof m.text !== 'string',
        )
      )
        throw Error();
      return { messages: loadChat(parsed, greeting), error: false };
    } catch {
      return { messages: greeting, error: true };
    }
  });
  const [chatBlocked, setChatBlocked] = useState(chatInitial.error);
  const [messages, setMessages] = useState<Message[]>(chatInitial.messages);
  const [busy, setBusy] = useState(false),
    [clearChat, setClearChat] = useState(false);
  const lastSend = useRef({ text: '', at: 0 });
  const [initialContext] = useState(() =>
    restoreContext(readJSON('voicetask.context.v1', {}), entries),
  );
  const context = useRef<Context>(initialContext);
  const [proposal, setProposal] = useState<PlanProposal | null>(null);
  const activeRequest = useRef<{ controller: AbortController; text: string } | null>(null);
  const steps = useRef<DraftStep[]>([]);
  const [conversationId, setConversationId] = useState(() => {
    const saved = readJSON<unknown>('voicetask.ai.conversation.v1', null);
    return typeof saved === 'string' && /^[\w-]{1,100}$/.test(saved) ? saved : crypto.randomUUID();
  });
  const voice = useVoice(input, setInput);

  const messageEnd = useRef<HTMLDivElement>(null);
  function appendMessage(message: Message) {
    setMessages((current) => [...current, message].slice(-300));
  }
  function updateContext(next: Context) {
    context.current = next;
    persist('voicetask.context.v1', next);
  }
  function remember(step: DraftStep) {
    steps.current = [...steps.current, step].slice(-12);
  }
  function snapshot(): DraftStep {
    const question =
      [...messages].reverse().find((message) => message.role === 'assistant')?.text || '';
    return { context: structuredClone(context.current), question };
  }
  async function sendMessage(request?: string, numericChoiceId?: string, proposalId?: string) {
    if (activeRequest.current) return;
    if (proposalId && proposal?.id !== proposalId) return;
    const numeric = context.current.numeric;
    if (
      numericChoiceId &&
      (!numeric ||
        !('questionId' in numeric) ||
        numeric.questionId !== numericChoiceId ||
        Date.now() - (context.current.updatedAt || 0) > 30 * 60000)
    )
      return;
    const current = { controller: new AbortController(), text: '' };
    activeRequest.current = current;
    setBusy(true);
    try {
      let text: string;
      try {
        text = request === undefined ? await voice.finish() : request;
      } catch {
        return;
      }
      current.controller.signal.throwIfAborted();
      current.text = text.trim();
      const at = Date.now();
      if (
        !current.text ||
        current.text.length > 4000 ||
        (lastSend.current.text === current.text && at - lastSend.current.at < 1000)
      )
        return;
      lastSend.current = { text: current.text, at };
      voice.cancel();
      const requestId = crypto.randomUUID();
      appendMessage({
        role: 'user',
        text: current.text,
        id: requestId,
        at: new Date().toISOString(),
      });
      const previous = snapshot();
      const confirmation = /^(?:да|подтверждаю|применить план|добавить все)[.!]?$/iu.test(
        current.text,
      );
      const cancellation = /^(?:нет|отмена|отменить план|не нужно)[.!]?$/iu.test(current.text);
      const confirmed = () => {
        const next = applyPlan(proposal!, records, prefs);
        const original = new Map(
          records.filter(validEntry).map((entry) => [entry.id, JSON.stringify(entry)]),
        );
        return {
          reply:
            'План применён. Все изменения можно отменить кнопкой «Отменить последнее действие».',
          context: {},
          records: next,
          entries: next
            .filter(validEntry)
            .filter(
              (entry) => !entry.recurrence && original.get(entry.id) !== JSON.stringify(entry),
            ),
        };
      };
      const result: Outcome =
        proposal && (confirmation || cancellation)
          ? cancellation
            ? { reply: 'План отменён. Записи не изменены.', context: {} }
            : confirmed()
          : await processRequest(
              (value, state, preferences, now) =>
                interpretAssistant(
                  value,
                  state,
                  preferences,
                  now,
                  messages,
                  entries,
                  conversationId,
                  requestId,
                  current.controller.signal,
                ),
              current.text,
              records,
              context.current,
              prefs,
              requestId,
            );
      current.controller.signal.throwIfAborted();
      if (result.records && !commit(result.records))
        throw Error('Запись не сохранена. Проверьте доступность хранилища и повторите запрос.');
      setProposal(result.proposal || null);
      if (result.records || !hasDraft(result.context)) steps.current = [];
      else if (hasDraft(previous.context)) remember(previous);
      updateContext(result.context);
      appendMessage({
        role: 'assistant',
        text: result.reply,
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        entryIds: result.entries?.map((entry) => entry.id),
        numericChoiceId: result.numericChoiceId,
        proposalId: result.proposal?.id,
      });
      if (result.records && result.entries?.[0]) onResults(result.entries);
      if (result.openId) onOpenEntry(result.openId);
      setInput('');
      voice.speak(result.reply);
    } catch (error) {
      if (current.controller.signal.aborted) return;
      lastSend.current = { text: '', at: 0 };
      setInput(current.text);
      appendMessage({
        role: 'assistant',
        text:
          (error instanceof Error && error.message) ||
          'Не удалось обработать запрос. Попробуйте ещё раз.',
        error: true,
        retry: current.text,
        at: new Date().toISOString(),
      });
    } finally {
      if (activeRequest.current === current) {
        activeRequest.current = null;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    persist('voicetask.ai.conversation.v1', conversationId);
  }, [conversationId]);
  useEffect(() => {
    if (!chatBlocked) persist('voicetask.chat.v1', messages);
    messageEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [messages, chatBlocked]);

  function clearHistory() {
    if (persist('voicetask.chat.v1', greeting)) {
      setMessages(greeting);
      setChatBlocked(false);
      updateContext({});
      setProposal(null);
      steps.current = [];
      setConversationId(crypto.randomUUID());
      setClearChat(false);
    }
  }
  function cancelRequest() {
    const request = activeRequest.current;
    if (!request) return;
    request.controller.abort();
    activeRequest.current = null;
    voice.cancel();
    setBusy(false);
    if (request.text) setInput(request.text);
    lastSend.current = { text: '', at: 0 };
    appendMessage({
      role: 'assistant',
      text: 'Запрос отменён. Можно изменить сообщение и отправить снова.',
    });
  }
  function revise(field?: 'date' | 'time' | 'title') {
    if (activeRequest.current) return;
    if (Date.now() - (context.current.updatedAt || 0) > 30 * 60000) {
      updateContext({});
      steps.current = [];
      appendMessage({
        role: 'assistant',
        text: 'Черновик устарел. Укажите задачу, дату и время заново.',
      });
      return;
    }
    const step = field ? editDraft(context.current, field) : steps.current.pop();
    if (!step) return;
    if (field) remember(snapshot());
    const result = restoreStep(step);
    updateContext(result.context);
    appendMessage({
      role: 'assistant',
      text: result.reply,
      numericChoiceId: result.numericChoiceId,
      at: new Date().toISOString(),
    });
  }
  useEffect(() => () => activeRequest.current?.controller.abort(), []);
  return {
    input,
    chatBlocked,
    messages,
    busy,
    clearChat,
    setClearChat,
    sendMessage,
    voice,
    context,
    messageEnd,
    clearHistory,
    cancelRequest,
    revise,
    canBack: steps.current.length > 0,
    canRevise: !!context.current.pending?.intent.startsWith('create'),
    proposal,
  };
}
