import {
  Bell,
  CalendarDays,
  Check,
  ChevronDown,
  Plus,
  Settings,
  Trash2,
  Undo2,
  X,
  ChartNoAxesCombined,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Entry, dateKey, entryTypes, fromKey, validEntry } from './calendar';
import CalendarBoard from './calendar/CalendarBoard';
import EntryCard from './calendar/EntryCard';
import GlobalSearch from './calendar/GlobalSearch';
import { useCalendarData } from './calendar/useCalendarData';
import ChatPanel from './chat/ChatPanel';
import EntryForm from './EntryForm';
import { type Preferences, commentOf, dateLabel, displayEntry, endParts, wallParts } from './model';
import PeriodPicker from './PeriodPicker';
import Avatar from './profile/Avatar';
import ProfilePanel from './profile/ProfilePanel';
import { useProfile } from './profile/useProfile';
import { type Scope, changeOccurrence, nextOccurrence, occurrence, occurs } from './recurrence';
import { useReminders } from './reminders/useReminders';
import SettingsPanel from './SettingsPanel';
import { useCalendarStore } from './storage/useCalendarStore';
import { useDialogFocus } from './ui/useDialogFocus';
import AnalyticsPanel from './planning/AnalyticsPanel';
type View =
  | { kind: 'edit'; entry: Entry }
  | { kind: 'detail'; id: string }
  | { kind: 'day'; day: string }
  | { kind: 'settings' | 'profile' | 'period' | 'analytics' }
  | null;
