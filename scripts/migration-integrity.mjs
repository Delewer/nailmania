import { createHash } from 'node:crypto';

const MIGRATION_NAME = /^\d{4}_[a-z0-9_-]+\.sql$/;

export function migrationSha256(content) {
  const canonical = String(content).replace(/\r\n?/g, '\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function verifyMigrationManifest({ migrationFiles, manifestText, readMigration }) {
  const failures = [];
  const entries = new Map();
  const orderedNames = [];

  String(manifestText || '').split(/\r?\n/).forEach((line, index) => {
    if (!line.trim() || line.trimStart().startsWith('#')) return;
    const match = line.match(/^([a-f0-9]{64})  (\S+)$/i);
    if (!match || !MIGRATION_NAME.test(match[2])) {
      failures.push(`Migration checksum manifest line ${index + 1} is invalid`);
      return;
    }
    const checksum = match[1].toLowerCase();
    const filename = match[2];
    if (entries.has(filename)) {
      failures.push(`Migration checksum manifest contains duplicate ${filename}`);
      return;
    }
    entries.set(filename, checksum);
    orderedNames.push(filename);
  });

  const expectedFiles = [...migrationFiles].sort();
  if (JSON.stringify(orderedNames) !== JSON.stringify(expectedFiles)) {
    failures.push('Migration checksum manifest filenames/order do not match migrations/*.sql');
  }

  for (const filename of expectedFiles) {
    const expected = entries.get(filename);
    if (!expected) continue;
    const actual = migrationSha256(readMigration(filename));
    if (actual !== expected) {
      failures.push(`Migration ${filename} checksum drifted: expected ${expected}, got ${actual}`);
    }
  }

  return failures;
}
