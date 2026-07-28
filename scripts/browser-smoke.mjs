import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeJsonReportFile } from './report-file.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const READ_ONLY_METHODS = new Set(['GET', 'HEAD']);
const DEFAULT_REPORT_FILE = 'tmp/reports/browser-smoke.json';
const PAGE_TIMEOUT_MS = 15_000;

const VIEWPORTS = Object.freeze([
  { name: 'desktop', width: 1440, height: 1000, mobile: false },
  { name: 'mobile', width: 390, height: 844, mobile: true },
]);

const outside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function normalizeLoopbackBaseUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); }
  catch { throw new Error('--base-url must be an exact loopback HTTP(S) origin'); }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash) {
    throw new Error('--base-url must be an exact loopback HTTP(S) origin');
  }
  return parsed.origin;
}

export function isLoopbackBaseUrl(value) {
  try { normalizeLoopbackBaseUrl(value); return true; }
  catch { return false; }
}

export function isReadOnlyHttpMethod(method) {
  return READ_ONLY_METHODS.has(String(method || '').toUpperCase());
}

export function parseArguments(argv) {
  const valueFlags = new Set(['--base-url', '--report-file', '--browser-path']);
  const booleanFlags = new Set(['--help']);
  const result = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (booleanFlags.has(flag)) {
      if (result.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
      result.set(flag, true);
      continue;
    }
    if (!valueFlags.has(flag)) {
      if (!String(flag).startsWith('-')) throw new Error(`Unknown positional argument: ${flag}`);
      throw new Error(`Unknown argument: ${flag}`);
    }
    if (result.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    const value = argv[index + 1];
    if (!value || String(value).startsWith('--')) throw new Error(`${flag} requires a value`);
    result.set(flag, value);
    index += 1;
  }
  return result;
}

const stripWrappingQuotes = (value) => {
  const text = String(value || '').trim();
  return text.length >= 2 && text[0] === text[text.length - 1] && ['"', "'"].includes(text[0])
    ? text.slice(1, -1)
    : text;
};

const isExecutableFile = (candidate) => {
  try { return existsSync(candidate) && statSync(candidate).isFile(); }
  catch { return false; }
};

function browserCandidates(env = process.env, platform = process.platform) {
  const candidates = [];
  const add = (...parts) => {
    if (parts[0]) candidates.push(path.join(...parts));
  };
  if (platform === 'win32') {
    add(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe');
    add(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe');
    add(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe');
    add(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    add(env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    add(env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    const pathNames = ['chrome.exe', 'msedge.exe'];
    for (const directory of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
      for (const name of pathNames) add(stripWrappingQuotes(directory), name);
    }
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
    );
    const pathNames = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
    for (const directory of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
      for (const name of pathNames) add(directory, name);
    }
  }
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

export function findBrowserExecutable({
  explicitPath = '',
  env = process.env,
  platform = process.platform,
  fileExists = isExecutableFile,
  cwd = process.cwd(),
} = {}) {
  const requested = stripWrappingQuotes(explicitPath || env.BROWSER_PATH);
  if (requested) {
    const resolved = path.resolve(cwd, requested);
    if (!fileExists(resolved)) throw new Error('The configured browser executable does not exist');
    return resolved;
  }
  const found = browserCandidates(env, platform).find(fileExists);
  if (!found) throw new Error('Chrome or Edge was not found; set BROWSER_PATH to its executable');
  return found;
}

export function resolveBrowserSmokePath(relativePath, { cwd = process.cwd() } = {}) {
  const root = path.resolve(cwd, 'tmp', 'browser-smoke');
  const target = path.resolve(root, String(relativePath || ''));
  if (target === root || outside(root, target)) {
    throw new Error('Browser smoke output must stay below tmp/browser-smoke');
  }
  return { root, target };
}

export function assertSafeBrowserProfilePath(profilePath, { cwd = process.cwd() } = {}) {
  const root = path.resolve(cwd, 'tmp', 'browser-smoke', 'profiles');
  const target = path.resolve(profilePath);
  if (outside(root, target) || target === root || !path.basename(target).startsWith('profile-')) {
    throw new Error('Refusing to remove an unsafe browser profile path');
  }
  return target;
}

export function assessPageSnapshot(snapshot) {
  const failures = [];
  if (snapshot.h1Count !== 1) failures.push(`expected one visible h1, found ${snapshot.h1Count}`);
  if (snapshot.visibleControlCount < 1) failures.push('no visible controls');
  if (snapshot.horizontalOverflowPixels > 1) {
    failures.push(`horizontal overflow: ${snapshot.horizontalOverflowPixels}px`);
  }
  for (const requirement of snapshot.requirements || []) {
    if (!requirement.present) failures.push(`missing visible selector: ${requirement.selector}`);
    else if (requirement.control && !requirement.named) {
      failures.push(`control has no accessible name: ${requirement.selector}`);
    }
  }
  return { passed: failures.length === 0, failures };
}

export function isExpectedFailedResponse({ method, path: requestPath, status }) {
  if (!isReadOnlyHttpMethod(method)) return false;
  if (requestPath === '/api/admin/session') return [401, 403].includes(Number(status));
  return requestPath === '/__browser-smoke-not-found__' && Number(status) === 404;
}

export function isDirectExecution(metaUrl = import.meta.url, entry = process.argv[1]) {
  return Boolean(entry) && metaUrl === pathToFileURL(path.resolve(entry)).href;
}

function sanitizedRequest(urlValue, baseOrigin) {
  try {
    const parsed = new URL(urlValue);
    return {
      sameOrigin: parsed.origin === baseOrigin,
      origin: parsed.origin,
      path: parsed.pathname,
    };
  } catch {
    return { sameOrigin: false, origin: 'invalid', path: '/' };
  }
}

function sanitizeDiagnostic(value, baseOrigin) {
  let output = String(value || '').replaceAll(baseOrigin, '<local-origin>');
  output = output.replace(/https?:\/\/[^\s"')>]+/gi, (candidate) => {
    try {
      const parsed = new URL(candidate);
      return `${parsed.origin}${parsed.pathname}`;
    } catch { return '<redacted-url>'; }
  });
  return output.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', (event) => this.receive(event.data));
    socket.addEventListener('close', () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('Browser debugging connection closed'));
      }
      this.pending.clear();
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('Timed out connecting to the browser'));
      }, 10_000);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new CdpClient(socket));
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Could not connect to the browser'));
      }, { once: true });
    });
  }

  receive(raw) {
    let message;
    try { message = JSON.parse(String(raw)); }
    catch { return; }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result || {});
      return;
    }
    const handlers = this.listeners.get(message.method) || [];
    for (const handler of handlers) {
      Promise.resolve(handler(message.params || {})).catch(() => {});
    }
  }

  on(method, handler) {
    const handlers = this.listeners.get(method) || [];
    handlers.push(handler);
    this.listeners.set(method, handlers);
  }

  send(method, params = {}, timeoutMs = 10_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
  }
}

