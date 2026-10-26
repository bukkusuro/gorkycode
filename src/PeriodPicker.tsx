import { useEffect, useRef, useState } from 'react';
import { addDays, dateKey, formatDate, weekStart } from './calendar';
import { selectMonth } from './eventLayout';

export default function PeriodPicker({
  date,
  period,
  today,
  choose,
  close,
}: {
  date: Date;
  period: string;
  today: string;
  choose: (date: Date) => void;
  close: () => void;
}) {
  const [draft, setDraft] = useState(date);
  const [range, setRange] = useState(() => [date.getFullYear() - 50, date.getFullYear() + 50]);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current
      ?.querySelectorAll<HTMLElement>('[aria-selected=true]')
      .forEach((option) => option.scrollIntoView({ block: 'center' }));
  }, []);
  const year = draft.getFullYear(),
    month = draft.getMonth();
  const selectedDay = dateKey(draft);
  const wheel = (
    label: string,
    values: number[],
    current: number,
    change: (value: number) => void,
    render: (value: number) => string,
  ) => (
    <div
      className="period-wheel"
      role="listbox"
      aria-label={label}
      tabIndex={0}
      onKeyDown={(e) => {
        const step =
          e.key === 'ArrowDown'
            ? 1
            : e.key === 'ArrowUp'
              ? -1
              : e.key === 'PageDown'
                ? 10
                : e.key === 'PageUp'
                  ? -10
                  : 0;
        if (step) {
          e.preventDefault();
          const index = Math.max(0, Math.min(values.length - 1, values.indexOf(current) + step));
          change(values[index]);
          e.currentTarget
            .querySelectorAll<HTMLElement>('[role=option]')
            [index]?.scrollIntoView({ block: 'nearest' });
        }
      }}
    >
      {values.map((value) => (
        <button
          key={value}
          role="option"
          aria-selected={value === current}
          tabIndex={-1}
          onClick={() => change(value)}
        >
          {render(value)}
        </button>
      ))}
    </div>
  );
  const start = weekStart(new Date(year, month, 1));
  return (
    <div ref={root} className="period-picker">
      <h2 id="modal-title">
        {period === 'День'
          ? 'Выберите дату'
          : period === 'Год'
            ? 'Выберите год'
            : 'Выберите месяц и год'}
      </h2>
      <div className="period-wheels">
        {period !== 'Год' &&
          wheel(
            'Месяц',
            Array.from({ length: 12 }, (_, i) => i),
            month,
            (value) => setDraft(selectMonth(draft, year, value)),
            (value) => formatDate(new Date(2024, value, 1), { month: 'long' }),
          )}
        {wheel(
          'Год',
          Array.from({ length: range[1] - range[0] + 1 }, (_, i) => range[0] + i),
          year,
          (value) => setDraft(selectMonth(draft, value, month)),
          String,
        )}
      </div>
      <div className="year-range">
        <button onClick={() => setRange([Math.max(100, range[0] - 100), range[1]])}>
          Ранние годы
        </button>
        <button onClick={() => setRange([range[0], Math.min(9998, range[1] + 100)])}>
          Поздние годы
        </button>
      </div>
      {period === 'День' && (
        <>
          <div className="picker-days">
            {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((day) => (
              <span key={day}>{day}</span>
            ))}
            {Array.from({ length: 42 }, (_, i) => {
              const day = addDays(start, i),
                key = dateKey(day);
              return (
                <button
                  key={key}
                  className={`${day.getMonth() !== month ? 'muted' : ''} ${key === today ? 'today' : ''} ${key === selectedDay ? 'selected' : ''}`}
                  aria-label={formatDate(day, { day: 'numeric', month: 'long', year: 'numeric' })}
                  onClick={() => choose(day)}
                >
                  {day.getDate()}
                </button>
              );
            })}
          </div>
          <button className="today-button" onClick={() => choose(new Date(`${today}T12:00:00`))}>
            Сегодня
          </button>
        </>
      )}
      <div className="modal-actions">
        <button onClick={close}>Отмена</button>
        <button className="primary-button" onClick={() => choose(draft)}>
          Применить
        </button>
      </div>
    </div>
  );
}
