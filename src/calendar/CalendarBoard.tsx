import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import { type Entry, dateKey, formatDate, minutes } from '../calendar';
import { type Preferences, dateLabel, weekNumber } from '../model';
import MonthGrid from './MonthGrid';
import type { useCalendarData } from './useCalendarData';
type Props = ReturnType<typeof useCalendarData> & {
  date: Date;
  period: Preferences['defaultPeriod'];
  prefs: Preferences;
  timeScroll: RefObject<HTMLDivElement | null>;
  onPeriod: () => void;
  onToday: () => void;
  onNavigate: (direction: number) => void;
  onDay: (day: string) => void;
  onMonth: (month: number) => void;
  onAdd: (day: Date, time?: string) => void;
  renderEntry: (entry: Entry, compact?: boolean) => ReactNode;
};
export default function CalendarBoard({
  date,
  period,
  prefs,
  timeScroll,
  onPeriod,
  onToday,
  onNavigate,
  onDay,
  onMonth,
  onAdd,
  renderEntry: card,
  eventsOnDay,
  today,
  todayKey,
  hours,
  dayData,
  gridColumns,
  gridMinimum,
}: Props) {
  const monthGrid = (date: Date, mini = false) => (
    <MonthGrid
      date={date}
      mini={mini}
      prefs={prefs}
      todayKey={todayKey}
      eventsOnDay={eventsOnDay}
      onDay={onDay}
      onAdd={onAdd}
      renderEntry={card}
    />
  );
  return (
    <section className="calendar">
      <div className="calendar-heading">
        <div className="calendar-title">
          <CalendarDays size={21} />
          <h2>
            <button className="period-trigger" aria-haspopup="dialog" onClick={onPeriod}>
              {period === 'Год'
                ? date.getFullYear()
                : period === 'День'
                  ? dateLabel(dateKey(date), prefs.dateFormat)
                  : formatDate(date, { month: 'long', year: 'numeric' })}
              <ChevronDown size={16} />
            </button>
          </h2>
          {prefs.weekNumbers && <span>Неделя {weekNumber(date)}</span>}
        </div>
        <div className="date-navigation">
          {(period === 'День' || period === 'Неделя') && (
            <button className="today-button" onClick={() => onDay(dateKey(date))}>
              Список дня
            </button>
          )}
          <button className="today-button" onClick={onToday}>
            Сегодня
          </button>
          <button
            className="icon-button"
            aria-label="Предыдущий период"
            onClick={() => onNavigate(-1)}
          >
            <ChevronLeft />
          </button>
          <button
            className="icon-button"
            aria-label="Следующий период"
            onClick={() => onNavigate(1)}
          >
            <ChevronRight />
          </button>
        </div>
      </div>
      {(period === 'День' || period === 'Неделя') && (
        <div className={`time-calendar ${period === 'День' ? 'day-view' : ''}`}>
          <div
            className="day-headers"
            style={{ gridTemplateColumns: gridColumns, minWidth: gridMinimum }}
          >
            <div className="timezone" title={prefs.zone}>
              {new Intl.DateTimeFormat('ru', { timeZone: prefs.zone, timeZoneName: 'shortOffset' })
                .formatToParts(new Date())
                .find((p) => p.type === 'timeZoneName')
                ?.value.replace('GMT', 'UTC')}
            </div>
            {dayData.map(({ date: d, key, entries, simultaneous }) => (
              <button
                key={key}
                className={`day-header ${prefs.highlight && dateKey(d) === todayKey ? 'current' : ''}`}
                onClick={() => {
                  onDay(dateKey(d));
                }}
              >
                <span>{formatDate(d, { weekday: 'short' })}</span>
                <b>{d.getDate()}</b>
                <small>{entries.length}</small>
                {simultaneous > 0 && (
                  <small
                    className="simultaneous-count"
                    title="Несколько записей назначены на одно время"
                  >
                    Совпадают: {simultaneous}
                  </small>
                )}
              </button>
            ))}
          </div>
          {dayData.some((day) => day.allDay.length > 0) && (
            <div
              className="untimed-row"
              style={{ gridTemplateColumns: gridColumns, minWidth: gridMinimum }}
            >
              <small>Без времени</small>
              {dayData.map((day) => (
                <div key={day.key}>{day.allDay.map((entry) => card(entry, true))}</div>
              ))}
            </div>
          )}
          <div className="time-scroll" ref={timeScroll} style={{ minWidth: gridMinimum }}>
            <div
              className="time-grid"
              style={{
                gridTemplateColumns: gridColumns,
                minWidth: gridMinimum,
                height: hours.length * 90 + (prefs.text === 'large' ? 112 : 88),
              }}
            >
              <div className="time-labels">
                {hours.map((h) => (
                  <div key={h}>{String(h).padStart(2, '0')}:00</div>
                ))}
              </div>
              {dayData.map(({ date: day, key, layout }) => {
                return (
                  <div
                    key={dateKey(day)}
                    className={`day-column ${prefs.highlight && dateKey(day) === todayKey ? 'current-column' : ''}`}
                  >
                    {hours.map((h) => (
                      <button
                        key={h}
                        className="hour-slot"
                        aria-label={`Добавить запись: ${dateKey(day)}, ${h}:00`}
                        onClick={() => onAdd(day, `${String(h).padStart(2, '0')}:00`)}
                      />
                    ))}
                    {layout.visible.map((v) => {
                      const lanes = Math.min(v.lanes, 3);
                      return (
                        <div
                          key={v.e.id}
                          className="event-position"
                          style={{
                            top: v.top,
                            height: v.height,
                            left: `calc(${(v.lane / lanes) * 100}% + 3px)`,
                            width: `calc(${100 / lanes}% - 6px)`,
                          }}
                        >
                          {card(v.e)}
                        </div>
                      );
                    })}
                    {layout.overflow.map(({ group, top, count }) => (
                      <button
                        key={group}
                        className="timed-more"
                        style={{ top, left: 'calc(66.666% + 3px)', width: 'calc(33.333% - 6px)' }}
                        onClick={() => onDay(key)}
                      >
                        Ещё {count}
                        <span>Открыть список</span>
                      </button>
                    ))}
                    {dateKey(day) === todayKey &&
                      minutes(today.time) >= prefs.hourStart * 60 &&
                      minutes(today.time) < prefs.hourEnd * 60 && (
                        <div
                          className="now-line"
                          style={{ top: (minutes(today.time) - prefs.hourStart * 60) * 1.5 }}
                        />
                      )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
      {period === 'Месяц' && monthGrid(date)}
      {period === 'Год' && (
        <div className="year-grid">
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} className="mini-month">
              <button
                className="month-name"
                onClick={() => {
                  onMonth(i);
                }}
              >
                {formatDate(new Date(date.getFullYear(), i, 1), { month: 'long' })}
                <ChevronRight size={16} />
              </button>
              {monthGrid(new Date(date.getFullYear(), i, 1), true)}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
