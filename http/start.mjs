import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { makeServer } from './server.mjs';
import { hash } from '../store/commit.mjs';
import { examplePolicy } from '../engine/gates.mjs';
const env=process.env;
if(!env.ACTA_TOKEN_FILE||!env.ACTA_HMAC_KEY||!env.ACTA_DATA)
  throw Error('ACTA_TOKEN_FILE, ACTA_HMAC_KEY and ACTA_DATA required');
const numeric=(name,fallback,min=1)=>{
  const n=Number(env[name]??fallback);
  if(!Number.isSafeInteger(n)||n<min)throw Error('invalid '+name);
  return n;
};
const server=makeServer({
  root:env.ACTA_DATA,hmacKey:env.ACTA_HMAC_KEY,keyVersion:env.ACTA_KEY_VERSION??'1',
  credentials:()=>JSON.parse(readFileSync(env.ACTA_TOKEN_FILE,'utf8')).map(hash),
  daily:numeric('ACTA_DAILY',50),concurrency:numeric('ACTA_CONCURRENCY',2),ipBurst:numeric('ACTA_IP_BURST',60),
  trustedProxy:env.ACTA_TRUSTED_PROXY,
  policy:env.ACTA_POLICY?JSON.parse(readFileSync(env.ACTA_POLICY,'utf8')):examplePolicy,
  host:{entry:env.ACTA_HOST_ENTRY??fileURLToPath(new URL('../mock/fake-host.mjs',import.meta.url)),
    profile:env.PROFILE??'default',timeoutMs:numeric('ACTA_HOST_TIMEOUT_MS',480000),
    env:Object.fromEntries(Object.entries({HOME_ROOT:env.HOME_ROOT??join(env.ACTA_DATA,'host'),
      PROVIDER_KEY:env.PROVIDER_KEY,NO_PROXY:env.NO_PROXY,no_proxy:env.no_proxy,HOST_MODE:env.HOST_MODE}).filter(([,v])=>v!==undefined))}
});
server.listen(numeric('ACTA_PORT',3000,0),env.ACTA_BIND??'127.0.0.1',()=>{
  if(process.send)process.send({port:server.address().port});
});
