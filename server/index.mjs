import { createServer } from 'node:http';
import { createAssistantMiddleware } from './openrouter.mjs';
import { createSpeechMiddleware } from './speech.mjs';
import { createReminderMiddleware } from './reminders.mjs';
import { sendJSON } from './http.mjs';
import { createPushReminderService } from './push-reminders.mjs';

export function createApiServer({ root = process.cwd() } = {}) {
  const push = createPushReminderService();
  const middleware = [
    createAssistantMiddleware({ root }),
    createSpeechMiddleware({ root }),
    createReminderMiddleware({ root }),
    push.handle,
  ];
  const server = createServer(async (req, res) => {
    try {
      if (['/api/health', '/VoiceTask/api/health'].includes(req.url?.split('?')[0])) {
        if (req.method !== 'GET') return sendJSON(res, 405, { error: 'Используйте GET.' });
        return sendJSON(res, 200, { ok: true });
      }
      const next = async (index = 0) => {
        if (index === middleware.length) return sendJSON(res, 404, { error: 'Не найдено.' });
        return middleware[index](req, res, () => next(index + 1));
      };
      await next();
    } catch {
      sendJSON(res, 500, { error: 'Ошибка сервера.' });
    }
  });
  server.on('close', push.close);
  return server;
}

if (import.meta.main) {
  const server = createApiServer();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`Voksa API listening on ${host}:${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 10000).unref();
    });
  }
}