async function unusedLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForDebugger(port, child) {
  const endpoint = `http://127.0.0.1:${port}/json/list`;
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Browser exited during startup (${child.exitCode})`);
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(600) });
      if (response.ok) {
        const targets = await response.json();
        const pageTarget = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
        if (pageTarget) return pageTarget.webSocketDebuggerUrl;
      }
    } catch {}
    await sleep(100);
  }
  throw new Error('Browser debugging endpoint did not become ready');
}

async function waitForChildExit(child, timeoutMs = 2_000) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(timeoutMs),
  ]);
}

function launchBrowser(executable, port, profilePath) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-default-browser-check',
    '--no-first-run',
    '--password-store=basic',
    '--use-mock-keychain',
    '--allow-insecure-localhost',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profilePath}`,
    '--window-size=1440,1000',
    'about:blank',
  ];
  return spawn(executable, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
}

function pageDefinitions(productKey) {
  return [
    {
      name: 'home',
      routePath: '/',
      required: [
        { selector: 'main h1', control: false },
        { selector: 'main a[href="#new"]', control: true },
      ],
    },
    {
      name: 'product',
      routePath: `/product/${encodeURIComponent(productKey)}`,
      required: [
        { selector: '.pd-info h1', control: false },
        { selector: '.pd-buy .addbtn:not(:disabled)', control: true },
      ],
    },
    {
      name: 'checkout',
      routePath: '/checkout',
      required: [
        { selector: 'form h1', control: false },
        { selector: '.co-sum .sline', control: false },
        { selector: '.co-place[type="submit"]', control: true },
      ],
    },
    {
      name: 'not-found',
      routePath: '/__browser-smoke-not-found__',
      required: [
        { selector: '.page-empty h1', control: false },
        { selector: '.page-empty a[href="/"]', control: true },
      ],
    },
    {
      name: 'login',
      routePath: '/login',
      required: [
        { selector: '.auth-page h1', control: false },
        { selector: '.auth-form input[type="email"]', control: true },
        { selector: '.auth-form input[type="password"]', control: true },
        { selector: '.auth-form button[type="submit"]', control: true },
      ],
    },
    {
      name: 'admin-login',
      routePath: '/admin',
      required: [
        { selector: '.adm-login h1', control: false },
        { selector: '#admin-token', control: true },
        { selector: '.adm-login button[type="submit"]', control: true },
      ],
    },
  ];
}

