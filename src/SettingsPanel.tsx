import {
  AlignLeft,
  Bell,
  CalendarDays,
  Check,
  List,
  ListCollapse,
  Monitor,
  Moon,
  Palette,
  Sun,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { type Preferences, standardAppearance } from './model';
import type { BackgroundState } from './reminders/useBackgroundReminders';
import BackupPanel from './storage/BackupPanel';

type Section = 'Внешний вид' | 'Календарь' | 'Уведомления';
type ChoiceKey = 'theme' | 'text' | 'density' | 'defaultPeriod';
type ToggleKey =
  | 'enabled'
  | 'background'
  | 'tasks'
  | 'meetings'
  | 'events'
  | 'important'
  | 'sound'
  | 'popup'
  | 'daily'
  | 'highlight'
  | 'weekNumbers';
const accents = ['#805039', '#7850ec', '#4c82f5', '#2ebd87', '#f56b91', '#f4a22e'];
const sections = [
  {
    title: 'Внешний вид' as const,
    icon: Palette,
    description: 'Настройте тему и визуальные параметры приложения',
  },
  {
    title: 'Календарь' as const,
    icon: CalendarDays,
    description: 'Настройте отображение календаря и параметры времени',
  },
  {
    title: 'Уведомления' as const,
    icon: Bell,
    description: 'Настройте напоминания о событиях и задачах',
  },
];
const cities: Record<string, string> = {
  'Europe/Moscow': 'Москва',
  'Europe/London': 'Лондон',
  'Europe/Berlin': 'Берлин',
  'Asia/Tokyo': 'Токио',
  'Asia/Dubai': 'Дубай',
  'America/New_York': 'Нью-Йорк',
  'America/Los_Angeles': 'Лос-Анджелес',
  UTC: 'Всемирное время',
};

export default function SettingsPanel({
  value: p,
  update,
  weekend,
  setWeekend,
  background,
  records,
  restore,
}: {
  value: Preferences;
  update: (p: Preferences) => void;
  weekend: boolean;
  setWeekend: (v: boolean) => void;
  background: BackgroundState;
  records: unknown[];
  restore: (records: unknown[], preferences: Preferences) => boolean;
}) {
  const [section, setSection] = useState<Section>('Внешний вид');
  const selectedSection = sections.find((s) => s.title === section)!;
  const SectionIcon = selectedSection.icon;
  const accent = p.accent.toLowerCase();
  const set = <K extends keyof Preferences>(key: K, value: Preferences[K]) =>
    update({ ...p, [key]: value });
  const choices = <K extends ChoiceKey>(
    key: K,
    title: string,
    options: { value: Preferences[K]; label: string; icon?: typeof Sun }[],
    description?: string,
    small = false,
  ) => (
    <fieldset
      className={`settings-card settings-choice-group ${small ? 'small-choices' : ''}`}
      data-setting={key}
    >
      <legend>{title}</legend>
      {description && <p className="settings-description">{description}</p>}
      <div className="settings-choices">
        {options.map((option) => {
          const Icon = option.icon;
          const selected = p[key] === option.value;
          const standard = key === 'theme' && option.value === 'system';
          const choose = () => (standard ? update(standardAppearance(p)) : set(key, option.value));
          return (
            <label
              key={option.value}
              className={`settings-choice ${selected ? 'is-selected' : ''}`}
            >
              <input
                type="radio"
                name={key}
                value={option.value}
                checked={selected}
                onClick={() => {
                  if (standard) choose();
                }}
                onChange={choose}
              />
              {Icon && <Icon aria-hidden="true" size={25} />}
              {key === 'text' && (
                <span className={`text-size-sample ${option.value}`} aria-hidden="true">
                  А
                </span>
              )}
              <span>{option.label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
  const toggle = (key: ToggleKey, title: string, description: string) => (
    <label className="settings-toggle" data-setting={key}>
      <span className="settings-toggle-copy">
        <strong>{title}</strong>
        <span>{description}</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-label={title}
        checked={p[key]}
        onChange={(e) => {
          if (key === 'background' && e.target.checked) {
            update({ ...p, enabled: true, background: true });
            void background.enable();
          } else set(key, e.target.checked);
        }}
      />
    </label>
  );
  const recordColor = (key: 'taskColor' | 'meetingColor' | 'eventColor', title: string) => (
    <label className="record-color-picker">
      <span className="record-color-dot" style={{ backgroundColor: p[key] }} />
      <span>{title}</span>
      <input
        type="color"
        aria-label={title}
        value={p[key]}
        onChange={(e) => set(key, e.target.value)}
      />
    </label>
  );
  const zones = useMemo(
    () => [
      ...new Set([
        p.zone,
        ...('supportedValuesOf' in Intl
          ? (Intl as unknown as { supportedValuesOf: (v: string) => string[] }).supportedValuesOf(
              'timeZone',
            )
          : Object.keys(cities)),
      ]),
    ],
    [p.zone],
  );
  const zoneLabel = (zone: string) => {
    const offset =
      new Intl.DateTimeFormat('ru-RU', { timeZone: zone, timeZoneName: 'longOffset' })
        .formatToParts(new Date())
        .find((part) => part.type === 'timeZoneName')?.value || 'GMT';
    return `(${offset}) ${cities[zone] || zone.split('/').slice(1).join(' / ').replaceAll('_', ' ') || zone}`;
  };
  const zoneOptions = useMemo(
    () => zones.map((zone) => ({ zone, label: zoneLabel(zone) })),
    [zones],
  );
  return (
    <>
      <header className="settings-modal-header">
        <h2 id="modal-title">Настройки</h2>
      </header>
      <div className="settings-layout">
        <aside className="settings-sidebar">
          <div className="settings-brand">
            <span className="brand-logo" role="img" aria-label="ВОКСА" />
          </div>
          <p className="settings-nav-caption">НАСТРОЙКИ</p>
          <nav aria-label="Разделы настроек">
            {sections.map(({ title, icon: Icon }) => (
              <button
                key={title}
                className={section === title ? 'selected' : ''}
                aria-current={section === title ? 'page' : undefined}
                onClick={() => setSection(title)}
              >
                <Icon size={21} />
                <span>{title}</span>
              </button>
            ))}
          </nav>
        </aside>
        <div className="settings-content" key={section}>
          <header className="settings-section-heading">
            <span className="settings-section-icon">
              <SectionIcon size={25} />
            </span>
            <div>
              <h3>{section}</h3>
              <p>{selectedSection.description}</p>
            </div>
          </header>
          {section === 'Внешний вид' && (
            <div className="settings-cards">
              {choices('theme', 'Тема приложения', [
                { value: 'light', label: 'Светлая', icon: Sun },
                { value: 'dark', label: 'Тёмная', icon: Moon },
                { value: 'system', label: 'Стандартная (ВОКСА)', icon: Monitor },
              ])}
              <div className="settings-two-columns appearance-columns">
                <section className="settings-card accent-card">
                  <h4>Основной цвет</h4>
                  <p className="settings-description">
                    Выберите цвет акцентов и активных элементов
                  </p>
                  <div className="settings-palette">
                    {accents.map((color) => (
                      <button
                        key={color}
                        type="button"
                        aria-label={`Акцент ${color}`}
                        aria-pressed={accent === color}
                        className={`accent-swatch ${accent === color ? 'is-selected' : ''}`}
                        style={{ backgroundColor: color }}
                        onClick={() => set('accent', color)}
                      >
                        {accent === color && <Check size={15} />}
                      </button>
                    ))}
                    <label
                      className={`accent-custom ${!accents.includes(accent) ? 'is-selected' : ''}`}
                      title="Свой основной цвет"
                    >
                      <Palette size={21} />
                      <input
                        type="color"
                        aria-label="Свой основной цвет"
                        value={p.accent}
                        onChange={(e) => set('accent', e.target.value)}
                      />
                    </label>
                  </div>
                </section>
                {choices(
                  'text',
                  'Размер текста',
                  [
                    { value: 'small', label: 'Маленький' },
                    { value: 'medium', label: 'Средний' },
                    { value: 'large', label: 'Большой' },
                  ],
                  'Настройте размер шрифта в интерфейсе',
                  true,
                )}
              </div>
              {choices(
                'density',
                'Плотность отображения записей',
                [
                  { value: 'standard', label: 'Стандартная', icon: List },
                  { value: 'brief', label: 'Краткая', icon: ListCollapse },
                  { value: 'full', label: 'Подробная', icon: AlignLeft },
                ],
                'Выберите, сколько информации показывать в карточках',
              )}
            </div>
          )}
          {section === 'Календарь' && (
            <div className="settings-cards">
              <BackupPanel records={records} preferences={p} restore={restore} />
              <div className="settings-two-columns">
                <section className="settings-card">
                  <label className="settings-field">
                    Часовой пояс
                    <span className="settings-description">Выберите ваш часовой пояс</span>
                    <select value={p.zone} onChange={(e) => set('zone', e.target.value)}>
                      {zoneOptions.map(({ zone, label }) => (
                        <option key={zone} value={zone}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                </section>
                {choices(
                  'defaultPeriod',
                  'Режим календаря по умолчанию',
                  (['День', 'Неделя', 'Месяц', 'Год'] as const).map((value) => ({
                    value,
                    label: value,
                  })),
                  'Какой режим показывать при открытии',
                  true,
                )}
              </div>
              <section className="settings-card hours-card">
                <h4>Отображаемые часы</h4>
                <p className="settings-description">
                  Какой диапазон времени показывать в дневном и недельном режиме
                </p>
                <div className="settings-two-columns hours-fields">
                  <label>
                    Начало дня
                    <select
                      value={p.hourStart}
                      onChange={(e) => set('hourStart', Number(e.target.value))}
                    >
                      {Array.from({ length: 24 }, (_, h) => (
                        <option key={h} value={h} disabled={h >= p.hourEnd}>
                          {String(h).padStart(2, '0')}:00
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Конец дня
                    <select
                      value={p.hourEnd}
                      onChange={(e) => set('hourEnd', Number(e.target.value))}
                    >
                      {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
                        <option key={h} value={h} disabled={h <= p.hourStart}>
                          {String(h).padStart(2, '0')}:00
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="settings-weekend">
                  <input
                    type="checkbox"
                    checked={weekend}
                    onChange={(e) => setWeekend(e.target.checked)}
                  />
                  Показывать выходные в неделе
                </label>
              </section>
              <div className="settings-two-columns calendar-color-row">
                <section className="settings-card">
                  <h4>Цвета типов записей</h4>
                  <p className="settings-description">Цвета всех записей соответствующего типа</p>
                  <div className="record-colors">
                    {recordColor('taskColor', 'Цвет задач')}
                    {recordColor('meetingColor', 'Цвет встреч')}
                    {recordColor('eventColor', 'Цвет событий')}
                  </div>
                </section>
                <section className="settings-card">
                  <label className="settings-field">
                    Формат даты
                    <span className="settings-description">Как показывать даты в интерфейсе</span>
                    <select
                      value={p.dateFormat}
                      onChange={(e) => set('dateFormat', e.target.value)}
                    >
                      <option value="DD.MM.YYYY">ДД.ММ.ГГГГ</option>
                      <option value="YYYY-MM-DD">ГГГГ-ММ-ДД</option>
                      <option value="MM/DD/YYYY">ММ/ДД/ГГГГ</option>
                    </select>
                  </label>
                </section>
              </div>
              <div className="settings-two-columns calendar-additional">
                <section className="settings-card">
                  {toggle('highlight', 'Показывать текущую дату', 'Выделять сегодняшний день')}
                </section>
                <section className="settings-card">
                  {toggle(
                    'weekNumbers',
                    'Показывать номера недель',
                    'Нумерация недель по стандарту ISO',
                  )}
                </section>
              </div>
            </div>
          )}
          {section === 'Уведомления' && (
            <div className="settings-cards notifications-cards">
              <section className="settings-card">
                {toggle(
                  'enabled',
                  'Включить уведомления',
                  'Получать напоминания о предстоящих событиях',
                )}
              </section>
              <section className="settings-card">
                {toggle(
                  'background',
                  background.mode === 'native'
                    ? 'Фоновые напоминания Windows'
                    : 'Фоновые уведомления',
                  'Получать уведомления даже при закрытой вкладке',
                )}
                {p.background && (
                  <div className="background-reminders">
                    {background.mode === 'web' && background.needsPermission && (
                      <button
                        type="button"
                        disabled={background.busy || !background.available}
                        onClick={() => {
                          update({ ...p, enabled: true, background: true });
                          void background.enable();
                        }}
                      >
                        Разрешить уведомления
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={
                        background.busy ||
                        !background.available ||
                        (background.mode === 'web' && background.needsPermission)
                      }
                      onClick={() => void background.test()}
                    >
                      Проверить уведомление
                    </button>
                    <p role="status">
                      {background.busy
                        ? 'Настраиваю уведомления…'
                        : background.message
                          ? background.message
                          : background.ready
                            ? `Запланировано: ${background.scheduled}`
                            : !background.available
                              ? 'Фоновые уведомления недоступны.'
                              : background.needsPermission
                                ? 'Нажмите «Разрешить уведомления» и подтвердите запрос браузера.'
                                : background.error
                                  ? 'Не удалось обновить расписание уведомлений.'
                                  : 'Включите уведомления, чтобы запланировать напоминания.'}
                    </p>
                    {background.mode === 'web' && (
                      <p>
                        Уведомления приходят при закрытой вкладке. Разрешите браузеру работу в фоне
                        и уведомления в настройках системы.
                      </p>
                    )}
                    {background.error && (
                      <p className="field-error" role="alert">
                        {background.error}
                      </p>
                    )}
                  </div>
                )}
              </section>
              <fieldset className="settings-card reminder-timing" data-setting="lead">
                <legend>Напоминать до начала события</legend>
                <p className="settings-description">За какое время напоминать о записях</p>
                <div className="reminder-options">
                  {[
                    [5, 'За 5 минут'],
                    [15, 'За 15 минут'],
                    [30, 'За 30 минут'],
                    [60, 'За 1 час'],
                    [1440, 'За 1 день'],
                  ].map(([value, title]) => (
                    <label key={value}>
                      <input
                        type="radio"
                        name="lead"
                        value={value}
                        checked={p.lead === value}
                        onChange={() => set('lead', Number(value))}
                      />
                      {title}
                    </label>
                  ))}
                </div>
              </fieldset>
              <section className="settings-card notification-switches">
                {toggle(
                  'tasks',
                  'Напоминания о задачах',
                  'Напоминать о приближении срока выполнения задач',
                )}
                {toggle('meetings', 'Напоминания о встречах', 'Напоминать о предстоящих встречах')}
                {toggle('events', 'Напоминания о событиях', 'Напоминать о предстоящих событиях')}
                {toggle(
                  'important',
                  'Напоминания о важных записях',
                  'Напоминать о важных записях любого типа',
                )}
                {toggle(
                  'sound',
                  'Звуковые оповещения',
                  'Воспроизводить звук при появлении уведомлений',
                )}
                {toggle(
                  'popup',
                  'Показывать всплывающие уведомления',
                  'Отображать напоминания внутри приложения',
                )}
                {toggle('daily', 'Отправлять ежедневный обзор', 'Краткий обзор записей на сегодня')}
              </section>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
