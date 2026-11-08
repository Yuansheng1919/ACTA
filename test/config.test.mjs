import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../http/config.mjs';
import { examplePolicy } from '../engine/gates.mjs';
import { hash } from '../store/commit.mjs';

test('startup parses BOM JSON, hot revocation and malformed replacement fail closed', t => {
  const root=mkdtempSync(join(tmpdir(),'acta-config-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const env={ACTA_DATA:root,ACTA_TOKEN_FILE:join(root,'tokens'),ACTA_POLICY:join(root,'policy'),ACTA_HMAC_KEY:randomUUID()};
  const token=randomUUID();
  writeFileSync(env.ACTA_POLICY,'\uFEFF'+JSON.stringify(examplePolicy));
  writeFileSync(env.ACTA_TOKEN_FILE,'\uFEFF'+JSON.stringify([token]));
  const {credentials}=loadConfig(env);
  assert.deepEqual(credentials(),[hash(token)]);
  writeFileSync(env.ACTA_TOKEN_FILE,'[]'); assert.deepEqual(credentials(),[]);
  writeFileSync(env.ACTA_TOKEN_FILE,'{'); assert.throws(credentials,{status:503});
});

test('bad tokens, policy or secret exit nonzero before creating storage or listening',t=>{
  const root=mkdtempSync(join(tmpdir(),'acta-bad-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const data=join(root,'uncreated'), token=randomUUID();
  const env={ACTA_DATA:data,ACTA_TOKEN_FILE:join(root,'tokens'),ACTA_POLICY:join(root,'policy'),ACTA_HMAC_KEY:token,ACTA_PORT:'0'};
  for(const [tokens,policy,key] of [
    ['not-json',examplePolicy,token],[[null],examplePolicy,token],[[],examplePolicy,token],
    [[token],{...examplePolicy,lengths:{}},token],[[token],examplePolicy,' ']
  ]){
    writeFileSync(env.ACTA_TOKEN_FILE,JSON.stringify(tokens));writeFileSync(env.ACTA_POLICY,JSON.stringify(policy));
    const child=spawnSync(process.execPath,['http/start.mjs'],{env:{...env,ACTA_HMAC_KEY:key},encoding:'utf8',timeout:3000});
    assert.equal(child.status,1);assert.match(child.stderr,/config\.invalid\./);
    assert.ok(!child.stderr.includes(token));assert.ok(!existsSync(data));
  }
});
