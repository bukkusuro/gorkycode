import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { type Entry, addDays, dateKey, weekStart } from '../calendar';
import { type Preferences, dateLabel, weekNumber } from '../model';
export type DayEntries = (day: string) => { entry: Entry; part: Entry }[];
export default function MonthGrid({
  date: monthDate,
  mini = false,
  prefs,
  todayKey,
  eventsOnDay,
  onDay,
  onAdd,
  renderEntry: card,
}: {
  date: Date;
  mini?: boolean;
  prefs: Preferences;
  todayKey: string;
  eventsOnDay: DayEntries;
  onDay: (key: string) => void;
  onAdd: (day: Date) => void;
  renderEntry: (entry: Entry, compact?: boolean) => ReactNode;
}) {
  const start = weekStart(new Date(monthDate.getFullYear(), monthDate.getMonth(), 1));
  return (
    <div className={mini ? 'mini-grid' : 'month-grid'}>
      {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((d) => (
        <div className="month-weekday" key={d}>
          {d}
        </div>
      ))}
      {Array.from({ length: 42 }, (_, i) => {
        const day = addDays(start, i),
          key = dateKey(day),
          list = eventsOnDay(key);
        const dots = mini && (
          <span className="event-dots">
            {list.slice(0, 3).map(({ part: e }) => (
              <i key={e.id} style={{ background: e.color }} />
            ))}
            {list.length > 3 && <small>+{list.length - 3}</small>}
          </span>
        );
        const click = () => {
          onDay(key);
        };
        return mini ? (
          <button
            key={key}
            title={`${dateLabel(key, prefs.dateFormat)}: ${list.length} записей`}
            className={`${day.getMonth() !== monthDate.getMonth() ? 'muted' : ''} ${prefs.highlight && key === todayKey ? 'is-today' : ''}`}
            aria-label={`${dateLabel(key, prefs.dateFormat)}, записей: ${list.length}`}
            onClick={click}
          >
            {day.getDate()}
            {dots}
          </button>
        ) : (
          <div
            key={key}
            className={`month-cell ${day.getMonth() !== monthDate.getMonth() ? 'outside' : ''}`}
            onClick={(event) => {
              if (event.target === event.currentTarget) click();
            }}
          >
            <button
              className={`date-number ${prefs.highlight && key === todayKey ? 'is-today' : ''}`}
              onClick={click}
            >
              {day.getDate()}
            </button>
            {prefs.weekNumbers && i % 7 === 0 && (
              <small className="week-number">н. {weekNumber(day)}</small>
            )}
            <button className="cell-add" aria-label="Добавить запись" onClick={() => onAdd(day)}>
              <Plus size={14} />
            </button>
            {list.slice(0, 3).map(({ part }) => card(part, true))}
            {list.length > 3 && (
              <button className="more-events" onClick={click}>
                Ещё {list.length - 3}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
