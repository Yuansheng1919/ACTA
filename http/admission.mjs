import { join } from 'node:path';
import { isIP } from 'node:net';
import { atomicJson, readJson, hash } from '../store/commit.mjs';
import { reject } from '../engine/fault.mjs';

export class Admission {
  constructor({root, credentials, daily=50, concurrency=2, ipBurst=60, windowMs=10000, trustedProxy}) {
    Object.assign(this,{root,credentials,daily,concurrency,ipBurst,windowMs,trustedProxy});
    this.active=new Map(); this.buckets=new Map(); this.nextSweep=0;
  }
  authenticate(req) {
    const match=/^Bearer ([^\s]+)$/i.exec(req.headers.authorization??'');
    if(!match) reject(401,'auth.required');
    const key=hash(match[1]);
    if(!this.credentials().includes(key)) reject(401,'auth.invalid');
    return key;
  }
  limit(req) {
    const peer=req.socket.remoteAddress;
    const forwarded=req.headers['x-forwarded-for'];
    const last=typeof forwarded==='string'?forwarded.split(',').at(-1).trim():'';
    const ip=peer===this.trustedProxy && isIP(last)?last:peer;
    const now=Date.now();
    if(now>=this.nextSweep){
      for(const [k,b] of this.buckets)if(b.until<=now)this.buckets.delete(k);
      this.nextSweep=now+this.windowMs;
    }
    const b=this.buckets.get(ip);
    if(b && b.until>now) {
      if(b.count>=this.ipBurst) reject(429,'limit.ip');
      b.count++;
    } else this.buckets.set(ip,{count:1,until:now+this.windowMs});
  }
  async job(owner,fn) {
    const current=this.active.get(owner)??0;
    if(current>=this.concurrency)reject(429,'limit.concurrent');
    const today=new Date().toISOString().slice(0,10);
    const file=join(this.root,'quota',owner+'.json');
    const saved=readJson(file);
    const n=saved?.day===today?saved.n:0;
    if(n>=this.daily)reject(429,'limit.daily');
    atomicJson(file,{day:today,n:n+1});
    this.active.set(owner,current+1);
    try {return await fn();}
    finally {
      const left=this.active.get(owner)-1;
      if(left)this.active.set(owner,left);else this.active.delete(owner);
    }
  }
}
