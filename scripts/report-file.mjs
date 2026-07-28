import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const SENSITIVE_KEY = /(?:^|_)(?:authorization|cookie|password|secret|token|email|phone|address|customer|recipient)(?:$|_)/;

const normalizedKey = (key) => String(key)
  .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  .replace(/[^a-zA-Z0-9]+/g, '_')
  .toLowerCase();

const isOutside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
};

const samePath = (left, right) => {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
};

export function assertReportContainsNoSensitiveData(value, location = 'report') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertReportContainsNoSensitiveData(entry, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (SENSITIVE_KEY.test(normalized) && entry !== null && typeof entry !== 'boolean') {
      throw new Error(`Report contains a sensitive field at ${location}.${key}`);
    }
    if ((normalized.endsWith('_url') || normalized === 'url')
        && entry !== null && typeof entry !== 'boolean') {
      if (typeof entry !== 'string') {
        throw new Error(`Report contains an invalid URL at ${location}.${key}`);
      }
      let parsed;
      try { parsed = new URL(entry); }
      catch { throw new Error(`Report contains an invalid URL at ${location}.${key}`); }
      if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error(`Report URL must not contain credentials, query or fragment at ${location}.${key}`);
      }
    }
    assertReportContainsNoSensitiveData(entry, `${location}.${key}`);
  }
}

export function serializeJsonReport(report) {
  assertReportContainsNoSensitiveData(report);
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function resolveReportFile(reportFile, { cwd = process.cwd() } = {}) {
  const requested = String(reportFile || '').trim();
  if (!requested || requested === 'true') throw new Error('--report-file requires a JSON path under tmp/reports');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(requested)) {
    throw new Error('--report-file must be a local filesystem path, not a URL');
  }

  const root = path.resolve(cwd, 'tmp', 'reports');
  const target = path.resolve(cwd, requested);
  if (target === root || isOutside(root, target)) {
    throw new Error('--report-file must stay under tmp/reports');
  }
  if (path.extname(target).toLowerCase() !== '.json') {
    throw new Error('--report-file must end in .json');
  }
  return { root, target };
}

export function writeJsonReportFile(reportFile, report, { cwd = process.cwd() } = {}) {
  const { root, target } = resolveReportFile(reportFile, { cwd });
  const serialized = serializeJsonReport(report);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });

  const realRoot = realpathSync(root);
  const realParent = realpathSync(path.dirname(target));
  if (!samePath(realRoot, root)) {
    throw new Error('tmp/reports must not be a symbolic link');
  }
  if (isOutside(realRoot, realParent)) {
    throw new Error('--report-file parent resolves outside tmp/reports');
  }
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error('--report-file must not replace a symbolic link');
  }

  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return { path: target, serialized };
}
