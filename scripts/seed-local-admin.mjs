import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const sql = `
  INSERT INTO users (id, email, name, role, status)
  VALUES ('local-admin', 'admin@nailmania.local', 'Local Administrator', 'admin', 'active')
  ON CONFLICT(email) DO UPDATE SET
    name = excluded.name,
    role = 'admin',
    status = 'active',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
`;
const result = spawnSync(process.execPath, [
  path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
  'd1', 'execute', 'nailmania-local', '--local',
  '--config', 'wrangler.local.jsonc', '--persist-to', '.wrangler/state',
  '--command', sql,
], { cwd: root, encoding: 'utf8' });

if (result.error) throw result.error;
if (result.status !== 0) {
  process.stderr.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exit(result.status || 1);
}
console.log('Local administrator ready: admin@nailmania.local');
