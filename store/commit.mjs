import { mkdirSync, readFileSync, renameSync, rmSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { reject } from '../engine/fault.mjs';

export function atomicJson(file, object) {
  const tmp = file + '.' + randomUUID() + '.tmp';
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd,JSON.stringify(object)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp,file);
    if (process.platform !== 'win32') {
      const dir = openSync(dirname(file),'r');
      try { fsyncSync(dir); } finally { closeSync(dir); }
    }
  } finally { rmSync(tmp, {force:true}); }
}
export function readJson(file) {
  try { return JSON.parse(readFileSync(file,'utf8')); }
  catch(e) { if(e.code === 'ENOENT') return null; throw e; }
}

export const hash = text => createHash('sha256').update(text).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map(k => [k,canonical(value[k])]));
  return value;
}

export class Storage {
  constructor(root) {
    this.root = root;
    for(const folder of ['cards','sessions','jobs','logs','quota'])
      mkdirSync(join(root,folder),{recursive:true,mode:0o700});
  }
  file(kind,id) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) reject(404,'resource.missing');
    return join(this.root,kind,id+'.json');
  }
  owned(kind,id,owner) {
    const value = readJson(this.file(kind,id));
    if (!value || value.owner !== owner) reject(404,'resource.missing');
    return value;
  }
  put(kind,id,value) { atomicJson(this.file(kind,id),value); }
  create(kind,owner,fields) {
    const id=randomUUID();
    this.put(kind,id,{...fields,id,owner});
    return id;
  }
}
