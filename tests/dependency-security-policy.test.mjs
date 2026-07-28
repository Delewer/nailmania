import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.(?:js|jsx|mjs)$/.test(entry.name) ? [file] : [];
  });
}

test('React Router security exception stays limited to declarative mode without unstable RSC APIs', () => {
  const router = JSON.parse(readFileSync(
    path.join(root, 'node_modules', 'react-router', 'package.json'),
    'utf8',
  ));
  const [major, minor] = String(router.version).split('.').map(Number);
  assert.ok(
    major > 7 || (major === 7 && minor >= 18),
    `react-router ${router.version} does not include the 7.18 navigation/SSR security fixes`,
  );

  const applicationSource = sourceFiles(path.join(root, 'src'))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  assert.match(applicationSource, /\bBrowserRouter\b/);
  assert.doesNotMatch(
    applicationSource,
    /\b(?:unstable_RSC|RSCHydratedRouter|RSCStaticRouter|routeRSCServerRequest|createCallServer)\b/,
    'the accepted upstream audit exception is valid only while unstable React Router RSC APIs are unused',
  );
});
