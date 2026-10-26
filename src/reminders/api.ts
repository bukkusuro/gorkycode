export async function postReminders(body: string) {
  const response = await fetch('./api/reminders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: new Blob([body]).size < 60000,
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Не удалось настроить напоминания.');
  return result as { scheduled: number };
}
