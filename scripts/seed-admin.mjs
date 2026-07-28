import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? String(args[index + 1] || '').trim() : '';
};
const forbiddenRemoteFlags = ['--apply-preview', '--apply-production', '--confirm-production']
  .filter((flag) => args.includes(flag));
if (forbiddenRemoteFlags.length) {
  throw new Error(
    'Direct remote administrator changes are disabled; use the guarded release:d1:admin:<environment> command',
  );
}

const email = valueAfter('--email').toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('A valid --email value is required');
const name = valueAfter('--name') || 'Nail Mania Administrator';
if (name.length > 120) throw new Error('Administrator name must not exceed 120 characters');
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const userId = `admin:${createHash('sha256').update(email).digest('hex').slice(0, 24)}`;
const sql = `PRAGMA foreign_keys = ON;

INSERT INTO users (id, email, name, role, status)
VALUES (${quote(userId)}, ${quote(email)}, ${quote(name)}, 'admin', 'active')
ON CONFLICT(email) DO UPDATE SET
  name = excluded.name,
  role = 'admin',
  status = 'active',
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
`;
const outputDirectory = path.join(root, 'tmp', 'd1');
const sqlPath = path.join(outputDirectory, 'admin-seed.sql');
const reportPath = path.join(outputDirectory, 'admin-seed-report.json');
const digest = (value) => createHash('sha256').update(value).digest('hex');
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(sqlPath, sql);
writeFileSync(reportPath, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  userId,
  emailSha256: digest(email),
  sqlSha256: digest(sql),
  sqlFile: path.relative(root, sqlPath),
}, null, 2)}\n`);
console.log(`Prepared administrator grant ${userId}`);
console.log(`SQL: ${path.relative(root, sqlPath)}`);
console.log(`Report: ${path.relative(root, reportPath)}`);
