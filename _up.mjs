import { readFileSync, writeFileSync } from 'node:fs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
const dir=process.argv[2], chosenFile=process.argv[3];
const env={};for(const l of readFileSync('.env','utf8').split(/\r?\n/)){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m)env[m[1]]=m[2];}
const s3=new S3Client({region:'auto',endpoint:`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,credentials:{accessKeyId:env.R2_ACCESS_KEY_ID,secretAccessKey:env.R2_SECRET_ACCESS_KEY}});
const PUB='https://pub-bdc9e7e148164007b19e2753ba1b49b9.r2.dev/';
const cat=JSON.parse(readFileSync('src/catalog.json','utf8'));
const byCode={};for(const p of cat){const c=p.code||p.key;(byCode[c]||=[]).push(p);}
const map={};for(const line of readFileSync('photos.csv','utf8').split(/\r?\n/).slice(1)){const m=line.match(/^"?([^",]+)"?,\s*"?(.+?)"?$/);if(m)map[m[1]]=m[2];}
const before=Object.keys(map).length;
const chosen=JSON.parse(readFileSync(chosenFile,'utf8'));
let n=0;
for(const sku of Object.keys(chosen)){
  const prods=byCode[sku];if(!prods){console.log('NO CAT',sku);continue;}
  const key=prods[0].key;
  const body=readFileSync(dir+'/'+sku+'.jpg');
  await s3.send(new PutObjectCommand({Bucket:env.R2_BUCKET,Key:`backup/${key}.jpg`,Body:body,ContentType:'image/jpeg',CacheControl:'public, max-age=31536000, immutable'}));
  map[key]=PUB+`backup/${key}.jpg`;n++;process.stdout.write(sku+'->'+key+' ');
}
const qt=s=>'"'+String(s).replace(/"/g,'""')+'"';
writeFileSync('photos.csv','﻿'+'SKU,Photo\r\n'+Object.entries(map).map(([s,u])=>qt(s)+','+qt(u)).join('\r\n')+'\r\n');
console.log(`\nuploaded ${n}; photos.csv ${before} -> ${Object.keys(map).length}`);
