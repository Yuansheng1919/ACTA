import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { makeServer } from './server.mjs';
import { directConfig } from '../engine/direct.mjs';
import { loadConfig } from './config.mjs';
const env=process.env;
const config = loadConfig(env);
const numeric=(name,fallback,min=1)=>{
  const n=Number(env[name]??fallback);
  if(!Number.isSafeInteger(n)||n<min)throw Error('invalid '+name);
  return n;
};
const runner=env.ACTA_RUNNER??'host';
if(!['direct','host'].includes(runner))throw Error('config.invalid.runner');
const direct=runner==='direct'?directConfig({endpoint:env.ACTA_DIRECT_URL,model:env.ACTA_DIRECT_MODEL,
  key:env.PROVIDER_KEY,timeoutMs:numeric('ACTA_DIRECT_TIMEOUT_MS',480000)}):null;
const server=makeServer({
  direct,
  ...config,
  daily:numeric('ACTA_DAILY',50),concurrency:numeric('ACTA_CONCURRENCY',2),ipBurst:numeric('ACTA_IP_BURST',60),
  trustedProxy:env.ACTA_TRUSTED_PROXY,
  host:{entry:env.ACTA_HOST_ENTRY??fileURLToPath(new URL('../mock/fake-host.mjs',import.meta.url)),
    profile:env.PROFILE??'default',timeoutMs:numeric('ACTA_HOST_TIMEOUT_MS',480000),
    env:Object.fromEntries(Object.entries({HOME_ROOT:env.HOME_ROOT??join(env.ACTA_DATA,'host'),
      PROVIDER_KEY:env.PROVIDER_KEY,NO_PROXY:env.NO_PROXY,no_proxy:env.no_proxy,HOST_MODE:env.HOST_MODE}).filter(([,v])=>v!==undefined))}
});
server.listen(numeric('ACTA_PORT',3000,0),env.ACTA_BIND??'127.0.0.1',()=>{
  if(process.send)process.send({port:server.address().port});
});
