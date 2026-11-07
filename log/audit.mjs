import { appendFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';

export function auditLog({root,key,keyVersion='1'}) {
  if(!key)throw Error('hmac_key_required');
  const dir=join(root,'logs');let lastDay;
  return {
    proof(text){return {hmac:createHmac('sha256',key).update(text.normalize('NFC'),'utf8').digest('hex'),
      key_version:keyVersion,canonical:'NFC/UTF-8;exact-whitespace'};},
    write(event,fields) {
      const ts=new Date().toISOString(),day=ts.slice(0,10);
      if(day!==lastDay) {
        const first=new Date(Date.now()-13*86400000).toISOString().slice(0,10);
        for(const name of readdirSync(dir)){
          const m=/^(\d{4}-\d\d-\d\d)\.jsonl$/.exec(name);
          if(m && m[1]<first)unlinkSync(join(dir,name));
        }
        lastDay=day;
      }
      appendFileSync(join(dir,day+'.jsonl'),JSON.stringify({ts,event,...fields})+'\n',{mode:0o600});
    }
  };
}
