import { useState } from 'react';
import { Check, Palette, Pipette } from 'lucide-react';
import { type Entry, colors, entryTypes, entryColor, validEntry, validColor } from './calendar';
import { commentOf, endParts, toInstant, wallParts } from './model';
import { validRecurrence, validDay } from './recurrence';
export default function EntryForm({
  initial,
  exists,
  zone,
  taskColor,
  meetingColor,
  eventColor = colors[2],
  save,
}: {
  initial: Entry;
  exists: boolean;
  zone: string;
  taskColor: string;
  meetingColor: string;
  eventColor?: string;
  save: (entry: Entry) => void;
}) {
  const [entry, set] = useState(() => ({
    ...initial,
    duration:
      initial.startAt && !initial.atTime
        ? (Date.parse(initial.endAt!) - Date.parse(initial.startAt)) / 60000
        : initial.duration,
  }));
  const [mode, setMode] = useState('end');
  const [end, setEnd] = useState(() => endParts(initial));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const zoned = !!initial.startAt || !exists;
  const recurrence = entry.recurrence;
  const weekdays =
    recurrence?.frequency === 'weekly'
      ? recurrence.weekdays || [new Date(`${entry.date}T12:00:00`).getDay()]
      : [];
  const hours = Math.floor(entry.duration / 60),
    minutes = entry.duration % 60;
  const comment = commentOf(entry);
  const resolveStart = (value: Entry) =>
    initial.startAt && value.date === initial.date && value.time === initial.time
      ? initial.startAt
      : toInstant(value.date, value.time, zone);
  const resolveEnd = () => {
    const old = initial.endAt ? wallParts(initial.endAt, zone) : null;
    return old && old.date === end.date && old.time === end.time
      ? initial.endAt!
      : toInstant(end.date, end.time, zone);
  };
  const calculatedEnd = (value: Entry) => {
    try {
      return zoned
        ? wallParts(new Date(Date.parse(resolveStart(value)) + value.duration * 60000), zone)
        : endParts(value);
    } catch {
      return { date: '', time: '' };
    }
  };
  const change = (patch: Partial<Entry>) => {
    const next = { ...entry, ...patch };
    set(next);
    if (mode === 'duration') setEnd(calculatedEnd(next));
  };
  const changeType = (type: Entry['type']) => {
    const next = {
      ...entry,
      type,
      ...(type !== 'task' ? { allDay: false } : {}),
      ...([taskColor, meetingColor, eventColor].includes(entry.color)
        ? { color: entryColor(type, { taskColor, meetingColor, eventColor }) }
        : {}),
    };
    change(next);
  };
  const changeAtTime = (atTime: boolean) => {
    const next = { ...entry, atTime, allDay: false, duration: atTime ? 0 : 60 };
    change(next);
    if (!atTime) setEnd(calculatedEnd(next));
  };
  const changeAllDay = (allDay: boolean) => {
    const next = { ...entry, allDay, atTime: false, duration: entry.atTime ? 60 : entry.duration };
    change(next);
    if (entry.atTime) setEnd(calculatedEnd(next));
  };
  const localDuration = () => {
    try {
      return zoned
        ? (Date.parse(resolveEnd()) - Date.parse(resolveStart(entry))) / 60000
        : (Date.parse(`${end.date}T${end.time}:00Z`) -
            Date.parse(`${entry.date}T${entry.time}:00Z`)) /
            60000;
    } catch {
      return NaN;
    }
  };
  const switchMode = (next: string) => {
    if (next === 'duration') set({ ...entry, duration: localDuration() });
    else setEnd(calculatedEnd(entry));
    setMode(next);
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const e: Record<string, string> = {};
    if (!entry.title.trim()) e.title = 'Введите название';
    if (!validColor(entry.color)) e.color = 'Выберите цвет в формате #RRGGBB';
    if (entry.deadline && (!validDay(entry.deadline) || entry.date > entry.deadline))
      e.deadline = 'Срок должен быть не раньше запланированной даты';
    if (
      entry.recurrence &&
      (!validRecurrence(entry.recurrence) ||
        (entry.recurrence.until && entry.recurrence.until < entry.date))
    )
      e.end = 'Проверьте правило повторения и дату окончания';
    const duration = entry.atTime
      ? 0
      : entry.allDay
        ? 1440
        : mode === 'end'
          ? localDuration()
          : entry.duration;
    if (!entry.atTime && (!Number.isFinite(duration) || duration < 5 || duration > 5256000))
      e.end = 'Продолжительность от 5 минут до 10 лет; окончание должно быть позже начала';
    const candidate = { ...entry, duration, description: comment };
    if (entry.allDay) {
      candidate.time = '00:00';
      candidate.startAt = undefined;
      candidate.endAt = undefined;
    }
    if (entry.atTime) candidate.endAt = undefined;
    if (
      !validEntry({ ...candidate, startAt: undefined, endAt: undefined }) &&
      !Object.keys(e).length
    )
      e.start = 'Проверьте дату и время начала';
    if (!Object.keys(e).length) {
      try {
        if (!entry.allDay && zoned) {
          candidate.startAt = resolveStart(entry);
          if (!entry.atTime) {
            candidate.endAt =
              mode === 'end'
                ? resolveEnd()
                : new Date(Date.parse(candidate.startAt) + duration * 60000).toISOString();
            if (Date.parse(candidate.endAt) <= Date.parse(candidate.startAt))
              throw Error('Окончание должно быть позже начала');
            candidate.duration =
              (Date.parse(candidate.endAt) - Date.parse(candidate.startAt)) / 60000;
          }
        }
        if (!validEntry(candidate)) throw Error('Проверьте даты и продолжительность');
        save({ ...candidate, title: candidate.title.trim() });
      } catch (error) {
        e.end = (error as Error).message;
      }
    }
    setErrors(e);
  };
  const error = (key: string) =>
    errors[key] && (
      <span className="field-error" role="alert">
        {errors[key]}
      </span>
    );
  return (
    <form onSubmit={submit} noValidate>
      <h2 id="modal-title">{exists ? 'Редактировать запись' : 'Новая запись'}</h2>
      <p className="hint">
        {zoned
          ? zone
          : initial.importKey
            ? 'Импортированная запись: местные дата и время'
            : 'Старая запись: местное время без привязки к часовому поясу'}
      </p>
      <label>
        Название
        <input
          autoFocus
          value={entry.title}
          maxLength={150}
          onChange={(e) => change({ title: e.target.value })}
        />
        {error('title')}
      </label>
      <label>
        Тип
        <select value={entry.type} onChange={(e) => changeType(e.target.value as Entry['type'])}>
          {Object.entries(entryTypes).map(([type, { label }]) => (
            <option key={type} value={type}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {entry.type === 'task' && (
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={!!entry.allDay}
            onChange={(e) => changeAllDay(e.target.checked)}
          />
          Без точного времени
        </label>
      )}
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={!!entry.atTime}
          onChange={(e) => changeAtTime(e.target.checked)}
        />
        Только на указанное время, без длительности
      </label>
      <div className="form-row">
        <label>
          Дата начала
          <input
            type="date"
            value={entry.date}
            onChange={(e) => change({ date: e.target.value })}
          />
          {error('start')}
        </label>
        {!entry.allDay && (
          <label>
            Время начала
            <input
              type="time"
              value={entry.time}
              onChange={(e) => change({ time: e.target.value })}
            />
          </label>
        )}
      </div>
      {!entry.allDay && !entry.atTime && (
        <>
          <label>
            Способ задания окончания
            <select value={mode} onChange={(e) => switchMode(e.target.value)}>
              <option value="end">Дата и время окончания</option>
              <option value="duration">Продолжительность</option>
            </select>
          </label>
          {mode === 'end' ? (
            <div className="form-row">
              <label>
                Дата окончания
                <input
                  type="date"
                  value={end.date}
                  onChange={(e) => setEnd({ ...end, date: e.target.value })}
                />
              </label>
              <label>
                Время окончания
                <input
                  type="time"
                  value={end.time}
                  onChange={(e) => setEnd({ ...end, time: e.target.value })}
                />
              </label>
            </div>
          ) : (
            <div className="form-row">
              <label>
                Часы
                <input
                  type="number"
                  min={0}
                  value={hours || 0}
                  onChange={(e) => change({ duration: Number(e.target.value) * 60 + minutes })}
                />
              </label>
              <label>
                Минуты
                <input
                  type="number"
                  min={0}
                  max={59}
                  value={minutes || 0}
                  onChange={(e) => change({ duration: hours * 60 + Number(e.target.value) })}
                />
              </label>
            </div>
          )}
        </>
      )}
      {error('end')}
      {entry.type === 'task' && (
        <label>
          Крайний срок (необязательно)
          <input
            type="date"
            value={entry.deadline || ''}
            onChange={(e) => change({ deadline: e.target.value || undefined })}
          />
          {error('deadline')}
        </label>
      )}
      <label>
        Повторение
        <select
          value={entry.recurrence?.frequency || ''}
          onChange={(e) =>
            change({
              recurrence: e.target.value
                ? { frequency: e.target.value as 'daily' | 'weekly' | 'monthly' }
                : undefined,
            })
          }
        >
          <option value="">Не повторять</option>
          <option value="daily">Ежедневно</option>
          <option value="weekly">Еженедельно</option>
          <option value="monthly">Ежемесячно</option>
        </select>
      </label>
      {recurrence && (
        <>
          <label>
            Повторять до (необязательно)
            <input
              type="date"
              min={entry.date}
              value={recurrence.until || ''}
              onChange={(e) =>
                change({ recurrence: { ...recurrence, until: e.target.value || undefined } })
              }
            />
          </label>
          {recurrence.frequency === 'weekly' && (
            <fieldset>
              <legend>Дни недели</legend>
              {['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'].map((day, i) => (
                <label key={day} className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={weekdays.includes(i)}
                    onChange={(e) =>
                      change({
                        recurrence: {
                          ...recurrence,
                          weekdays: e.target.checked
                            ? [...weekdays, i]
                            : weekdays.filter((d) => d !== i),
                        },
                      })
                    }
                  />
                  {day}
                </label>
              ))}
            </fieldset>
          )}
        </>
      )}
      <label>
        Комментарий
        <textarea
          rows={4}
          value={comment}
          onChange={(e) => change({ description: e.target.value, comment: e.target.value })}
        />
      </label>
      <div className="color-label">Цвет записи</div>
      <div className="color-options">
        {colors.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`Цвет ${c}`}
            aria-pressed={entry.color === c}
            className={entry.color === c ? 'selected' : ''}
            style={{ background: c }}
            onClick={() => change({ color: c })}
          >
            {entry.color === c && <Check size={16} />}
          </button>
        ))}
        <label className="custom-color" title="Свой цвет">
          <Palette size={18} />
          <Pipette size={16} />
          <input
            aria-label="Свой цвет"
            type="color"
            value={entry.color}
            onChange={(e) => change({ color: e.target.value })}
          />
        </label>
      </div>
      {error('color')}
      <div className="color-preview" style={{ background: entry.color }}>
        Предпросмотр: {entry.title || 'Новая запись'}
      </div>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={entry.important}
          onChange={(e) => change({ important: e.target.checked })}
        />
        Важная запись
      </label>
      {entry.type === 'task' && (
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={!!entry.completed}
            onChange={(e) => change({ completed: e.target.checked })}
          />
          Задача выполнена
        </label>
      )}
      <div className="modal-actions">
        <button type="submit" className="primary-button">
          <Check size={16} />
          Сохранить
        </button>
      </div>
    </form>
  );
}
