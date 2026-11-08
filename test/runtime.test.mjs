import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { runHost } from '../engine/host.mjs';

test('host rejects duplicate numeric sequences even when padding differs',async t=>{
  const root=mkdtempSync(join(tmpdir(),'acta-seq-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const entry=join(root,'host.mjs');
  writeFileSync(entry,`import fs from 'node:fs'; for await(const data of process.stdin){}
    fs.mkdirSync('out');for(const n of ['02','2'])fs.writeFileSync('out/part-'+n+'.md','合成');`);
  await assert.rejects(runHost({root,entry},'test'),{code:'host.invalid_artifact'});
});

test('normal start entry builds and plays through the configured artifact host',async t=>{
  const root=mkdtempSync(join(tmpdir(),'acta-start-'));
  const token=randomBytes(24).toString('hex'),file=join(root,'tokens.json');
  writeFileSync(file,JSON.stringify([token]),{mode:0o600});
  const service=fileURLToPath(new URL('../http/start.mjs',import.meta.url));
  const fixture=fileURLToPath(new URL('../acceptance/fixtures/scenario-host.mjs',import.meta.url));
  const child=fork(service,[],{silent:true,execArgv:[],env:{PATH:process.env.PATH,
    ACTA_DATA:root,ACTA_TOKEN_FILE:file,ACTA_HMAC_KEY:randomBytes(32).toString('hex'),ACTA_HOST_ENTRY:fixture,ACTA_PORT:'0'}});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const stop=once(child,'exit');child.kill();await stop;}rmSync(root,{recursive:true,force:true});});
  const port=await new Promise((resolve,reject)=>{
    child.once('exit',()=>reject(Error('start failed')));child.once('message',m=>resolve(m.port));
  });
  const post=async(path,data)=>{
    const res=await fetch('http://127.0.0.1:'+port+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(data)});
    assert.ok(res.ok,'HTTP '+res.status);return res.json();
  };
  const built=await post('/v1/card/build',{spec:{name:'合成角色',age:18,locations:['甲'],phases:['早']}});
  const session=await post('/v1/sessions',{card_revision:built.card_revision});
  const play=await post('/v1/chat/completions',{model:'engine',session_id:session.session_id,
    expected_rev:0,turn_id:'one',messages:[{role:'user',content:'合成输入'}]});
  assert.equal(play.choices[0].message.content.length,1200);assert.equal(play.state_rev,1);
});
