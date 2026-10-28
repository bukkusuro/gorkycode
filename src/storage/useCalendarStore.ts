import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Entry } from '../calendar';
import { importCsv } from '../importCsv';
import { ENTRY_KEY, type Preferences, loadPreferences, loadRecords, writeJSON } from '../model';
import { applyTypeColors, completePastTasks, importedEntriesAtTime } from '../recordUpdates';
import { undoPreferences } from './history';
import { trackCompletion } from '../planning/analytics';
function initialRecords() {
  try {
    return { records: loadRecords(), error: '' };
  } catch {
    return {
      records: [],
      error:
        'Не удалось прочитать записи. Исходные данные сохранены; запись изменений заблокирована.',
    };
  }
}

export function useCalendarStore(setNotice: (text: string) => void) {
  const [initial] = useState(initialRecords);
  const [records, setRecords] = useState<unknown[]>(initial.records);
  const [storageError, setStorageError] = useState(initial.error);
  const [prefs, setPrefs] = useState(loadPreferences);
  const [importedEntries, setImportedEntries] = useState<Entry[]>([]);
  const history = useRef<{ records: unknown[]; prefs?: Preferences; afterPrefs?: Preferences }[]>(
    [],
  );
  const [canUndo, setCanUndo] = useState(false);
  const currentJSON = useMemo(() => JSON.stringify(records), [records]);
  const persist = useCallback((key: string, value: unknown) => {
    try {
      writeJSON(key, value);
      return true;
    } catch {
      setStorageError(
        'Не удалось сохранить данные: проверьте свободное место и доступ к localStorage.',
      );
      return false;
    }
  }, []);
  const commit = useCallback(
    (next: unknown[], nextPrefs = prefs, track = true, trackActivity = true) => {
      if (initial.error) {
        setNotice(initial.error);
        return false;
      }
      try {
        const raw = localStorage.getItem(ENTRY_KEY);
        if (
          raw !== null &&
          raw !== currentJSON &&
          JSON.stringify(JSON.parse(raw)) !== currentJSON
        ) {
          setRecords(loadRecords());
          history.current = [];
          setCanUndo(false);
          setNotice('Записи изменились в другой вкладке. Список обновлён; повторите действие.');
          return false;
        }
        if (raw !== null && !localStorage.getItem('voicetask.entries.backup.v1'))
          localStorage.setItem('voicetask.entries.backup.v1', raw);
        const previousPrefs = localStorage.getItem('voicetask.preferences.v2');
        if (trackActivity && track) next = trackCompletion(records, next);
        const nextJSON = JSON.stringify(next);
        try {
          if (nextPrefs !== prefs) writeJSON('voicetask.preferences.v2', nextPrefs);
          localStorage.setItem(ENTRY_KEY, nextJSON);
        } catch (error) {
          if (nextPrefs !== prefs) {
            if (previousPrefs === null) localStorage.removeItem('voicetask.preferences.v2');
            else localStorage.setItem('voicetask.preferences.v2', previousPrefs);
          }
          throw error;
        }
        if (track && (nextJSON !== currentJSON || nextPrefs !== prefs)) {
          history.current = [
            ...history.current,
            { records, ...(nextPrefs !== prefs ? { prefs, afterPrefs: nextPrefs } : {}) },
          ].slice(-10);
          setCanUndo(true);
        }
        setRecords(next);
        if (nextPrefs !== prefs) setPrefs(nextPrefs);
        setStorageError('');
        return true;
      } catch {
        setStorageError('Не удалось сохранить запись. Изменение не применено.');
        return false;
      }
    },
    [records, prefs, currentJSON, initial.error, setNotice],
  );
  function undo() {
    const previous = history.current.at(-1);
    if (!previous) return;
    const previousPrefs = previous.prefs
      ? undoPreferences(prefs, previous.prefs, previous.afterPrefs!)
      : prefs;
    if (!commit(previous.records, previousPrefs, false)) return;
    history.current.pop();
    setCanUndo(history.current.length > 0);
    setNotice('Последнее изменение отменено');
  }
  function restore(records: unknown[], preferences: Preferences) {
    if (!commit(records, preferences, true, false)) return false;
    setNotice('Резервная копия восстановлена');
    return true;
  }
  function updatePrefs(next: Preferences) {
    const changed = (['task', 'meeting', 'event'] as Entry['type'][]).filter(
      (type) => next[`${type}Color`] !== prefs[`${type}Color`],
    );
    if (changed.length) {
      commit(applyTypeColors(records, next, changed), next);
      return;
    }
    if (persist('voicetask.preferences.v2', next)) setPrefs(next);
  }

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const importMarker = 'voicetask.import.bundled.v1';
        const updateMarker = 'voicetask.records.updated-2026-10-20.v1';
        const atTimeMarker = 'voicetask.entries.at-time.v2';
        if (
          initial.error ||
          (localStorage.getItem(importMarker) &&
            localStorage.getItem(updateMarker) &&
            localStorage.getItem(atTimeMarker))
        )
          return;
        let text: string | undefined;
        if (!localStorage.getItem(importMarker)) {
          const response = await fetch('./data/voice-assistant-events.csv', {
            signal: controller.signal,
          });
          if (!response.ok) throw Error('База записей недоступна. Попробуйте обновить страницу.');
          text = await response.text();
        }
        if (controller.signal.aborted) return;
        const current = loadRecords();
        const preferences = loadPreferences();
        const imported =
          text && !localStorage.getItem(importMarker)
            ? importCsv(text, preferences, current).entries
            : [];
        let next = imported.length ? [...current, ...imported] : current;
        if (imported.length) {
          writeJSON('voicetask.entries.before-import.v1', current);
        }
        if (!localStorage.getItem(updateMarker)) {
          const backup = 'voicetask.entries.before-update-2026-10-20.v1';
          if (!localStorage.getItem(backup)) writeJSON(backup, next);
          next = applyTypeColors(
            completePastTasks(next, '2026-10-20', preferences.zone),
            preferences,
          );
        }
        if (!localStorage.getItem(atTimeMarker)) {
          const backup = 'voicetask.entries.before-at-time.v2';
          if (!localStorage.getItem(backup)) writeJSON(backup, next);
          next = importedEntriesAtTime(next);
        }
        if (next !== current) {
          writeJSON(ENTRY_KEY, next);
          setRecords(next);
        }
        if (imported.length) {
          setImportedEntries(imported);
          setNotice(`База загружена: ${imported.length} записей. Существующие записи сохранены.`);
        }
        localStorage.setItem(importMarker, new Date().toISOString());
        localStorage.setItem(updateMarker, 'done');
        localStorage.setItem(atTimeMarker, 'done');
      } catch (error) {
        if (!controller.signal.aborted)
          setStorageError(`Загрузка базы: ${(error as Error).message}`);
      }
    })();
    return () => controller.abort();
  }, []);

  return {
    records,
    storageError,
    prefs,
    persist,
    commit,
    updatePrefs,
    importedEntries,
    undo,
    canUndo,
    restore,
  };
}
