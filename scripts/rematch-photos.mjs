/* Rebuild photos.csv by matching Tilda photos to the current catalog by TITLE.
 *
 * Pass 1 — exact normalized-title match.
 * Pass 2 — safe fuzzy match for products the price list renamed vs the Tilda store.
 *   A fuzzy match is accepted ONLY when ALL hold:
 *     • identical number set (№01↔#001, leading zeros ignored; different volumes never mix),
 *     • ≥2 shared words and Jaccard ≥ 0.45,
 *     • NOT a conflict: the two titles don't EACH carry a distinctive word (non-generic and
 *       not a ≤2-edit typo of the other's) — this rejects brand swaps (NUDE↔Enova) and
 *       variants (Diamond↔Matte) while keeping typos / translations / word-reorder,
 *     • it is the UNIQUE passing candidate for that product, and each photo is used once.
 *   Only files already on R2 are used. Stale SKU-keyed bindings are dropped.
 *
 * Run: node scripts/rematch-photos.mjs [--report]   then   npm run catalog
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const R2 = 'https://pub-bdc9e7e148164007b19e2753ba1b49b9.r2.dev/';
const REPORT = process.argv.includes('--report');
const GENERIC = new Set(['gel','polish','color','coat','pentru','set','kit','buc','pcs','nr','the']);

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'catalog.json'), 'utf8'));
const tilda = JSON.parse(fs.readFileSync(path.join(__dirname, 'tilda-photos.json'), 'utf8'));

function parseCSV(text){ const rows=[];let row=[],f="",q=false;text=text.replace(/^﻿/,"");
  for(let i=0;i<text.length;i++){const c=text[i];
    if(q){if(c==='"'){if(text[i+1]==='"'){f+='"';i++;}else q=false;}else f+=c;}
    else if(c==='"')q=true;else if(c===','){row.push(f);f="";}
    else if(c==='\n'){row.push(f);rows.push(row);row=[];f="";}else if(c!=='\r')f+=c;}
  if(f.length||row.length){row.push(f);rows.push(row);} return rows; }
const qt = (s)=> '"'+String(s).replace(/"/g,'""')+'"';
const deburr = (s)=> (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
const normTitle = (s)=> deburr(s).replace(/&amp;/g,' ').replace(/&/g,' ').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,'');
const numsOf = (s)=> new Set((s.match(/\d+/g)||[]).map(x=>String(parseInt(x,10))));
const wordsOf = (s)=> new Set((deburr(s).match(/[a-z]+/g)||[]).filter(w=>w.length>=3));
const toR2 = (url)=> R2 + url.split('/').pop().trim();
const sameSet = (a,b)=>{ if(a.size!==b.size) return false; for(const x of a) if(!b.has(x)) return false; return true; };
const jaccard = (a,b)=>{ let i=0; for(const x of a) if(b.has(x)) i++; const u=a.size+b.size-i; return u? i/u : 0; };
const inter = (a,b)=>{ let i=0; for(const x of a) if(b.has(x)) i++; return i; };
function editLE(a,b,max){ if(Math.abs(a.length-b.length)>max) return false;
  let dp=Array.from({length:a.length+1},(_,i)=>i);
  for(let j=1;j<=b.length;j++){ let prev=dp[0]; dp[0]=j;
    for(let i=1;i<=a.length;i++){ const t=dp[i]; dp[i]=Math.min(dp[i]+1,dp[i-1]+1,prev+(a[i-1]===b[j-1]?0:1)); prev=t; } }
  return dp[a.length]<=max; }
// a "distinctive" word: not generic, and no ≤2-edit lookalike on the other side
const hasUnpaired = (only, other)=> [...only].some(w=> !GENERIC.has(w) && ![...other].some(o=>editLE(w,o,2)));

// files already on R2 (from the existing photos.csv values)
const uploaded = new Set();
try { const rows=parseCSV(fs.readFileSync(path.join(ROOT,'photos.csv'),'utf8'));
  for(const r of rows.slice(1)) for(const u of (r[1]||'').split(/\s+/)) if(u) uploaded.add(u.trim()); } catch {}

const ents = [], byExact = new Map();
for(const e of tilda){
  const urls=(e.urls||[]).map(toR2).filter(u=>uploaded.has(u));
  if(!urls.length) continue;
  const ent={ title:e.title, urls, key:normTitle(e.title), nums:numsOf(e.title), words:wordsOf(e.title) };
  ents.push(ent); if(ent.key && !byExact.has(ent.key)) byExact.set(ent.key, ent);
}

const photo={}, claimed=new Set(), report=[];

// pass 1 — exact
let exact=0;
for(const p of catalog){ const e=byExact.get(normTitle(p.name)); if(e){ photo[p.key]=e.urls.join(' '); claimed.add(e); exact++; } }

// pass 2 — safe fuzzy
const proposals=[];
for(const p of catalog){
  if(photo[p.key]) continue;
  const pn=numsOf(p.name), pw=wordsOf(p.name);
  const passing=[];
  for(const e of ents){
    if(claimed.has(e) || !sameSet(pn,e.nums)) continue;
    if(inter(pw,e.words)<2) continue;
    const onlyA=new Set([...pw].filter(w=>!e.words.has(w)));
    const onlyB=new Set([...e.words].filter(w=>!pw.has(w)));
    if(hasUnpaired(onlyA,onlyB) && hasUnpaired(onlyB,onlyA)) continue;   // conflicting on BOTH sides
    const score=jaccard(pw,e.words);
    if(score>=0.45) passing.push({e,score});
  }
  if(passing.length===1) proposals.push({ p, e:passing[0].e, score:passing[0].score });
}
proposals.sort((a,b)=> b.score-a.score);
let fuzzy=0;
for(const {p,e,score} of proposals){
  if(claimed.has(e) || photo[p.key]) continue;
  photo[p.key]=e.urls.join(' '); claimed.add(e); fuzzy++;
  report.push(`${score.toFixed(2)}  ${p.name}   ⟵   ${e.title}`);
}

const out=[['SKU','Photo'].map(qt).join(',')];
for(const p of catalog) if(photo[p.key]) out.push([p.key, photo[p.key]].map(qt).join(','));
fs.writeFileSync(path.join(ROOT,'photos.csv'), '﻿'+out.join('\r\n')+'\r\n');

console.log(`✓ photos.csv: ${exact+fuzzy}/${catalog.length} matched  (exact ${exact} + fuzzy ${fuzzy})`);
if(REPORT){ fs.writeFileSync(path.join(ROOT,'_photo-fuzzy-report.txt'), report.sort().join('\n')+'\n');
  console.log('  fuzzy report -> _photo-fuzzy-report.txt'); }
