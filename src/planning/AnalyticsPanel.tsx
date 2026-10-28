import type { Preferences } from '../model';
import { productivity } from './analytics';
export default function AnalyticsPanel({
  records,
  prefs,
}: {
  records: unknown[];
  prefs: Preferences;
}) {
  const report = productivity(records, prefs.zone);
  return (
    <section className="analytics-panel">
      <h2 id="modal-title">Как идут ваши дела</h2>
      <p className="hint">
        Последние 14 дней · {report.first} — {report.today} · {prefs.zone}
      </p>
      <div className="analytics-totals">
        {[report.week, report.previous].map((week, i) => (
          <article key={week.start}>
            <span>{i ? 'Предыдущие 7 дней' : 'Последние 7 дней'}</span>
            <strong>{week.percent === null ? '—' : `${week.percent}%`}</strong>
            <span>
              {week.done} из {week.total} задач выполнено
            </span>
            <progress
              max="100"
              value={week.percent || 0}
              aria-label={i ? 'Выполнение за предыдущие 7 дней' : 'Выполнение за последние 7 дней'}
            />
          </article>
        ))}
      </div>
      <h3>Дни завершения задач</h3>
      <p className="hint">По отметкам за последние 14 дней.</p>
      <table className="analytics-table">
        <thead>
          <tr>
            <th>День</th>
            <th>Завершено</th>
            <th>Осталось по плану</th>
          </tr>
        </thead>
        <tbody>
          {report.days.map((day) => (
            <tr key={day.label}>
              <th scope="row">{day.label}</th>
              <td>{day.completed}</td>
              <td>{day.unfinished}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Рекомендации</h3>
      {report.recommendations.map((text) => (
        <p key={text}>{text}</p>
      ))}
      <details className="analytics-details hint">
        <summary>Как считается</summary>
        <p>Процент — доля выполненных задач за период. Дни завершения — по времени отметки.</p>
        <p>Старые отметки без даты не учитываются в сравнении дней.</p>
        {!!report.excluded && (
          <p>
            Импортированных записей без новых отметок: {report.excluded}. Они исключены из отчёта.
          </p>
        )}
      </details>
    </section>
  );
}
