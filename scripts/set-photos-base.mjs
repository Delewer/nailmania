/* Point photos.csv at a host (R2 public URL) — or back to local paths.
 *
 * Rewrites only OUR Tilda photo files (known filenames from tilda-photos.json):
 * every such photo becomes "<base>/<filename>". Other entries (e.g. old Google
 * Drive URLs) are left untouched. Idempotent and host-agnostic — re-run anytime
 * to switch hosts.
 *
 * Usage:
 *   node scripts/set-photos-base.mjs https://pub-xxxx.r2.dev        # -> R2
 *   node scripts/set-photos-base.mjs https://img.nailmania.md       # -> custom domain
 *   node scripts/set-photos-base.mjs images/tilda                   # -> back to local
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CSV = path.join(ROOT, 'photos.csv');

const base = (process.argv[2] || '').replace(/\/+$/, '');
if (!base) { console.error('Usage: node scripts/set-photos-base.mjs <base-url-or-path>'); process.exit(1); }

// known Tilda filenames (so we only rewrite our own images)
const tilda = JSON.parse(fs.readFileSync(path.join(__dirname, 'tilda-photos.json'), 'utf8'));
const known = new Set();
for (const e of tilda) for (const f of (e.files || [])) known.add(f);

function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false; text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; } else if (c !== '\r') f += c; }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const qt = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const baseName = (u) => u.split('/').pop().split('?')[0];

const rows = parseCSV(fs.readFileSync(CSV, 'utf8'));
const h = rows[0].map((x) => x.toLowerCase().trim());
const si = h.indexOf('sku'), pi = h.indexOf('photo');
let changed = 0, tokens = 0;
const out = [['SKU', 'Photo']];
for (const r of rows.slice(1)) {
  const sku = (r[si] || '').trim(); const photo = (r[pi] || '').trim();
  if (!sku) continue;
  const mapped = photo.split(/\s+/).filter(Boolean).map((u) => {
    const n = baseName(u);
    if (known.has(n)) { tokens++; const nu = base + '/' + n; if (nu !== u) changed++; return nu; }
    return u; // leave non-Tilda entries as-is
  }).join(' ');
  out.push([sku, mapped]);
}
fs.writeFileSync(CSV, '﻿' + out.map((r) => r.map(qt).join(',')).join('\n') + '\n');
console.log(`photos.csv -> base "${base}"`);
console.log(`Tilda photo tokens: ${tokens}  (rewritten: ${changed})`);