function loadSetting(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
export default function App() {
  const [notice, setNotice] = useState('');
  const {
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
  } = useCalendarStore(setNotice);
  const [date, setDate] = useState(() => fromKey(wallParts(new Date(), prefs.zone).date));
  const [now, setNow] = useState(() => new Date());
  const [period, setPeriod] = useState<Preferences['defaultPeriod']>(prefs.defaultPeriod);
  const [filter, setFilter] = useState('Все');
  const [scopeChoice, setScopeChoice] = useState<{
    selected: Entry;
    patch: Partial<Entry> | null;
  } | null>(null);
  const [deleteEntry, setDeleteEntry] = useState<Entry | null>(null);
  const [view, setView] = useState<View>(null);
  const profile = useProfile(setNotice);
  const [showWeekend, setShowWeekend] = useState(
    () => loadSetting('voicetask.weekend', 'true') !== 'false',
  );
  const [userMenu, setUserMenu] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const modal = useRef<HTMLDivElement>(null),
    timeScroll = useRef<HTMLDivElement>(null),
    actionsRef = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => records.filter(validEntry), [records]);
  const { notifications, setNotifications, background } = useReminders(
    entries,
    prefs,
    now,
    persist,
    setNotice,
  );
  const calendar = useCalendarData(entries, prefs, date, period, showWeekend, filter, now);
  const { shown, eventsOnDay, todayKey } = calendar;
  const byId = useMemo(() => {
    const index = new Map<string, Entry>();
    for (const entry of entries) if (!index.has(entry.id)) index.set(entry.id, entry);
    return index;
  }, [entries]);
  const original = useCallback(
    (id: string) => {
      const direct = byId.get(id);
      if (direct)
        return direct.recurrence
          ? nextOccurrence(direct, direct.date, prefs.zone) || direct
          : direct;
      const base = entries.find((e) => id.startsWith(`${e.id}@`));
      return base && occurs(base, id.slice(base.id.length + 1))
        ? occurrence(base, id.slice(base.id.length + 1), prefs.zone)
        : shown.find((e) => e.id === id);
    },
    [byId, entries, shown, prefs.zone],
  );
  const openResult = useCallback((entry: Entry) => {
    setDate(fromKey(entry.date));
    setView({ kind: 'detail', id: entry.id });
  }, []);
  const showDetail = useCallback((id: string) => setView({ kind: 'detail', id }), []);
  const onChatResults = useCallback((saved: Entry[]) => {
    if (saved[0]) setDate(fromKey(saved[0].date));
  }, []);
  const onChatOpen = useCallback(
    (id: string) => {
      const entry = original(id);
      if (entry) {
        setDate(fromKey(entry.date));
        setView({ kind: 'detail', id });
      } else setNotice('Запись больше не существует.');
    },
    [original],
  );
  useEffect(() => {
    const url = new URL(location.href),
      id = url.searchParams.get('entry');
    if (!id) return;
    const entry = original(id);
    if (!entry) return;
    openResult(displayEntry(entry, prefs.zone));
    url.searchParams.delete('entry');
    history.replaceState(null, '', url);
  }, [entries]);
  useEffect(() => {
    if (!importedEntries.length) return;
    const target =
      importedEntries.find((entry) => entry.date >= todayKey) || importedEntries.at(-1)!;
    setDate(fromKey(target.date));
    setPeriod('Месяц');
  }, [importedEntries]);
  function openEditor(entry?: Entry, day = date, time = '09:00') {
    const selected = entry && original(entry.id);
    if (entry && !selected) {
      setNotice('Запись больше не существует.');
      return;
    }
    setView({
      kind: 'edit',
      entry: selected
        ? displayEntry(selected, prefs.zone)
        : {
            id: crypto.randomUUID(),
            title: '',
            type: 'task',
            date: dateKey(day),
            time,
            duration: 0,
            atTime: true,
            color: prefs.taskColor,
            important: false,
            description: '',
            completed: false,
          },
    });
  }
  function changeEntry(selected: Entry, patch: Partial<Entry> | null, scope?: Scope) {
    if (selected.recurrence && !scope) {
      setScopeChoice({ selected, patch });
      return;
    }
    try {
      if (commit(changeOccurrence(records, selected, patch, scope || 'all', prefs.zone))) {
        setScopeChoice(null);
        setNotice(patch === null ? 'Запись удалена' : 'Запись сохранена');
        if (patch === null || selected.recurrence) setView(null);
        else setView({ kind: 'detail', id: selected.id });
      }
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  const toggle = useCallback(
    (id: string) => {
      const selected = original(id);
      if (!selected || selected.type !== 'task') return;
      try {
        const next = changeOccurrence(
          records,
          selected,
          { completed: !selected.completed },
          selected.recurrence ? 'one' : 'all',
          prefs.zone,
        );
        if (!commit(next)) return;
        if (selected.recurrence && view?.kind === 'detail' && view.id === id) {
          const detached = next.find(
            (entry): entry is Entry => validEntry(entry) && !byId.has(entry.id),
          );
          if (detached) setView({ kind: 'detail', id: detached.id });
        }
      } catch (error) {
        setNotice((error as Error).message);
      }
    },
    [original, records, prefs.zone, commit, byId, view],
  );
  function navigate(direction: number) {
    const next = new Date(date);
    if (period === 'Год') next.setFullYear(next.getFullYear() + direction);
    else if (period === 'Месяц') {
      next.setDate(1);
      next.setMonth(next.getMonth() + direction);
    } else next.setDate(next.getDate() + direction * (period === 'Неделя' ? 7 : 1));
    setDate(next);
  }
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    if (timeScroll.current) timeScroll.current.scrollTop = Math.max(0, 8 - prefs.hourStart) * 90;
  }, [period, prefs.hourStart]);
  useEffect(() => {
    document.documentElement.dataset.theme = prefs.theme === 'system' ? 'light' : prefs.theme;
    document.documentElement.dataset.text = prefs.text;
    document.documentElement.style.setProperty('--accent', prefs.accent);
  }, [prefs.theme, prefs.text, prefs.accent]);
  useEffect(() => {
    const click = (e: PointerEvent) => {
      if (!actionsRef.current?.contains(e.target as Node)) {
        setBellOpen(false);
        setUserMenu(false);
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setBellOpen(false);
        setUserMenu(false);
      }
    };
    document.addEventListener('pointerdown', click);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', click);
      document.removeEventListener('keydown', key);
    };
  }, []);
  useDialogFocus(modal, deleteEntry ? 'delete' : scopeChoice ? 'scope' : view?.kind, () => {
    if (deleteEntry) setDeleteEntry(null);
    else if (scopeChoice) setScopeChoice(null);
    else setView(null);
  });
  function card(entry: Entry, compact = false) {
    return (
      <EntryCard
        key={entry.id}
        entry={entry}
        compact={compact}
        prefs={prefs}
        onOpen={showDetail}
        onToggle={toggle}
      />
    );
  }
  const selected = view?.kind === 'detail' ? original(view.id) : undefined;
  const detail = selected && displayEntry(selected, prefs.zone);
  const detailEnd = detail && endParts(detail);
  const selectedDayEntries = view?.kind === 'day' ? eventsOnDay(view.day) : [];
  return (
    <div className="app">
      <ChatPanel
        records={records}
        entries={entries}
        prefs={prefs}
        selectedDay={dateKey(date)}
        commit={commit}
        persist={persist}
        onResults={onChatResults}
        onOpenEntry={onChatOpen}
      />

      <main>
        <header className="topbar">
          <h1>
            Ваш календарь<span>.</span>
          </h1>
          <div ref={actionsRef} className="header-actions">
            <button
              className="icon-button"
              aria-label="Аналитика выполнения задач"
              title="Аналитика выполнения задач"
              onClick={() => setView({ kind: 'analytics' })}
            >
              <ChartNoAxesCombined size={26} />
            </button>
            <button
              className="icon-button"
              aria-label="Отменить последнее действие"
              title="Отменить последнее действие"
              disabled={!canUndo}
              onClick={undo}
            >
              <Undo2 size={26} />
            </button>
            <button
              className="icon-button"
              aria-label="Настройки"
              onClick={() => {
                setView({ kind: 'settings' });
                setBellOpen(false);
              }}
            >
              <Settings size={28} />
            </button>
            <button
              className="icon-button notification-button"
              aria-label="Уведомления"
              aria-expanded={bellOpen}
              onClick={() => {
                setBellOpen(!bellOpen);
                setUserMenu(false);
              }}
            >
              <Bell size={28} />
              {notifications.length > 0 && <i />}
            </button>
            <button
              className="profile-button"
              aria-expanded={userMenu}
              onClick={() => {
                setUserMenu(!userMenu);
                setBellOpen(false);
              }}
            >
              <Avatar name={profile.name} src={profile.avatar} />
              <span>{profile.name || 'Пользователь'}</span>
              <ChevronDown size={18} />
            </button>
            {userMenu && (
              <div className="header-popover user-popover">
                <button
                  onClick={() => {
                    setView({ kind: 'profile' });
                    setUserMenu(false);
                  }}
                >
                  Мой профиль
                </button>
              </div>
            )}
            {bellOpen && (
              <div className="header-popover notification-popover">
                <strong>Напоминания</strong>
                {notifications.length ? (
                  notifications.map((n) => (
                    <div className="reminder" key={n.key}>
                      <button
                        onClick={() => {
                          if (n.entryId) {
                            const e = shown.find((e) => e.id === n.entryId);
                            if (e) openResult(e);
                          }
                          setBellOpen(false);
                        }}
                      >
                        {n.text}
                      </button>
                      <button
                        aria-label="Скрыть напоминание"
                        onClick={() => setNotifications((v) => v.filter((r) => r.key !== n.key))}
                      >
                        <X size={16} />
                      </button>
                    </div>
                  ))
                ) : (
                  <p>Новых напоминаний нет.</p>
                )}
              </div>
            )}
          </div>
        </header>
        <div className="workspace">
          <div className="search-create">
            <GlobalSearch entries={shown} dateFormat={prefs.dateFormat} onSelect={openResult} />
            <button className="primary-button" onClick={() => openEditor()}>
              <Plus size={19} />
              Создать запись
            </button>
          </div>
          <div className="calendar-controls">
            <label className="control-select">
              <span className="sr-only">Категория записей</span>
              <select
                aria-label="Категория записей"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="Все">Все записи</option>
                {Object.values(entryTypes).map(({ plural }) => (
                  <option key={plural}>{plural}</option>
                ))}
                <option>Важные</option>
              </select>
            </label>
            <label className="control-select">
              <CalendarDays size={19} />
              <select
                aria-label="Режим календаря"
                value={period}
                onChange={(e) => setPeriod(e.target.value as Preferences['defaultPeriod'])}
              >
                {['День', 'Неделя', 'Месяц', 'Год'].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
          </div>
          <CalendarBoard
            {...calendar}
            date={date}
            period={period}
            prefs={prefs}
            timeScroll={timeScroll}
            renderEntry={card}
            onPeriod={() => setView({ kind: 'period' })}
            onToday={() => setDate(fromKey(todayKey))}
            onNavigate={navigate}
            onDay={(day) => {
              setDate(fromKey(day));
              setView({ kind: 'day', day });
            }}
            onMonth={(month) => {
              setDate(new Date(date.getFullYear(), month, 1));
              setPeriod('Месяц');
            }}
            onAdd={(day, time) => openEditor(undefined, day, time)}
          />
          <div className="calendar-footer">
            <div>
              <span className="legend-dot" style={{ background: prefs.taskColor }} />
              Задачи
              <span className="legend-dot" style={{ background: prefs.meetingColor }} />
              Встречи
              <span className="legend-dot" style={{ background: prefs.eventColor }} />
              События<span className="legend-important priority-mark">!</span>Важное
            </div>
          </div>
          {storageError && (
            <p className="error" role="alert">
              {storageError}
            </p>
          )}
          {records.length !== entries.length && (
            <p className="hint">
              Есть записи неизвестного формата: {records.length - entries.length}. Они сохранены без
              изменений.
            </p>
          )}
        </div>
      </main>
      {view && !scopeChoice && !deleteEntry && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setView(null);
          }}
        >
          <div
            ref={modal}
            className={`modal ${view.kind === 'settings' ? 'settings-modal' : view.kind === 'profile' ? 'profile-modal' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <button
              className="modal-close icon-button"
              aria-label="Закрыть"
              onClick={() => setView(null)}
            >
              <X />
            </button>
            {view.kind === 'edit' && (
              <EntryForm
                key={view.entry.id}
                initial={view.entry}
                exists={!!view.entry.sourceId || byId.has(view.entry.id)}
                zone={prefs.zone}
                taskColor={prefs.taskColor}
                meetingColor={prefs.meetingColor}
                eventColor={prefs.eventColor}
                save={(e) => {
                  if (e.sourceId || byId.has(e.id)) {
                    const { id: _id, sourceId: _s, occurrenceDate: _d, ...patch } = e;
                    changeEntry(view.entry, patch);
                  } else if (commit([...records, e])) {
                    setNotice('Запись сохранена');
                    setView({ kind: 'detail', id: e.id });
                  }
                }}
              />
            )}
            {detail && (
              <>
                <h2 id="modal-title">{detail.title}</h2>
                <p>
                  {entryTypes[detail.type].label}
                  {detail.important && (
                    <>
                      {' '}
                      · Важная запись <b className="priority-mark">!</b>
                    </>
                  )}
                  {detail.recurrence ? ' · Повторяется' : ''}
                </p>
                {detail.deadline && <p>Срок: {dateLabel(detail.deadline, prefs.dateFormat)}</p>}
                <p>
                  {dateLabel(detail.date, prefs.dateFormat)}{' '}
                  {detail.allDay
                    ? 'Без времени'
                    : detail.atTime
                      ? detail.time
                      : `${detail.time} — ${dateLabel(detailEnd!.date, prefs.dateFormat)} ${detailEnd!.time}`}
                </p>
                {!detail.allDay && !detail.atTime && (
                  <p>Продолжительность: {selected!.duration} мин.</p>
                )}
                <div className="full-comment">{commentOf(detail) || 'Комментарий не добавлен'}</div>
                {detail.type === 'task' && (
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={!!detail.completed}
                      onChange={() => toggle(detail.id)}
                    />
                    Выполнено
                  </label>
                )}
                <div className="modal-actions">
                  <button className="primary-button" onClick={() => openEditor(detail)}>
                    Редактировать
                  </button>
                  <button className="delete-button" onClick={() => setDeleteEntry(detail)}>
                    <Trash2 size={17} />
                    Удалить
                  </button>
                </div>
              </>
            )}
            {view.kind === 'day' && (
              <>
                <h2 id="modal-title">{dateLabel(view.day, prefs.dateFormat)}</h2>
                <p className="hint">Записи за выбранный день</p>
                <div className="day-list">
                  {selectedDayEntries.length ? (
                    selectedDayEntries.map(({ entry: e, part }) => {
                      const end = endParts(part);
                      return (
                        <article key={e.id}>
                          <button
                            className="day-entry-title"
                            onClick={() => setView({ kind: 'detail', id: e.id })}
                          >
                            {e.important && <b className="day-important priority-mark">!</b>}
                            {e.title}
                          </button>
                          <p>
                            {entryTypes[e.type].label} ·{' '}
                            {e.allDay
                              ? 'Без времени'
                              : e.atTime
                                ? e.time
                                : `${part.time} – ${end.time === '00:00' ? '24:00' : end.time}`}
                            {e.type === 'task' &&
                              (e.completed ? ' · Выполнено' : ' · Не выполнено')}
                          </p>
                          <div className="full-comment">
                            {commentOf(e) || 'Комментарий не добавлен'}
                          </div>
                        </article>
                      );
                    })
                  ) : (
                    <p>На этот день пока нет записей.</p>
                  )}
                </div>
              </>
            )}
            {view.kind === 'period' && (
              <PeriodPicker
                date={date}
                period={period}
                today={todayKey}
                close={() => setView(null)}
                choose={(next) => {
                  setDate(next);
                  setView(null);
                }}
              />
            )}
            {view.kind === 'settings' && (
              <SettingsPanel
                value={prefs}
                background={background}
                records={records}
                restore={restore}
                update={updatePrefs}
                weekend={showWeekend}
                setWeekend={(v) => {
                  try {
                    localStorage.setItem('voicetask.weekend', String(v));
                    setShowWeekend(v);
                  } catch {
                    setNotice('Не удалось сохранить настройку');
                  }
                }}
              />
            )}
            {view.kind === 'profile' && <ProfilePanel profile={profile} />}
            {view.kind === 'analytics' && <AnalyticsPanel records={records} prefs={prefs} />}
          </div>
        </div>
      )}
      {deleteEntry && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDeleteEntry(null);
          }}
        >
          <div
            ref={modal}
            className="modal delete-confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-title"
          >
            <h2 id="delete-title">Удалить запись?</h2>
            <p>Вы действительно хотите удалить запись «{deleteEntry.title}»?</p>
            <div className="modal-actions">
              <button onClick={() => setDeleteEntry(null)}>Отмена</button>
              <button
                className="delete-button"
                onClick={() => {
                  const selected = deleteEntry;
                  setDeleteEntry(null);
                  changeEntry(selected, null);
                }}
              >
                Удалить
              </button>
            </div>
          </div>
        </div>
      )}
      {scopeChoice && (
        <div className="modal-backdrop">
          <div
            ref={modal}
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Область изменения повторения"
          >
            <h2>Какие повторения изменить?</h2>
            {(['one', 'future', 'all'] as Scope[]).map((scope, i) => (
              <button
                className="text-button"
                key={scope}
                onClick={() => changeEntry(scopeChoice.selected, scopeChoice.patch, scope)}
              >
                {['Только это повторение', 'Это и последующие', 'Всю серию'][i]}
              </button>
            ))}
            <button onClick={() => setScopeChoice(null)}>Отмена</button>
          </div>
        </div>
      )}
      {notice && (
        <div className="toast" role="status">
          <Check size={18} />
          <span>{notice}</span>
          <button
            className="icon-button"
            aria-label="Скрыть уведомление"
            onClick={() => setNotice('')}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
