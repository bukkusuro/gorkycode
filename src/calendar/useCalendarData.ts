import { useMemo } from 'react';
import { type Entry, addDays, dateKey, entryTypes, weekStart } from '../calendar';
import { compactLayout, countSimultaneous, layoutEvents } from '../eventLayout';
import { type Preferences, displayEntry, endParts, segment, wallParts } from '../model';
import { expandEntries, shiftDay } from '../recurrence';
export function useCalendarData(
  entries: Entry[],
  prefs: Preferences,
  date: Date,
  period: Preferences['defaultPeriod'],
  showWeekend: boolean,
  filter: string,
  now: Date,
) {
  const year = date.getFullYear();
  const shown = useMemo(
    () =>
      expandEntries(entries, `${year - 1}-12-01`, `${year + 1}-01-31`, prefs.zone).map((e) =>
        displayEntry(e, prefs.zone),
      ),
    [entries, year, prefs.zone],
  );
  const visible = useMemo(
    () =>
      shown.filter(
        (e) =>
          filter === 'Все' ||
          (filter === 'Важные' ? e.important : entryTypes[e.type].plural === filter),
      ),
    [shown, filter],
  );
  const eventsOnDay = useMemo(() => {
    const cache = new Map<string, { entry: Entry; part: Entry }[]>();
    const start = `${year - 1}-12-01`,
      end = `${year + 1}-01-31`;
    for (const entry of visible) {
      const finish = endParts(entry).date;
      const last = finish < end ? finish : end;
      for (let day = entry.date > start ? entry.date : start; day <= last; day = shiftDay(day, 1)) {
        const part = segment(entry, day);
        if (!part) continue;
        const list = cache.get(day) || [];
        list.push({ entry, part });
        cache.set(day, list);
      }
    }
    return (day: string) => cache.get(day) || [];
  }, [visible, year]);
  const today = wallParts(now, prefs.zone);
  const todayKey = today.date;
  const days = useMemo(() => {
    const week = weekStart(date);
    return period === 'День'
      ? [date]
      : Array.from({ length: showWeekend ? 7 : 5 }, (_, i) => addDays(week, i));
  }, [date, period, showWeekend]);
  const hours = useMemo(
    () => Array.from({ length: prefs.hourEnd - prefs.hourStart }, (_, i) => prefs.hourStart + i),
    [prefs.hourStart, prefs.hourEnd],
  );
  const dayData = useMemo(
    () =>
      days.map((day) => {
        const key = dateKey(day),
          entries = eventsOnDay(key);
        const layout = layoutEvents(
          entries.filter(({ entry }) => !entry.allDay).map(({ part }) => part),
          prefs.hourStart * 60,
          prefs.hourEnd * 60,
          prefs.text === 'large' ? 112 : 88,
        );
        return {
          date: day,
          key,
          entries,
          allDay: entries
            .filter(({ entry }) => entry.allDay && entry.date === key)
            .map(({ entry }) => entry),
          simultaneous: countSimultaneous(entries.map(({ entry }) => entry)),
          layout: compactLayout(layout),
          minWidth: Math.max(
            period === 'День' ? 300 : 130,
            ...layout.map((item) => Math.min(item.lanes, 3) * (prefs.text === 'large' ? 140 : 110)),
          ),
        };
      }),
    [days, eventsOnDay, period, prefs.hourStart, prefs.hourEnd, prefs.text],
  );
  const dayWidths = dayData.map((day) => day.minWidth);
  const gridColumns = `66px ${dayWidths.map((width) => `minmax(${width}px,1fr)`).join(' ')}`;
  const gridMinimum = 66 + dayWidths.reduce((sum, width) => sum + width, 0);

  return {
    shown,
    eventsOnDay,
    today,
    todayKey,
    hours,
    dayData,
    gridColumns,
    gridMinimum,
  };
}
