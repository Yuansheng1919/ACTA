import { randomUUID } from 'node:crypto';
import { mkdirSync,writeFileSync,readFileSync,renameSync,rmSync,existsSync,openSync,fsyncSync,closeSync } from 'node:fs';
import { join } from 'node:path';
import { exportBundle,verifyBundle } from '../engine/export.mjs';
import { hash } from './commit.mjs';
import { reject } from '../engine/fault.mjs';

export const downloads={file:['card.png','image/png'],world:['world.json','application/json'],
  capabilities:['CAPABILITIES.md','text/markdown; charset=utf-8'],manifest:['manifest.json','application/json'],
  bundle:['card-bundle.zip','application/zip']};

export function publishCard(storage,owner,fields) {
  const id=randomUUID(),card={...fields,owner,id};
  const dir=join(storage.root,'assets');mkdirSync(dir,{recursive:true,mode:0o700});
  const final=join(dir,id+'.zip'),temp=final+'.tmp';
  try {
    const fd=openSync(temp,'wx',0o600);
    try {writeFileSync(fd,exportBundle(card));fsyncSync(fd);}finally{closeSync(fd);}
    const bytes=readFileSync(temp);
    verifyBundle(bytes,card);
    card.bundle_sha256=hash(bytes);
    renameSync(temp,final);
    if(process.platform!=='win32'){
      const fd=openSync(dir,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
    }
    storage.put('cards',id,card);
    const files=Object.fromEntries(Object.keys(downloads).map(k=>[k,'/v1/card/'+id+'/'+k]));
    return {card_revision:id,slug:id,files,bundle_sha256:card.bundle_sha256};
  } catch(e) {
    if(!existsSync(storage.file('cards',id)))rmSync(final,{force:true});
    throw e;
  } finally {rmSync(temp,{force:true});}
}
export function download(storage,card,kind) {
  // Existing private revisions created before asset publication render from their pinned fields.
  const bytes=card.bundle_sha256?readFileSync(join(storage.root,'assets',card.id+'.zip')):exportBundle(card);
  if(card.bundle_sha256 && hash(bytes)!==card.bundle_sha256)reject(500,'export.integrity');
  const members=verifyBundle(bytes,card);
  return kind==='bundle'?bytes:members.get(downloads[kind][0]);
}
