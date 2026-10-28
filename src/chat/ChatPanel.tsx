import { memo, useState } from 'react';
import { ArrowUp, ChevronRight, CircleHelp, Mic, Plus, Square, Trash2 } from 'lucide-react';
import { assistantText } from '../assistantTypes';
import { type ChatOptions, useAssistantChat } from './useAssistantChat';
import { wallParts } from '../model';
import { validDay } from '../recurrence';
export default memo(function ChatPanel(props: ChatOptions) {
  const { prefs, onOpenEntry } = props;
  const today = wallParts(new Date(), prefs.zone).date;
  const [choosingDay, setChoosingDay] = useState(false);
  const [planDay, setPlanDay] = useState(today);
  const {
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
    canBack,
    canRevise,
    proposal,
  } = useAssistantChat(props);
  return (
    <aside className="assistant-panel">
      <a className="brand" href="./" aria-label="ВОКСА — на главную">
        <span className="brand-logo" role="img" aria-label="ВОКСА" />
      </a>
      <section className="chat">
        <div className="chat-heading">
          <div>
            <strong>Ассистент Вокса</strong>
          </div>
          <button
            className="icon-button"
            aria-label="Помощь по командам"
            disabled={busy}
            onClick={() => void sendMessage('помощь')}
          >
            <CircleHelp size={18} />
          </button>
          <button
            className="icon-button"
            aria-label="Очистить историю чата"
            disabled={busy}
            onClick={() => setClearChat(true)}
          >
            <Trash2 size={15} />
          </button>
        </div>
        <div className="messages" aria-live="polite">
          <div className="chat-date">Сегодня</div>
          {messages.map((m, i) => (
            <div key={i} className={`message ${m.role}`}>
              <div>
                <div className={`message-bubble ${m.error ? 'message-error' : ''}`}>
                  {m.role === 'assistant' ? assistantText(m.text) : m.text}
                </div>
                {m.numericChoiceId && (
                  <div className="chat-choices" role="group" aria-label="Это время или дата?">
                    {['Время', 'Дата'].map((label) => (
                      <button
                        key={label}
                        type="button"
                        disabled={
                          busy ||
                          !context.current.numeric ||
                          !('questionId' in context.current.numeric) ||
                          context.current.numeric.questionId !== m.numericChoiceId
                        }
                        onClick={() => void sendMessage(label, m.numericChoiceId)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                {m.proposalId && (
                  <div
                    className="chat-choices plan-actions"
                    role="group"
                    aria-label="Подтверждение плана"
                  >
                    <button
                      type="button"
                      disabled={busy || proposal?.id !== m.proposalId}
                      onClick={() => void sendMessage('Применить план', undefined, m.proposalId)}
                    >
                      Применить план
                    </button>
                    <button
                      type="button"
                      disabled={busy || proposal?.id !== m.proposalId}
                      onClick={() => void sendMessage('Отменить план', undefined, m.proposalId)}
                    >
                      Отмена
                    </button>
                  </div>
                )}
                <small>
                  {m.role === 'assistant' ? 'Вокса' : 'Вы'}
                  {m.at && (
                    <>
                      {' '}
                      ·{' '}
                      <time dateTime={m.at}>
                        {new Date(m.at).toLocaleString('ru-RU', {
                          timeZone: prefs.zone,
                          day: '2-digit',
                          month: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                    </>
                  )}
                </small>
                {m.retry && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => void sendMessage(m.retry)}
                  >
                    Повторить запрос
                  </button>
                )}
                {m.entryIds?.map((id, j) => (
                  <button
                    key={`${id}-${j}`}
                    className="chat-entry-link"
                    onClick={() => onOpenEntry(id)}
                  >
                    Открыть запись {j + 1}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {messages.length === 1 && (
            <div className="chat-suggestions">
              <span>Попробуйте, например</span>
              <button onClick={() => sendMessage('задача Подготовить презентацию; завтра; 14:00')}>
                Добавить задачу на завтра <Plus size={14} />
              </button>
              <button onClick={() => sendMessage('помощь')}>
                Какие команды доступны? <ChevronRight size={14} />
              </button>
            </div>
          )}
          <div ref={messageEnd} />
        </div>
        <div className="chat-compose">
          <div className="planning-shortcuts" aria-label="Планирование и аналитика">
            <button
              disabled={busy}
              aria-expanded={choosingDay}
              aria-controls="planning-day-picker"
              onClick={() => {
                setPlanDay(props.selectedDay >= today ? props.selectedDay : today);
                setChoosingDay(!choosingDay);
              }}
            >
              Перестроить день
            </button>
            <button
              disabled={busy}
              onClick={() => void sendMessage('Покажи недельный отчёт по выполнению задач')}
            >
              Отчёт за неделю
            </button>
          </div>
          {choosingDay && (
            <form
              id="planning-day-picker"
              className="planning-day-picker"
              onSubmit={(event) => {
                event.preventDefault();
                if (busy || !validDay(planDay) || planDay < today) return;
                setChoosingDay(false);
                void sendMessage(
                  `Перестрой расписание на ${planDay} так, чтобы я закончил самое важное`,
                );
              }}
            >
              <label>
                Какой день перестроить?
                <input
                  type="date"
                  aria-label="Дата перепланирования"
                  value={planDay}
                  min={today}
                  required
                  autoFocus
                  disabled={busy}
                  onChange={(event) => setPlanDay(event.target.value)}
                />
              </label>
              <span className="hint">Сегодня или любой будущий день.</span>
              <div className="chat-choices">
                <button type="submit" disabled={busy || !validDay(planDay) || planDay < today}>
                  Предложить план
                </button>
                <button type="button" onClick={() => setChoosingDay(false)}>
                  Отмена
                </button>
              </div>
            </form>
          )}
          {chatBlocked && (
            <p className="field-error" role="alert">
              Сохранённая история повреждена или недоступна. Исходные данные оставлены без
              изменений; новые сообщения пока не сохраняются. Очистка истории доступна по
              подтверждению.
            </p>
          )}
          {busy && (
            <div className="chat-request-status">
              <span role="status">Обрабатываю запрос…</span>
              <button type="button" onClick={cancelRequest}>
                Отменить запрос
              </button>
            </div>
          )}
          {!busy && (canBack || canRevise) && (
            <div className="draft-controls" aria-label="Исправить запись">
              {canBack && (
                <button type="button" onClick={() => revise()}>
                  Назад
                </button>
              )}
              {canRevise && (
                <>
                  <button type="button" onClick={() => revise('date')}>
                    Дата
                  </button>
                  <button type="button" onClick={() => revise('time')}>
                    Время
                  </button>
                  <button type="button" onClick={() => revise('title')}>
                    Название
                  </button>
                </>
              )}
            </div>
          )}
          {clearChat && (
            <div className="chat-confirm">
              <p>Очистить только историю чата?</p>
              <button disabled={busy} onClick={clearHistory}>
                Очистить
              </button>
              <button onClick={() => setClearChat(false)}>Отмена</button>
            </div>
          )}
          <div className="voice-controls">
            <button aria-pressed={voice.enabled} onClick={voice.toggleVoice}>
              Голосовой ответ: {voice.enabled ? 'вкл.' : 'выкл.'}
            </button>
            {voice.speaking && <button onClick={voice.stopSpeaking}>Остановить озвучивание</button>}
          </div>
          {(voice.listening || voice.requesting || voice.transcribing) && (
            <div className="recording-status" role="status">
              <span>
                {voice.requesting
                  ? 'Подключаю микрофон…'
                  : voice.transcribing
                    ? 'Распознаю речь…'
                    : 'Слушаю… Нажмите микрофон, когда закончите.'}
              </span>
              <button onClick={voice.cancel}>Отмена</button>
            </div>
          )}
          {voice.error && (
            <p className="field-error" role="alert">
              {voice.error}
            </p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendMessage();
            }}
          >
            <textarea
              disabled={busy || voice.transcribing || voice.requesting}
              aria-label="Сообщение ассистенту"
              placeholder="Напишите сообщение…"
              maxLength={4000}
              value={input}
              onChange={(e) => voice.edit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void sendMessage();
                }
              }}
              rows={1}
            />
            <div className="compose-bottom">
              <button
                type="button"
                className={`icon-button mic ${voice.listening ? 'recording' : ''}`}
                aria-pressed={voice.listening}
                aria-label={
                  voice.listening
                    ? 'Остановить запись'
                    : voice.requesting
                      ? 'Отменить подключение микрофона'
                      : 'Голосовой ввод'
                }
                title={
                  voice.listening ? 'Остановить запись и распознать речь' : 'Продиктовать сообщение'
                }
                disabled={busy || voice.transcribing}
                onClick={() => void voice.toggleMic()}
              >
                {voice.listening ? <Square size={19} fill="currentColor" /> : <Mic size={22} />}
              </button>
              <span>Проверьте текст перед отправкой</span>
              <button
                type="submit"
                className="send-button"
                aria-label="Отправить сообщение"
                disabled={
                  (!input.trim() && !voice.listening) ||
                  busy ||
                  voice.transcribing ||
                  voice.requesting
                }
              >
                <ArrowUp size={19} />
              </button>
            </div>
          </form>
        </div>
      </section>
    </aside>
  );
});
