// Child entry used exclusively by acceptance tests. Fault injection stays outside the HTTP API.
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { directConfig } from '../../engine/direct.mjs';
import { makeServer } from '../../http/server.mjs';
import { hash } from '../../store/commit.mjs';
const root=process.env.TEST_ROOT;
const cfg=JSON.parse(readFileSync(join(root,'config.json')));
const entry=fileURLToPath(new URL(cfg.stock?'../../mock/fake-host.mjs':'./scenario-host.mjs',import.meta.url));
const server=makeServer({
  root,direct:cfg.direct?directConfig(cfg.direct):null,policy:cfg.policy,hmacKey:process.env.TEST_HMAC,credentials:()=>JSON.parse(readFileSync(join(root,'tokens.json'))).map(hash),
  daily:cfg.daily??100,ipBurst:cfg.ipBurst??1000,concurrency:cfg.concurrency??4,trustedProxy:cfg.trustedProxy,
  host:{entry,env:{SCENARIO:join(root,'scenario.json'),OBSERVE:join(root,'observe.jsonl'),HOST_MODE:cfg.mode??'ok'},timeoutMs:cfg.timeoutMs??5000},
  ...(cfg.noop?{guard:(state)=>state}:{}),
  afterCommit:({res})=>{const flag=join(root,'drop-once');if(existsSync(flag)){unlinkSync(flag);res.destroy();}}
});
server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
