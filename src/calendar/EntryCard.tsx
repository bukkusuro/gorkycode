import { memo } from 'react';
import { CalendarDays, Check, FilePenLine, UserRound } from 'lucide-react';
import { type Entry, entryTypes } from '../calendar';
import { type Preferences, commentOf, endParts } from '../model';
export default memo(function EntryCard({
  entry: e,
  compact = false,
  prefs,
  onOpen,
  onToggle,
}: {
  entry: Entry;
  compact?: boolean;
  prefs: Preferences;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const finish = endParts(e);
  const endTime = finish.date !== e.date && finish.time === '00:00' ? '24:00' : finish.time;
  const timeLabel = e.allDay ? 'Без времени' : e.atTime ? e.time : `${e.time} – ${endTime}`;
  const comment = commentOf(e);
  return (
    <article
      key={e.id}
      title={`${e.title} · ${timeLabel} · ${entryTypes[e.type].label}${e.important ? ' · Важно' : ''}`}
      className={`event-card ${compact ? 'compact' : ''} ${e.important ? 'important-card' : ''} ${e.completed ? 'completed' : ''}`}
      style={{ background: e.color }}
    >
      {e.important && (
        <b className="importance-mark priority-mark" aria-label="Важная или срочная запись">
          !
        </b>
      )}
      <button
        className="card-open"
        onClick={(event) => {
          event.stopPropagation();
          onOpen(e.id);
        }}
        aria-label={`Открыть ${e.title}`}
      >
        <strong>{e.title}</strong>
        <div className="event-top">
          <span>{timeLabel}</span>
          {e.type === 'task' ? (
            <FilePenLine size={18} />
          ) : e.type === 'meeting' ? (
            <UserRound size={18} />
          ) : (
            <CalendarDays size={18} />
          )}
        </div>
        <span className="event-type">
          {entryTypes[e.type].label}
          {e.important && (
            <>
              {' '}
              · <b className="priority-mark">!</b>
            </>
          )}
        </span>
        {prefs.density !== 'standard' && comment && (
          <span className={`card-comment ${prefs.density === 'brief' ? 'brief' : 'full'}`}>
            {comment}
          </span>
        )}
      </button>
      {e.type === 'task' && (
        <button
          type="button"
          className="completion"
          aria-label={`${e.completed ? 'Снять выполнение' : 'Выполнить'}: ${e.title}`}
          aria-pressed={!!e.completed}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(e.id);
          }}
        >
          {e.completed && <Check size={12} aria-hidden="true" />}
        </button>
      )}
    </article>
  );
});
