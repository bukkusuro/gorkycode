import type { Preferences } from '../model.js';
export function undoPreferences(current: Preferences, before: Preferences, after: Preferences) {
  const previous = { ...current };
  for (const key of Object.keys(before) as (keyof Preferences)[]) {
    if (before[key] !== after[key] && current[key] === after[key])
      Object.assign(previous, { [key]: before[key] });
  }
  return previous;
}
