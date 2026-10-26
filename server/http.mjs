export const httpError = (status, message) => Object.assign(Error(message), { status });

export function sendJSON(response, status, data) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(data));
}

export function assertSameOrigin(request) {
  if (!request.headers.origin) return;
  let origin;
  try {
    origin = new URL(request.headers.origin);
  } catch {
    throw httpError(403, 'Запрос разрешён только со страницы приложения.');
  }
  if (origin.host !== request.headers.host)
    throw httpError(403, 'Запрос разрешён только со страницы приложения.');
}

export async function readBody(request, limit, message) {
  if (Number(request.headers['content-length']) > limit) {
    request.resume();
    throw httpError(413, message);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw httpError(413, message);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

export async function readJSON(request, { limit, tooLarge, invalid = 'Некорректный JSON.' }) {
  if (!request.headers['content-type']?.startsWith('application/json'))
    throw httpError(415, 'Ожидается JSON.');
  const body = await readBody(request, limit, tooLarge);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw httpError(400, invalid);
  }
}
