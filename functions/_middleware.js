import { enforceRateLimit, rateLimitRule, RateLimitError } from './_lib/rate-limit.js';

const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self' https://challenges.cloudflare.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "frame-src https://challenges.cloudflare.com",
  "img-src 'self' data: blob: https:",
  "manifest-src 'self'",
  "object-src 'none'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "worker-src 'self' blob:",
].join('; ');

const securityHeaders = {
  'content-security-policy': CSP,
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), geolocation=(), microphone=(), payment=()',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

const SPA_ROUTES = [
  /^\/$/,
  /^\/(?:search|livrare|plata|contacte|checkout|login|register|forgot-password|reset-password|logout|account)\/?$/,
  /^\/(?:category|brand|product)\/[^/]+\/?$/,
  /^\/account\/orders\/[^/]+\/?$/,
  /^\/admin(?:\/.*)?$/,
];
const NOINDEX_SPA_ROUTES = [
  /^\/(?:search|checkout)\/?$/,
  /^\/(?:login|register|forgot-password|reset-password|logout|account)\/?$/,
  /^\/account\/orders\/[^/]+\/?$/,
  /^\/admin(?:\/.*)?$/,
];

export function isKnownSpaRoute(pathname) {
  return SPA_ROUTES.some((pattern) => pattern.test(String(pathname || '')));
}

export function isNoindexSpaRoute(pathname) {
  return NOINDEX_SPA_ROUTES.some((pattern) => pattern.test(String(pathname || '')));
}

function noindexTitle(pathname) {
  if (pathname.startsWith('/admin')) return 'Administrare | Nail Mania';
  if (pathname === '/search') return 'Căutare produse | Nail Mania';
  if (pathname === '/checkout') return 'Finalizarea comenzii | Nail Mania';
  if (pathname === '/register') return 'Creare cont | Nail Mania';
  if (pathname === '/forgot-password') return 'Recuperare parolă | Nail Mania';
  if (pathname === '/reset-password') return 'Resetare parolă | Nail Mania';
  if (pathname === '/logout') return 'Ieșire din cont | Nail Mania';
  if (pathname === '/account') return 'Contul meu | Nail Mania';
  if (pathname.startsWith('/account/orders/')) return 'Detalii comandă | Nail Mania';
  return 'Autentificare | Nail Mania';
}

async function prepareHtmlRoute(response, request) {
  const pathname = new URL(request.url).pathname;
  const knownRoute = isKnownSpaRoute(pathname);
  if (!['GET', 'HEAD'].includes(request.method)
      || response.status !== 200
      || !String(response.headers.get('content-type') || '').includes('text/html')
      || (knownRoute && !isNoindexSpaRoute(pathname))) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  const status = knownRoute ? 200 : 404;
  if (request.method === 'HEAD') {
    return new Response(null, { status, headers });
  }
  const html = await response.text();
  const title = knownRoute ? noindexTitle(pathname.replace(/\/$/, '')) : 'Pagină negăsită | Nail Mania';
  const description = knownRoute ? 'Pagină privată sau tranzacțională Nail Mania.' : 'Pagina solicitată nu există.';
  const robots = pathname === '/search' ? 'noindex,follow' : knownRoute ? 'noindex,nofollow' : 'noindex,follow';
  const noindexSeo = `<!-- SEO:START -->
<title>${title}</title>
<meta name="description" content="${description}"/>
<meta name="robots" content="${robots}"/>
<!-- SEO:END -->`;
  return new Response(
    html.replace(/<!-- SEO:START -->[\s\S]*?<!-- SEO:END -->/, noindexSeo),
    { status, headers },
  );
}

function requestId() {
  return crypto.randomUUID();
}

function withResponseHeaders(response, id, request, env) {
  const headers = new Headers(response.headers);
  headers.set('x-request-id', id);
  for (const [name, value] of Object.entries(securityHeaders)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  if (env?.ENVIRONMENT !== 'local' && new URL(request.url).protocol === 'https:') {
    headers.set('strict-transport-security', 'max-age=31536000');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function correlateApiError(response, id, request) {
  if (response.status < 400 || !new URL(request.url).pathname.startsWith('/api/')) return response;
  if (!String(response.headers.get('content-type') || '').includes('application/json')) return response;
  try {
    const payload = await response.clone().json();
    if (!payload?.error || typeof payload.error !== 'object' || Array.isArray(payload.error)) return response;
    payload.error.requestId = id;
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(payload), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  }
}

export async function onRequest(context) {
  const id = requestId();
  context.data ||= {};
  context.data.requestId = id;

  try {
    const rule = rateLimitRule(context.request);
    if (rule) {
      await enforceRateLimit({
        db: context.env?.DB,
        request: context.request,
        env: context.env,
        ...rule,
      });
    }
    const response = await prepareHtmlRoute(
      await correlateApiError(await context.next(), id, context.request),
      context.request,
    );
    if (response.status >= 500) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'pages.server_error_response',
        requestId: id,
        method: context.request.method,
        pathname: new URL(context.request.url).pathname,
        status: response.status,
      }));
    }
    return withResponseHeaders(response, id, context.request, context.env);
  } catch (error) {
    if (error instanceof RateLimitError) {
      return withResponseHeaders(new Response(JSON.stringify({
        ok: false,
        error: { code: error.code, message: error.message, requestId: id },
      }), {
        status: error.status,
        headers: {
          'cache-control': 'no-store',
          'content-type': 'application/json; charset=utf-8',
          ...(error.retryAfter ? { 'retry-after': String(error.retryAfter) } : {}),
        },
      }), id, context.request, context.env);
    }
    console.error(JSON.stringify({
      level: 'error',
      event: 'pages.unhandled_error',
      requestId: id,
      method: context.request.method,
      pathname: new URL(context.request.url).pathname,
      message: String(error?.message || error),
    }));
    return withResponseHeaders(new Response(JSON.stringify({
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        requestId: id,
      },
    }), {
      status: 500,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
      },
    }), id, context.request, context.env);
  }
}

export { CSP };
