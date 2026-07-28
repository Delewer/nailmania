import { requireDatabase } from './http.js';

export const CATALOG_EDGE_TTL_SECONDS = 60;

export const catalogPrimaryDatabase = (env) => {
  const db = requireDatabase(env);
  return typeof db.withSession === 'function' ? db.withSession('first-primary') : db;
};

export function catalogRevisionBump(db, guardSql = '', bindings = []) {
  const guard = String(guardSql || '').trim();
  return db.prepare(`
    UPDATE catalog_cache_state
    SET revision = revision + 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = 1${guard ? ` AND (${guard})` : ''}
  `).bind(...bindings);
}

export async function readCatalogRevision(db) {
  const row = await db.prepare('SELECT revision FROM catalog_cache_state WHERE id = 1').first();
  const revision = Number(row?.revision || 0);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw Object.assign(new Error('Catalog cache state is not initialized'), {
      code: 'CATALOG_CACHE_NOT_INITIALIZED',
      status: 503,
    });
  }
  return revision;
}

const edgeCache = (context) => context?.data?.catalogCache || globalThis.caches?.default || null;

export function catalogCacheKey(request, revision, { ignoreSearch = false } = {}) {
  const url = new URL(request.url);
  url.hash = '';
  if (ignoreSearch) url.search = '';
  url.searchParams.set('__nm_catalog_revision', String(revision));
  url.searchParams.sort();
  return new Request(url.toString(), { method: 'GET' });
}

const outboundResponse = (response, revision, state) => {
  const headers = new Headers(response.headers);
  // Browsers must re-enter the Function so the current D1 revision is checked.
  // A separate clone with an edge TTL is stored explicitly via the Cache API.
  headers.set('cache-control', 'no-store');
  headers.set('x-catalog-cache', state);
  headers.set('x-catalog-revision', String(revision));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const storableResponse = (response, revision, ttl) => {
  const headers = new Headers(response.headers);
  headers.delete('set-cookie');
  headers.set('cache-control', `public, max-age=${ttl}`);
  headers.set('x-catalog-revision', String(revision));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export async function cachedCatalogResponse(context, buildResponse, options = {}) {
  const db = catalogPrimaryDatabase(context.env);
  const revision = await readCatalogRevision(db);
  const request = context.request || new Request(options.fallbackUrl || 'https://nailmania.md/api/catalog');
  const cache = edgeCache(context);
  const key = catalogCacheKey(request, revision, options);

  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return outboundResponse(hit, revision, 'HIT');
    } catch (error) {
      console.warn('Catalog edge cache read failed; falling back to D1', error);
    }
  }

  const response = await buildResponse({ db, revision });
  const ttl = Math.max(1, Number(options.ttlSeconds) || CATALOG_EDGE_TTL_SECONDS);
  if (cache && options.cache !== false && response.status >= 200 && response.status < 500) {
    const stored = storableResponse(response.clone(), revision, ttl);
    const write = Promise.resolve().then(() => cache.put(key, stored)).catch((error) => {
      console.warn('Catalog edge cache write failed; response remains uncached', error);
    });
    if (typeof context.waitUntil === 'function') context.waitUntil(write);
    else await write;
  }
  return outboundResponse(response, revision, 'MISS');
}
