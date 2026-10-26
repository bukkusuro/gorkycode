import { validEntry } from '../calendar.js';
import { type Preferences, parsePreferences } from '../model.js';
export function createBackup(records: unknown[], preferences: Preferences, now = new Date()) {
  return JSON.stringify(
    { app: 'voksa', version: 1, createdAt: now.toISOString(), records, preferences },
    null,
    2,
  );
}
export function parseBackup(text: string) {
  if (text.length > 20 * 1024 * 1024) throw Error('Размер копии превышает 20 МБ.');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw Error('Файл не является резервной копией JSON.');
  }
  if (
    value?.app !== 'voksa' ||
    value.version !== 1 ||
    !Array.isArray(value.records) ||
    value.records.length > 50000 ||
    !value.preferences ||
    typeof value.preferences !== 'object' ||
    Array.isArray(value.preferences)
  )
    throw Error('Неподдерживаемый формат резервной копии.');
  const ids = value.records.filter(validEntry).map((e: { id: string }) => e.id);
  if (ids.length !== new Set(ids).size)
    throw Error('В копии есть записи с одинаковыми идентификаторами.');
  if (value.records.some((r: unknown) => !r || typeof r !== 'object' || Array.isArray(r)))
    throw Error('В копии есть повреждённые записи.');
  return {
    records: value.records as unknown[],
    preferences: parsePreferences(value.preferences),
    count: ids.length,
    other: value.records.length - ids.length,
  };
}
