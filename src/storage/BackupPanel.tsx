import { useRef, useState } from 'react';
import type { Preferences } from '../model';
import { createBackup, parseBackup } from './backup';
export default function BackupPanel({
  records,
  preferences,
  restore,
}: {
  records: unknown[];
  preferences: Preferences;
  restore: (records: unknown[], preferences: Preferences) => boolean;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<ReturnType<typeof parseBackup>>();
  const [error, setError] = useState('');
  function download() {
    const url = URL.createObjectURL(
      new Blob([createBackup(records, preferences)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `voksa-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function load(value?: File) {
    setPending(undefined);
    setError('');
    if (!value) return;
    if (value.size > 20 * 1024 * 1024) {
      setError('Размер копии превышает 20 МБ.');
      return;
    }
    try {
      setPending(parseBackup(await value.text()));
    } catch (e) {
      setError((e as Error).message);
    }
    if (file.current) file.current.value = '';
  }
  return (
    <section className="settings-card backup-panel">
      <h4>Резервная копия</h4>
      <p className="settings-description">
        Записи и настройки в одном файле. Его можно перенести в другой браузер.
      </p>
      <div className="backup-actions">
        <button type="button" onClick={download}>
          Скачать копию
        </button>
        <button type="button" onClick={() => file.current?.click()}>
          Восстановить из файла
        </button>
      </div>
      <input
        ref={file}
        type="file"
        accept=".json,application/json"
        aria-label="Файл резервной копии"
        hidden
        onChange={(e) => void load(e.target.files?.[0])}
      />
      {pending && (
        <div className="backup-confirm">
          <p>
            В копии записей: {pending.count}
            {pending.other ? `, дополнительных данных: ${pending.other}` : ''}. Текущий календарь
            будет заменён. Последнее действие можно отменить.
          </p>
          <button
            type="button"
            onClick={() => {
              if (restore(pending.records, pending.preferences)) setPending(undefined);
            }}
          >
            Восстановить
          </button>
          <button type="button" onClick={() => setPending(undefined)}>
            Отмена
          </button>
        </div>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
