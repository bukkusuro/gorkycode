import { validDay } from './recurrence.js';
import { validTime } from './calendar.js';

const normalized = (value: string) =>
  value
    .normalize('NFKC')
    .trim()
    .replace(/\s*([.:/-])\s*/g, '$1');
export const isNumericInput = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 4000 &&
  /^\d+(?:[.:/-]\d+){0,2}$/.test(normalized(value));

export function numericParts(value: string, today: string) {
  const input = normalized(value),
    [year, month] = today.split('-');
  let day: string | undefined,
    dateMonth = month,
    dateYear = year,
    time: string | undefined;
  const pair = input.match(/^(\d{1,2})[.:/-](\d{1,2})$/),
    dated = input.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/),
    iso = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (pair) {
    day = pair[1];
    dateMonth = pair[2];
    time = `${pair[1].padStart(2, '0')}:${pair[2].padStart(2, '0')}`;
  } else if (dated) {
    [, day, dateMonth, dateYear] = dated;
    if (dateYear.length === 2) dateYear = `20${dateYear}`;
  } else if (iso) {
    [, dateYear, dateMonth, day] = iso;
  } else if (/^\d{1,2}$/.test(input)) {
    day = input;
    time = `${input.padStart(2, '0')}:00`;
  } else if (/^\d{3,4}$/.test(input)) {
    const padded = input.padStart(4, '0');
    day = padded.slice(0, 2);
    dateMonth = padded.slice(2);
    time = `${day}:${dateMonth}`;
  } else if (/^\d{6}(?:\d{2})?$/.test(input)) {
    day = input.slice(0, 2);
    dateMonth = input.slice(2, 4);
    dateYear = input.length === 6 ? `20${input.slice(4)}` : input.slice(4);
  }
  const date = day && `${dateYear}-${dateMonth.padStart(2, '0')}-${day.padStart(2, '0')}`;
  return {
    date: validDay(date) ? date : undefined,
    time: validTime(time) ? time : undefined,
  };
}
