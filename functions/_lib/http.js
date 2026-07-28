export const json = (payload, status = 200, headers = {}) => new Response(JSON.stringify(payload), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    ...headers,
  },
});

export const apiError = (code, message, status = 400, details) => json({
  ok: false,
  error: { code, message, ...(details === undefined ? {} : { details }) },
}, status, { 'cache-control': 'no-store' });

export const requireDatabase = (env) => {
  if (!env?.DB) throw Object.assign(new Error('D1 binding DB is not configured'), {
    status: 503,
    code: 'DB_NOT_CONFIGURED',
  });
  return env.DB;
};

const requestError = (code, message, status) => Object.assign(new Error(message), { code, status });

export function requireJsonContentType(request) {
  const contentType = String(request.headers.get('content-type') || '');
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw requestError('JSON_REQUIRED', 'Request content type must be application/json', 415);
  }
}

async function readBoundedBytes(request, maxBytes, tooLarge) {
  const declaredHeader = String(request.headers.get('content-length') || '').trim();
  if (/^\d+$/.test(declaredHeader) && Number(declaredHeader) > maxBytes) throw tooLarge();
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (chunk.byteLength > maxBytes - size) {
        try { await reader.cancel(); } catch { /* The 413 response remains authoritative. */ }
        throw tooLarge();
      }
      chunks.push(chunk);
      size += chunk.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedJson(request, {
  maxBytes,
  requireObject = false,
  invalidMessage = 'Request body must be valid JSON',
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('readBoundedJson requires a positive maxBytes limit');
  }
  requireJsonContentType(request);
  const tooLarge = () => requestError(
    'REQUEST_BODY_TOO_LARGE',
    `Request body exceeds the ${maxBytes}-byte limit`,
    413,
  );

  let bytes;
  try {
    bytes = await readBoundedBytes(request, maxBytes, tooLarge);
  } catch (error) {
    if (error?.code === 'REQUEST_BODY_TOO_LARGE') throw error;
    throw requestError('INVALID_JSON', invalidMessage, 400);
  }

  let body;
  try {
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    body = JSON.parse(raw);
  } catch {
    throw requestError('INVALID_JSON', invalidMessage, 400);
  }
  if (requireObject && (!body || Array.isArray(body) || typeof body !== 'object')) {
    throw requestError('INVALID_JSON', invalidMessage, 400);
  }
  return body;
}

export const handleApiError = (error) => {
  const status = error?.status || 500;
  if (status >= 500) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'api.error',
      code: error?.code || 'INTERNAL_ERROR',
      message: String(error?.message || error).slice(0, 500),
    }));
  }
  return apiError(
    error?.code || 'INTERNAL_ERROR',
    status < 500 ? error.message : 'Internal server error',
    status,
  );
};
