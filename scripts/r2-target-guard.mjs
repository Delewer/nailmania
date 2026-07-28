import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const valueAfter = (args, flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? String(args[index + 1] || '').trim() : '';
};

const git = (root, ...args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    throw new Error(`Git command failed: git ${args.join(' ')}`);
  }
  return String(result.stdout || '').trim();
};

const configuredBucket = (root, environment) => {
  const config = readFileSync(path.join(root, 'wrangler.toml'), 'utf8');
  const marker = new RegExp(`^\\[\\[env\\.${environment}\\.r2_buckets\\]\\]\\s*$`, 'm');
  const match = marker.exec(config);
  if (!match) return '';
  const remainder = config.slice(match.index + match[0].length);
  const nextHeader = /^[ \t]*\[/m.exec(remainder);
  const block = nextHeader ? remainder.slice(0, nextHeader.index) : remainder;
  if (!/^[ \t]*binding[ \t]*=[ \t]*"PRODUCT_IMAGES"[ \t]*$/m.test(block)) return '';
  return block.match(/^[ \t]*bucket_name[ \t]*=[ \t]*"([^"]+)"[ \t]*$/m)?.[1] || '';
};

export function requireR2MutationTarget({ root, args = process.argv.slice(2), env = process.env }) {
  const environment = valueAfter(args, '--environment');
  if (!['preview', 'production'].includes(environment)) {
    throw new Error('R2 mutation requires --environment preview|production');
  }
  const expectedBucket = configuredBucket(root, environment);
  if (!expectedBucket) throw new Error(`R2 bucket binding is missing for ${environment}`);
  const actualBucket = String(env.R2_BUCKET || '').trim();
  if (actualBucket !== expectedBucket || valueAfter(args, '--confirm-bucket') !== expectedBucket) {
    throw new Error(
      `R2 mutation requires R2_BUCKET=${expectedBucket} and --confirm-bucket ${expectedBucket}`,
    );
  }

  const head = git(root, 'rev-parse', 'HEAD');
  if (!/^[a-f0-9]{40}$/i.test(head) || valueAfter(args, '--expected-commit') !== head) {
    throw new Error(`R2 mutation requires --expected-commit ${head}`);
  }
  if (git(root, 'status', '--porcelain')) throw new Error('R2 mutation requires a clean Git worktree');
  if (environment === 'production' && git(root, 'branch', '--show-current') !== 'main') {
    throw new Error('Production R2 mutation must run from main');
  }
  return { environment, bucket: expectedBucket, commit: head };
}

export function requirePublicBaseUrl(args, env = process.env, environment = '') {
  const value = valueAfter(args, '--public-base-url') || String(env.R2_PUBLIC_BASE_URL || '').trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('R2 mutation requires a valid HTTPS --public-base-url (or R2_PUBLIC_BASE_URL)');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('R2 public base URL must be an HTTPS origin/path without credentials, query or fragment');
  }
  if (environment === 'production' && url.hostname.toLocaleLowerCase('en-US').endsWith('.r2.dev')) {
    throw new Error('Production R2 public base URL must use a custom domain; r2.dev is rate-limited');
  }
  return url.href.replace(/\/+$/, '');
}
