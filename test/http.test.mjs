import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,createHmac } from 'node:crypto';
import { readFileSync,writeFileSync,readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { harness,spec } from '../acceptance/fixtures/harness.mjs';

test('M0-01 real proxy, health, revoked token and private resource ownership',async t=>{
  const h=await harness(t);
  const c=await h.build(),s=await h.open(c);
  assert.deepEqual((await h.request('/health',{token:null})).data,{ok:true});
  assert.equal((await h.request('/admin/jobs')).status,404);
  const before=h.observations().length;
  for(const token of [null,'invalid'])assert.equal((await h.request('/v1/card/build',{token,body:{spec}})).status,401);
  for(const path of ['/v1/card/'+c,'/v1/sessions/'+s])assert.equal((await h.request(path,{token:h.tokens[1]})).status,404);
  assert.equal((await h.play(s,0,'wrong',{}, {token:h.tokens[1]})).status,404);
  h.replaceTokens(h.tokens.slice(1));
  assert.equal((await h.play(s,0,'revoked')).status,401);
  assert.equal(h.observations().length,before);
  const b=await h.build(h.tokens[1]);assert.ok(b);assert.ok(h.access.includes('edge 201'));
});

test('M0-01 supplemental installed client SDK through the listening proxy',{skip:!process.env.ACTA_SDK_MODULE},async t=>{
  const {default:SDK}=await import(pathToFileURL(process.env.ACTA_SDK_MODULE).href);
  const h=await harness(t),s=await h.open(await h.build());
  const client=new SDK({apiKey:h.tokens[0],baseURL:h.url+'/v1',maxRetries:0});
  const reply=await client.chat.completions.create({model:'engine',messages:[{role:'user',content:'合成输入'}]},
    {headers:{'x-session-id':s,'x-expected-rev':'0','x-turn-id':'sdk'}});
  assert.equal(reply.choices[0].message.content.length,1200);
  assert.ok(h.access.includes('edge 200'));
});

test('M0-02 one remaining round, two simultaneous sessions, shared IP, restart and spoofing',async t=>{
  const h=await harness(t,{daily:2,trustedProxy:'127.0.0.1'});
  const c=await h.build(),a=await h.open(c),b=await h.open(c);
  h.scenario({delay:100});
  const pair=await Promise.all([h.play(a,0,'a'),h.play(b,0,'b')]);
  assert.deepEqual(pair.map(x=>x.status).sort(),[200,429]);
  assert.equal(h.observations().length,2);
  assert.ok(await h.build(h.tokens[1]));
  await h.restart();
  const r=await h.play(a,0,'new',{}, {headers:{'x-forwarded-for':'192.0.2.33'}});
  // One of the two sessions has advanced; use a new session to measure quota independently.
  const fresh=await h.open(c);
  assert.equal((await h.play(fresh,0,'after-restart')).data.error.code,'limit.daily');
  assert.ok([409,429].includes(r.status));
  await h.restart({ipBurst:1,trustedProxy:'192.0.2.8'});
  assert.equal((await h.request('/v1/card/'+c,{direct:true,headers:{'x-forwarded-for':'192.0.2.1'}})).status,200);
  assert.equal((await h.request('/v1/card/'+c,{direct:true,headers:{'x-forwarded-for':'192.0.2.2'}})).data.error.code,'limit.ip');
});

test('M0-03 withheld SSE, terminal lengths and refusal, one card repair at most',async t=>{
  const h=await harness(t),s=await h.open(await h.build());
  const probe='私有草稿探针';
  for(const [mode,code] of [[{suffix:probe+'校服'},'verdict.blocked'],[{refuse:true},'host.refused'],
    ...[1199,1501,1599,1600,1601].map(length=>[{length},'verdict.len_over'])]) {
    h.scenario(mode);
    const before=h.observations().length,r=await h.play(s,0,'attempt-'+before,{stream:true});
    assert.equal(r.data.error.code,code);assert.match(r.type,/application\/json/);
    assert.ok(!r.text.includes(probe)&&!r.text.includes('文')&&!r.text.includes('data:'));
    assert.equal(h.observations().length-before,1);
    assert.equal((await h.request('/v1/sessions/'+s)).data.state_rev,0);
    assert.equal(h.logs().filter(x=>x.trace===r.trace&&x.event==='job_attempt').length,1);
  }
  h.scenario({short:true});
  const repaired=await h.request('/v1/card/build',{body:{spec}});
  assert.equal(repaired.status,201);
  assert.deepEqual(h.logs().filter(x=>x.trace===repaired.trace&&x.event==='job_attempt').map(x=>x.attempt),[1,2]);
  t.diagnostic('M0-03 synthetic repair trace '+repaired.trace+' attempts=2');
  h.scenario({length:1500});
  const good=await h.play(s,0,'stream-ok',{stream:true});
  assert.match(good.type,/text\/event-stream/);assert.ok(good.text.endsWith('data: [DONE]\n\n'));
});

test('M0-04 input, accepted output, stdout/stderr and error probes do not escape diagnostic sinks',async t=>{
  const h=await harness(t),s=await h.open(await h.build());
  const probes=Array.from({length:4},()=>randomBytes(14).toString('hex'));
  const history={messages:[{role:'user',content:probes[0]}]};
  h.scenario({suffix:probes[1],stdoutProbe:probes[3]});
  const ok=await h.play(s,0,'ok',history);
  assert.equal(ok.status,200);assert.ok(ok.text.includes(probes[1]));
  h.scenario({refuse:true,errorProbe:probes[2],stdoutProbe:probes[3]});
  const bad=await h.play(s,1,'fail',history);
  assert.equal(bad.data.error.code,'host.refused');
  const logs=h.logs();
  const proof=logs.find(r=>r.trace===ok.trace&&r.event==='job_finish');
  const content=ok.data.choices[0].message.content;
  assert.equal(proof.hmac,createHmac('sha256',h.hmacKey).update(content.normalize('NFC')).digest('hex'));
  assert.ok(logs.some(r=>r.trace===bad.trace&&r.stage==='host'&&r.verdict==='host.refused'));
  const examined=JSON.stringify([logs,h.access,h.daemon,bad.text]);
  for(const secret of [...probes,...h.tokens,h.hmacKey,h.root])assert.ok(!examined.includes(secret));
  assert.deepEqual(readdirSync(join(h.root,'jobs')),[]);
  t.diagnostic('M0-04 synthetic trace '+ok.trace+' / '+bad.trace+'; private sink matches=0');
});

test('M1-01 input rejects before dispatch, five-stage failures never publish a partial card',async t=>{
  const h=await harness(t);
  for(const change of [{age:17},{age:18.5},{locations:['丙']},{phases:['午']},{phases:[]},{characters:['甲','乙']}])
    assert.equal((await h.request('/v1/card/build',{body:{spec:{...spec,...change}}})).status,422);
  assert.equal(h.observations().length,0);
  for(const mode of [{missing:true},{blank:true},{failField:true}]) {
    h.scenario(mode);const n=h.observations().length;
    assert.equal((await h.request('/v1/card/build',{body:{spec}})).status,422);
    assert.equal(h.observations().length-n,2);assert.deepEqual(readdirSync(join(h.root,'cards')),[]);
  }
  h.scenario({});assert.ok(await h.build());assert.equal(readdirSync(join(h.root,'cards')).length,1);
});

const rounds=[
  {event:{op:'move',value:'乙'},before:{location:'甲',phase:'早'},after:{location:'乙',phase:'早'}},
  {event:{op:'phase',value:'晚'},before:{location:'乙',phase:'早'},after:{location:'乙',phase:'晚'}},
  {event:{op:'move',value:'甲'},before:{location:'乙',phase:'晚'},after:{location:'甲',phase:'晚'}}
];
async function threeRounds(h,s) {
  for(const [i,r] of rounds.entries()){
    h.scenario({events:[r.event]});
    const reply=await h.play(s,i,'round-'+i);
    assert.equal(reply.status,200);assert.equal(reply.data.state_rev,i+1);
    assert.deepEqual(h.observations().at(-1).rev_input_state,r.before);
    assert.deepEqual(reply.data.state,r.after);
  }
}

test('M1-03 three hand-written states, actual next prompt, untouched second session, restart/replay',async t=>{
  const h=await harness(t),card=await h.build(),s=await h.open(card),other=await h.open(card);
  await threeRounds(h,s);
  const second=(await h.request('/v1/sessions/'+other)).data;
  assert.deepEqual(second.state,rounds[0].before);assert.equal(second.state_rev,0);
  await h.restart();
  const n=h.observations().length;
  const last=await h.play(s,2,'round-2');assert.equal(last.data.state_rev,3);
  assert.deepEqual(last.data.state,rounds[2].after);assert.equal(h.observations().length,n);
  h.scenario({events:[{op:'move',value:'丙'}]});
  const bad=await h.play(s,3,'bad');assert.equal(bad.data.error.code,'state.invalid_transition');
  assert.equal((await h.request('/v1/sessions/'+s)).data.state_rev,3);
  assert.ok(h.logs().some(row=>row.trace===bad.trace&&row.event_index===0));
  t.diagnostic('M1-03 synthetic trace '+last.trace+' final_rev=3; rejected_event_index=0');
});

test('M1-04 coalesces duplicates, arbitrates conflicts, replays post-commit disconnect and identifies in-doubt restart',async t=>{
  const h=await harness(t),s=await h.open(await h.build());h.scenario({delay:100});
  let before=h.observations().length;
  const [a,b]=await Promise.all([h.play(s,0,'one'),h.play(s,0,'one')]);
  assert.equal(a.status,200);assert.deepEqual(a.data,b.data);assert.equal(h.observations().length-before,1);
  assert.equal((await h.play(s,0,'one',{messages:[{role:'user',content:'异参'}]})).status,409);
  const pair=await Promise.all([h.play(s,1,'two'),h.play(s,1,'other')]);
  assert.deepEqual(pair.map(x=>x.status).sort(),[200,409]);
  before=h.observations().length;
  writeFileSync(join(h.root,'drop-once'),'');
  await assert.rejects(h.play(s,2,'lost'));
  await h.restart();
  const replay=await h.play(s,2,'lost');assert.equal(replay.data.state_rev,3);
  assert.equal(h.observations().length-before,1);
  h.scenario({delay:700});
  const waiting=h.play(s,3,'interrupted').catch(()=>null);
  for(let i=0;i<100 && h.observations().length<before+2;i++)await delay(10);
  assert.equal(h.observations().length,before+2);
  await h.restart();await waiting;
  assert.equal((await h.play(s,3,'interrupted')).data.error.code,'turn.unconfirmed');
  assert.equal((await h.request('/v1/sessions/'+s)).data.state_rev,3);
  assert.equal(h.observations().length,before+2);
});

test('M1-05 no-op mutation breaks three-round assertion; invalid transitions and unknown versions cannot publish',async t=>{
  const h=await harness(t,{noop:true}),card=await h.build(),s=await h.open(card);
  await assert.rejects(threeRounds(h,s),e=>e.code==='ERR_ASSERTION'&&e.actual?.location==='甲'&&e.expected?.location==='乙');
  await h.restart({noop:false});
  for(const [i,event] of [{op:'write_private',value:'乙'},{op:'phase',value:'午'},{op:'move',value:42}].entries()){
    h.scenario({events:[event]});
    const r=await h.play(s,1,'invalid'+i,{stream:true});
    assert.equal(r.status,422);assert.ok(!r.text.includes('data:'));
    assert.equal((await h.request('/v1/sessions/'+s)).data.state_rev,1);
  }
  const path=join(h.root,'cards',card+'.json');const record=JSON.parse(readFileSync(path));
  record.guard='retired';writeFileSync(path,JSON.stringify(record));
  const n=h.observations().length;
  assert.equal((await h.play(s,1,'old')).data.error.code,'card.unsupported_version');
  assert.equal((await h.request('/v1/sessions',{body:{card_revision:card}})).status,409);
  assert.equal(h.observations().length,n);
});