function inspectionExpression(required) {
  return `(() => {
    const required = ${JSON.stringify(required)};
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const accessibleName = (element) => {
      const aria = element.getAttribute('aria-label');
      if (aria && aria.trim()) return aria.trim();
      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
        if (text) return text;
      }
      const labels = Array.from(element.labels || []).map((label) => label.textContent || '').join(' ').trim();
      if (labels) return labels;
      const title = element.getAttribute('title');
      if (title && title.trim()) return title.trim();
      const text = element.textContent || element.getAttribute('alt') || '';
      return text.trim();
    };
    const requirements = required.map((item) => {
      const elements = Array.from(document.querySelectorAll(item.selector));
      const element = elements.find(visible) || null;
      return {
        selector: item.selector,
        control: item.control,
        present: Boolean(element),
        named: !item.control || Boolean(element && accessibleName(element)),
      };
    });
    const h1Count = Array.from(document.querySelectorAll('h1')).filter(visible).length;
    const controls = Array.from(document.querySelectorAll('a[href], button, input, select, textarea')).filter(visible);
    const widest = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0);
    return {
      readyState: document.readyState,
      h1Count,
      visibleControlCount: controls.length,
      horizontalOverflowPixels: Math.max(0, widest - window.innerWidth),
      requirements,
    };
  })()`;
}

async function evaluate(client, expression, { awaitPromise = false, timeoutMs = 10_000 } = {}) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  }, timeoutMs);
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(`Page evaluation failed: ${description}`);
  }
  return result.result?.value;
}

async function waitForPage(client, required) {
  const deadline = Date.now() + PAGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const snapshot = await evaluate(client, inspectionExpression(required));
      if (snapshot?.readyState === 'complete' && snapshot.requirements.every((item) => item.present)) return;
    } catch {}
    await sleep(120);
  }
  throw new Error('Timed out waiting for required page content');
}

async function putOneProductInLocalCart(client) {
  const expression = `(async () => {
    const response = await fetch('/api/products?limit=5000', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('Product catalog request failed');
    const payload = await response.json();
    const product = (payload.items || []).find((item) => item && item.key && Number(item.stock) > 0);
    if (!product) throw new Error('No in-stock product is available for browser smoke');
    localStorage.setItem('nm_cart', JSON.stringify([{ id: String(product.key), q: 1 }]));
    localStorage.setItem('nm_lang', 'ro');
    return { key: String(product.key), quantity: 1 };
  })()`;
  return evaluate(client, expression, { awaitPromise: true, timeoutMs: PAGE_TIMEOUT_MS });
}

const uniqueBy = (items, keyOf) => [...new Map(items.map((item) => [keyOf(item), item])).values()];

