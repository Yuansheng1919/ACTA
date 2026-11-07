import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,readdirSync,existsSync,writeFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { harness } from '../acceptance/fixtures/harness.mjs';
const samples=resolve(process.env.ACTA_ACCEPTANCE_DIR??'acceptance','samples');
const present=existsSync(samples);
const rounds=[
  [{location:'甲',phase:'早'},{op:'move',value:'乙'},{location:'乙',phase:'早'}],
  [{location:'乙',phase:'早'},{op:'phase',value:'晚'},{location:'乙',phase:'晚'}],
  [{location:'乙',phase:'晚'},{op:'move',value:'甲'},{location:'甲',phase:'晚'}]
];
test('owner A image: hand-written main chain, N-1 through N-7 and independent sessions',{skip:!present},async t=>{
  const h=await harness(t);
  const image=readFileSync(join(samples,readdirSync(samples).find(f=>f.startsWith('A-')&&f.endsWith('.png'))));
  const r=await h.request('/v1/card/import',{body:{file:image.toString('base64'),overrides:{age:24,locations:['甲','乙'],phases:['早','晚']}}});
  assert.equal(r.status,201);const card=r.data.card_revision,s=await h.open(card),b=await h.open(card);
  const read=async id=>(await h.request('/v1/sessions/'+id)).data;
  for(const [i,[before,event,after]] of rounds.entries()){
    h.scenario({events:[event]});const n=h.observations().length;
    const reply=await h.play(s,i,'main-'+i);
    assert.equal(reply.data.state_rev,i+1);assert.deepEqual(reply.data.state,after);
    assert.equal(h.observations().length,n+1);assert.deepEqual(h.observations().at(-1).rev_input_state,before);
    t.diagnostic(JSON.stringify({session_id:s,turn_id:'main-'+i,expected_rev:i,state_rev:i+1,assembled:before,state:after,calls:1}));
  }
  assert.equal((await read(b)).state_rev,0);assert.deepEqual((await read(b)).state,rounds[0][0]);
  const count=h.observations().length;await h.restart();
  assert.equal((await read(s)).state_rev,3);assert.equal((await h.play(s,2,'main-2')).data.state_rev,3);
  assert.equal(h.observations().length,count);
  h.scenario({events:[{op:'move',value:'丙'}]});
  const bad=await h.play(s,3,'N-1',{stream:true});
  assert.equal(bad.status,422);assert.deepEqual((await read(s)).state,rounds[2][2]);assert.equal((await read(s)).state_rev,3);
  assert.ok(!bad.text.includes('data:'));assert.ok(h.logs().some(x=>x.trace===bad.trace&&x.event_index===0));
  h.scenario({delay:50});const n=h.observations().length;
  const [one,two]=await Promise.all([h.play(b,0,'N-2'),h.play(b,0,'N-2')]);
  assert.deepEqual(one.data,two.data);assert.equal(h.observations().length,n+1);
  assert.equal((await h.play(b,0,'N-2',{messages:[{role:'user',content:'变更'}]})).status,409);
  assert.equal((await h.play(b,0,'N-4')).status,409);assert.equal((await read(b)).state_rev,1);
  assert.equal(h.observations().length,n+1);
  writeFileSync(join(h.root,'drop-once'),'');await assert.rejects(h.play(b,1,'N-5'));
  const orig=(await read(b)).state_rev;await h.restart();
  assert.equal((await h.play(b,1,'N-5')).data.state_rev,orig);assert.equal(h.observations().length,n+2);
  h.scenario({refuse:true});const refused=await h.play(b,2,'N-6');
  assert.equal(refused.data.error.code,'host.refused');assert.equal((await read(b)).state_rev,2);
  assert.equal(h.logs().filter(x=>x.trace===refused.trace&&x.event==='job_dispatch'&&x.outcome==='unknown').length,1);
  const attempt=h.logs().filter(x=>x.trace===refused.trace&&x.event==='job_attempt');
  assert.equal(attempt.length,1);assert.equal(attempt[0].verdict,'host.refused');assert.equal(attempt[0].output_tokens,null);
  h.scenario({events:[{op:'move',value:'乙'}]});
  const concurrent=await Promise.all([h.play(s,3,'isolated-a'),h.play(b,2,'isolated-b')]);
  assert.deepEqual(concurrent.map(x=>x.data.state_rev),[4,3]);
  await h.restart({noop:true});const mutant=await h.open(card);
  for(const [i,[,event,expected]] of rounds.entries()){
    h.scenario({events:[event]});const reply=await h.play(mutant,i,'N-7-'+i);
    assert.equal(reply.status,200);assert.notDeepEqual(reply.data.state,expected);
    t.diagnostic('N-7 row '+(i+1)+' mismatch: '+JSON.stringify({expected,actual:reply.data.state}));
  }
});
