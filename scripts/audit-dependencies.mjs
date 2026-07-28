import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const npmExecPath = String(process.env.npm_execpath || '').trim();
const command = npmExecPath ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
const auditArgs = npmExecPath ? [npmExecPath, 'audit', '--json'] : ['audit', '--json'];
const result = spawnSync(command, auditArgs, {
  cwd: root,
  encoding: 'utf8',
  stdio: 'pipe',
  maxBuffer: 16 * 1024 * 1024,
});
if (result.error) throw result.error;

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  process.stderr.write(result.stderr || '');
  throw new Error('npm audit did not return valid JSON');
}

if (result.status === 0) {
  console.log('Dependency audit passed: 0 vulnerabilities.');
  process.exit(0);
}
if (result.status !== 1) {
  process.stderr.write(result.stderr || '');
  throw new Error(`npm audit failed with exit code ${result.status}`);
}

// npm currently reports GHSA-qwww-vcr4-c8h2 for react-router >=7.12.
// Upstream explicitly limits it to unstable RSC APIs. This storefront uses
// BrowserRouter declarative mode only, so keep a narrow machine-checked
// exception until an installable patched release supports our React version.
const vulnerabilities = report?.vulnerabilities || {};
const names = Object.keys(vulnerabilities).sort();
if (JSON.stringify(names) !== JSON.stringify(['react-router', 'react-router-dom'])) {
  throw new Error(`Dependency audit contains unreviewed packages: ${names.join(', ') || '(none)'}`);
}
const routerVia = vulnerabilities['react-router']?.via;
const domVia = vulnerabilities['react-router-dom']?.via;
if (!Array.isArray(routerVia)
    || routerVia.length !== 1
    || Number(routerVia[0]?.source) !== 1124282
    || routerVia[0]?.url !== 'https://github.com/advisories/GHSA-qwww-vcr4-c8h2'
    || JSON.stringify(domVia) !== JSON.stringify(['react-router'])) {
  throw new Error('Dependency audit no longer matches the reviewed React Router RSC-only advisory');
}

const router = JSON.parse(readFileSync(
  path.join(root, 'node_modules', 'react-router', 'package.json'),
  'utf8',
));
const [major, minor] = String(router.version).split('.').map(Number);
if (!(major > 7 || (major === 7 && minor >= 18))) {
  throw new Error(`react-router ${router.version} is missing the 7.18 navigation/SSR security fixes`);
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.(?:js|jsx|mjs)$/.test(entry.name) ? [file] : [];
  });
}
const source = sourceFiles(path.join(root, 'src'))
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');
if (!/\bBrowserRouter\b/.test(source)
    || /\b(?:unstable_RSC|RSCHydratedRouter|RSCStaticRouter|routeRSCServerRequest|createCallServer)\b/.test(source)) {
  throw new Error('React Router audit exception requires declarative BrowserRouter mode without unstable RSC APIs');
}

console.log(
  `Dependency audit accepted one upstream RSC-only advisory for react-router ${router.version}; `
  + 'declarative mode and absence of unstable RSC APIs were verified.',
);