export async function runBrowserSmoke({
  baseUrl,
  browserPath,
  reportFile = DEFAULT_REPORT_FILE,
  cwd = process.cwd(),
} = {}) {
  const baseOrigin = normalizeLoopbackBaseUrl(baseUrl);
  const executable = findBrowserExecutable({ explicitPath: browserPath, cwd });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runName = `run-${stamp}-${process.pid}`;
  const { root: smokeRoot, target: runDirectory } = resolveBrowserSmokePath(runName, { cwd });
  const profileRoot = path.join(smokeRoot, 'profiles');
  const profilePath = assertSafeBrowserProfilePath(path.join(profileRoot, `profile-${stamp}-${process.pid}`), { cwd });
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
  mkdirSync(profilePath, { recursive: true, mode: 0o700 });

  const port = await unusedLoopbackPort();
  const child = launchBrowser(executable, port, profilePath);
  let browserStderr = '';
  child.stderr.on('data', (chunk) => {
    browserStderr = `${browserStderr}${chunk}`.slice(-4_000);
  });

  let client;
  let currentRoute = null;
  const requestMap = new Map();
  const blockedWriteRequests = [];
  const failedResponses = [];
  const pageErrors = [];
  const pages = [];
  let selectedProduct;

  try {
    const debuggerUrl = await waitForDebugger(port, child);
    client = await CdpClient.connect(debuggerUrl);

    client.on('Fetch.requestPaused', async ({ requestId, request }) => {
      const method = String(request.method || '').toUpperCase();
      const details = sanitizedRequest(request.url, baseOrigin);
      if (!isReadOnlyHttpMethod(method)) {
        blockedWriteRequests.push({
          routeName: currentRoute || 'startup',
          method,
          path: details.path,
          sameOrigin: details.sameOrigin,
        });
        await client.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
        return;
      }
      await client.send('Fetch.continueRequest', { requestId });
    });
    client.on('Network.requestWillBeSent', ({ requestId, request }) => {
      const details = sanitizedRequest(request.url, baseOrigin);
      requestMap.set(requestId, {
        routeName: currentRoute || 'startup',
        method: String(request.method || '').toUpperCase(),
        ...details,
      });
    });
    client.on('Network.responseReceived', ({ requestId, response }) => {
      const request = requestMap.get(requestId);
      if (!request?.sameOrigin || Number(response.status) < 400) return;
      failedResponses.push({
        routeName: request.routeName,
        method: request.method,
        path: request.path,
        status: Number(response.status),
      });
    });
    client.on('Network.loadingFailed', ({ requestId, canceled, errorText }) => {
      const request = requestMap.get(requestId);
      if (!request?.sameOrigin || canceled || !isReadOnlyHttpMethod(request.method)) return;
      failedResponses.push({
        routeName: request.routeName,
        method: request.method,
        path: request.path,
        status: 0,
        reason: sanitizeDiagnostic(errorText, baseOrigin),
      });
    });
    client.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      pageErrors.push({
        routeName: currentRoute || 'startup',
        kind: 'exception',
        message: sanitizeDiagnostic(
          exceptionDetails.exception?.description || exceptionDetails.text || 'Uncaught exception',
          baseOrigin,
        ),
      });
    });
    client.on('Runtime.consoleAPICalled', ({ type, args }) => {
      if (!['error', 'assert'].includes(type)) return;
      const message = args.map((entry) => entry.value ?? entry.description ?? '').join(' ');
      pageErrors.push({
        routeName: currentRoute || 'startup',
        kind: 'console',
        message: sanitizeDiagnostic(message, baseOrigin),
      });
    });
    client.on('Log.entryAdded', ({ entry }) => {
      if (entry.level !== 'error' || entry.source !== 'javascript') return;
      pageErrors.push({
        routeName: currentRoute || 'startup',
        kind: 'javascript-log',
        message: sanitizeDiagnostic(entry.text, baseOrigin),
      });
    });

    await Promise.all([
      client.send('Page.enable'),
      client.send('Runtime.enable'),
      client.send('Network.enable'),
      client.send('Log.enable'),
      client.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }),
    ]);

    for (const viewport of VIEWPORTS) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        screenWidth: viewport.width,
        screenHeight: viewport.height,
        deviceScaleFactor: 1,
        mobile: viewport.mobile,
      });

      const definitions = pageDefinitions(selectedProduct?.key || '__pending__');
      for (const definition of definitions) {
        if (definition.name === 'product' && !selectedProduct) {
          throw new Error('The smoke cart product was not selected before the product route');
        }
        const routePath = definition.name === 'product'
          ? `/product/${encodeURIComponent(selectedProduct.key)}`
          : definition.routePath;
        currentRoute = `${viewport.name}:${definition.name}`;
        const navigation = await client.send('Page.navigate', { url: `${baseOrigin}${routePath}` }, PAGE_TIMEOUT_MS);
        if (navigation.errorText) throw new Error(`Navigation failed for ${definition.name}: ${navigation.errorText}`);
        await waitForPage(client, definition.required);
        await sleep(250);
        const snapshot = await evaluate(client, inspectionExpression(definition.required));
        const assessment = assessPageSnapshot(snapshot);
        const screenshotName = `${viewport.name}-${definition.name}.png`;
        const screenshotPath = path.join(runDirectory, screenshotName);
        const captured = await client.send('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: false,
        }, PAGE_TIMEOUT_MS);
        writeFileSync(screenshotPath, Buffer.from(captured.data, 'base64'), { flag: 'wx', mode: 0o600 });
        pages.push({
          viewport: viewport.name,
          width: viewport.width,
          height: viewport.height,
          pageName: definition.name,
          routePath,
          screenshotPath: path.relative(cwd, screenshotPath).replaceAll(path.sep, '/'),
          h1Count: snapshot.h1Count,
          visibleControlCount: snapshot.visibleControlCount,
          horizontalOverflowPixels: snapshot.horizontalOverflowPixels,
          passed: assessment.passed,
          failures: assessment.failures,
        });

        if (definition.name === 'home' && !selectedProduct) {
          selectedProduct = await putOneProductInLocalCart(client);
        }
      }
    }
  } finally {
    currentRoute = null;
    if (client) {
      try { await client.send('Browser.close', {}, 1_500); }
      catch {}
      client.close();
    }
    await waitForChildExit(child);
    if (child.exitCode === null) child.kill();
    await waitForChildExit(child);
    const safeProfile = assertSafeBrowserProfilePath(profilePath, { cwd });
    rmSync(safeProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  const uniqueFailures = uniqueBy(failedResponses, (item) => JSON.stringify(item));
  const uniqueErrors = uniqueBy(pageErrors, (item) => JSON.stringify(item));
  const uniqueWrites = uniqueBy(blockedWriteRequests, (item) => JSON.stringify(item));
  const unexpectedFailedResponses = uniqueFailures.filter((item) => !isExpectedFailedResponse(item));
  const forbiddenWriteAttempts = uniqueWrites.filter((item) => item.sameOrigin && item.path !== '/api/events');
  const pageFailureCount = pages.filter((page) => !page.passed).length;
  const passed = Boolean(selectedProduct)
    && pageFailureCount === 0
    && unexpectedFailedResponses.length === 0
    && uniqueErrors.length === 0
    && forbiddenWriteAttempts.length === 0;
  const browserName = path.basename(executable).toLowerCase().includes('edge') ? 'edge' : 'chrome';

  const report = {
    kind: 'browser-smoke',
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseOrigin,
    browser: browserName,
    status: passed ? 'passed' : 'failed',
    safety: {
      serverWriteRequestsSent: 0,
      blockedWriteRequestCount: uniqueWrites.length,
      forbiddenWriteAttemptCount: forbiddenWriteAttempts.length,
      cartQuantity: selectedProduct?.quantity || 0,
    },
    selectedProduct: selectedProduct ? { key: selectedProduct.key } : null,
    summary: {
      viewportCount: VIEWPORTS.length,
      pageCount: pages.length,
      pageFailureCount,
      pageErrorCount: uniqueErrors.length,
      failedResponseCount: uniqueFailures.length,
      unexpectedFailedResponseCount: unexpectedFailedResponses.length,
    },
    pages,
    blockedWriteRequests: uniqueWrites,
    failedResponses: uniqueFailures.map((item) => ({
      ...item,
      expected: isExpectedFailedResponse(item),
    })),
    pageErrors: uniqueErrors,
  };
  writeJsonReportFile(reportFile, report, { cwd });
  return report;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/browser-smoke.mjs --base-url http://127.0.0.1:8797 [--report-file tmp/reports/browser-smoke.json]',
    '',
    'Optional browser selection:',
    '  --browser-path <path>   (or set BROWSER_PATH)',
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (args.get('--help')) {
    console.log(usage());
    return 0;
  }
  if (!args.has('--base-url')) throw new Error('--base-url is required');
  const report = await runBrowserSmoke({
    baseUrl: args.get('--base-url'),
    browserPath: args.get('--browser-path'),
    reportFile: args.get('--report-file') || DEFAULT_REPORT_FILE,
  });
  console.log(JSON.stringify(report, null, 2));
  return report.status === 'passed' ? 0 : 1;
}

if (isDirectExecution()) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`Browser smoke failed: ${error.message}`);
    process.exitCode = 1;
  });
}
