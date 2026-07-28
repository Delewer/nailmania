import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveReportFile, serializeJsonReport, writeJsonReportFile } from './report-file.mjs';

const DEFAULT_ROUTES = [
  '/api/categories',
  '/api/products?limit=50&sort=price_asc',
  '/api/products?limit=50&stock=in&sort=newest',
  '/sitemap.xml',
];

export function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

export function isSafeLocalTarget(value) {
  let url;
  try { url = new URL(value); }
  catch { return false; }
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname.toLowerCase())
    && ['http:', 'https:'].includes(url.protocol)
    && !url.username
    && !url.password
    && !url.search
    && !url.hash
    && (url.pathname === '/' || url.pathname === '');
}

export function normalizeLoadBaseUrl(value) {
  let url;
  try { url = new URL(String(value || '')); }
  catch { throw new Error('Load-check base URL is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol)
      || url.username || url.password || url.search || url.hash
      || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Load-check base URL must be an exact HTTP(S) origin without credentials, path, query or fragment');
  }
  return url.origin;
}

function integer(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function argumentsMap(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) values.set(key, true);
    else { values.set(key, next); index += 1; }
  }
  return values;
}

async function timedFetch(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.arrayBuffer();
    return {
      ok: response.ok,
      status: response.status,
      durationMs: performance.now() - startedAt,
      bytes: body.byteLength,
      contentType: response.headers.get('content-type') || '',
      requestId: response.headers.get('x-request-id') || '',
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      durationMs: performance.now() - startedAt,
      bytes: 0,
      contentType: '',
      requestId: '',
      error: error?.name === 'AbortError' ? 'timeout' : String(error?.message || error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function concurrentRun(total, concurrency, operation) {
  const results = new Array(total);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(total, concurrency) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= total) return;
      results[index] = await operation(index);
    }
  });
  await Promise.all(workers);
  return results;
}

function summarize(name, results) {
  const latencies = results.map((result) => result.durationMs);
  const failures = results.filter((result) => !result.ok);
  return {
    name,
    requests: results.length,
    succeeded: results.length - failures.length,
    failed: failures.length,
    bytes: results.reduce((sum, result) => sum + result.bytes, 0),
    latencyMs: {
      p50: Math.round(percentile(latencies, 0.50)),
      p95: Math.round(percentile(latencies, 0.95)),
      p99: Math.round(percentile(latencies, 0.99)),
      max: Math.round(Math.max(0, ...latencies)),
    },
    failures: failures.slice(0, 5).map((failure) => ({
      status: failure.status,
      error: failure.error || '',
      requestId: failure.requestId,
    })),
  };
}

export async function runCatalogLoad({
  baseUrl,
  requests = 120,
  concurrency = 12,
  timeoutMs = 10_000,
  routes = DEFAULT_ROUTES,
}) {
  const base = new URL(baseUrl);
  for (const route of routes) {
    const warmup = await timedFetch(new URL(route, base), { headers: { accept: '*/*' } }, timeoutMs);
    if (!warmup.ok) throw new Error(`Catalog warmup failed for ${route}: HTTP ${warmup.status || warmup.error}`);
  }
  const results = await concurrentRun(requests, concurrency, (index) => timedFetch(
    new URL(routes[index % routes.length], base),
    { headers: { accept: '*/*' } },
    timeoutMs,
  ));
  return summarize('catalog', results);
}

export async function runLocalOrderLoad({
  baseUrl,
  payload,
  requests = 10,
  concurrency = 5,
  timeoutMs = 10_000,
}) {
  if (!isSafeLocalTarget(baseUrl)) {
    throw new Error('Order load checks are restricted to localhost/127.0.0.1/::1');
  }
  const base = new URL(baseUrl);
  const results = await concurrentRun(requests, concurrency, (index) => timedFetch(
    new URL('/api/orders', base),
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        origin: base.origin,
        'cf-connecting-ip': `198.51.100.${(index % 200) + 1}`,
      },
      body: JSON.stringify(payload),
    },
    timeoutMs,
  ));
  return summarize('orders-local-mutating', results);
}

async function main() {
  const args = argumentsMap(process.argv.slice(2));
  const reportFile = args.get('--report-file');
  if (reportFile) resolveReportFile(reportFile);
  const baseUrl = normalizeLoadBaseUrl(args.get('--base-url') || 'http://127.0.0.1:8788');
  const mode = String(args.get('--mode') || 'catalog');
  const maxP95Ms = integer(args.get('--max-p95-ms'), 3000, 1, 120_000);
  const reports = [];

  if (['catalog', 'both'].includes(mode)) {
    reports.push(await runCatalogLoad({
      baseUrl,
      requests: integer(args.get('--requests'), 120, 1, 10_000),
      concurrency: integer(args.get('--concurrency'), 12, 1, 200),
      timeoutMs: integer(args.get('--timeout-ms'), 10_000, 100, 120_000),
    }));
  }

  if (['orders', 'both'].includes(mode)) {
    if (!args.has('--confirm-local-order-load')) {
      throw new Error('Mutating order load requires --confirm-local-order-load');
    }
    const payloadPath = String(args.get('--order-payload') || '').trim();
    if (!payloadPath) throw new Error('Mutating order load requires --order-payload <json-file>');
    const payload = JSON.parse(readFileSync(path.resolve(payloadPath), 'utf8'));
    reports.push(await runLocalOrderLoad({
      baseUrl,
      payload,
      requests: integer(args.get('--order-requests'), 10, 1, 12),
      concurrency: integer(args.get('--order-concurrency'), 5, 1, 12),
      timeoutMs: integer(args.get('--timeout-ms'), 10_000, 100, 120_000),
    }));
  }

  if (!reports.length) throw new Error('Mode must be catalog, orders, or both');
  const result = { baseUrl, reports };
  const serialized = serializeJsonReport(result);
  process.stdout.write(serialized);
  const failed = reports.some((report) => report.failed > 0 || report.latencyMs.p95 > maxP95Ms);
  if (failed) {
    process.exitCode = 1;
    return;
  }
  if (reportFile) writeJsonReportFile(reportFile, result);
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
