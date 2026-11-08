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
// The same three assertions run against the real guard and its no-op replacement.
async function runRows(h,session,prefix) {
  const results=[],inputs=[],applied=[];
  for(const [i,[,event]] of rounds.entries()){
    h.scenario({events:[event]});
    const reply=await h.play(session,i,prefix+i);
    results.push(reply);inputs.push(h.observations().at(-1).rev_input_state);
    applied.push(h.logs().filter(log=>log.event==='guard_turn' &&
      results.some(result=>result.trace===log.trace)).length);
  }
  const calls=h.observations().length;
  const engineCalls=h.logs().filter(log=>log.event==='job_attempt').length;
  await h.restart();
  const restored=(await h.request('/v1/sessions/'+session)).data;
  const replay=await h.play(session,2,prefix+2);
  const replayLog=h.logs().find(log=>log.trace===replay.trace&&log.event==='job_finish');
  return {results,inputs,applied,restored,replay,replayLog,calls,
    callsAfterReplay:h.observations().length,engineCalls,
    engineCallsAfterReplay:h.logs().filter(log=>log.event==='job_attempt').length};
}
function assertRow(h,chain,i) {
  const expected=rounds[i][2],response=chain.results[i];
  assert.equal(response.status,200);
  assert.deepEqual(response.data.state,expected,'row '+(i+1)+' settled state');
  assert.equal(response.data.state_rev,i+1);
  if(i<2)assert.deepEqual(chain.inputs[i+1],expected,'next host input');
  else {
    assert.equal(chain.restored.state_rev,3);
    assert.deepEqual(chain.restored.state,expected);
    assert.deepEqual(chain.replay.data,chain.results[2].data);
    assert.equal(chain.replayLog.upstream_calls,0);
    assert.equal(chain.callsAfterReplay,chain.calls);
    assert.equal(chain.engineCallsAfterReplay,chain.engineCalls);
  }
  const traces=h.logs().filter(log=>log.trace===response.trace&&log.event==='guard_turn');
  assert.equal(traces.length,1,'exactly one completed guard turn');
  assert.equal(traces[0].guard_round,i+1);
  assert.equal(chain.applied[i],i+1,'guard turn counter increments exactly once');
  if(i===1)assert.equal(traces[0].phase_forward,true,'legal forward phase transition');
}
test('owner A image: hand-written main chain, N-1 through N-7 and independent sessions',{skip:!present},async t=>{
  const h=await harness(t);
  const image=readFileSync(join(samples,readdirSync(samples).find(f=>f.startsWith('A-')&&f.endsWith('.png'))));
  const r=await h.request('/v1/card/import',{body:{file:image.toString('base64'),overrides:{age:24,locations:['甲','乙'],phases:['早','晚']}}});
  assert.equal(r.status,201);const card=r.data.card_revision,s=await h.open(card),b=await h.open(card);
  const read=async id=>(await h.request('/v1/sessions/'+id)).data;
  const normal=await runRows(h,s,'main-');
  for(let i=0;i<3;i++){
    assertRow(h,normal,i);
    assert.deepEqual(normal.inputs[i],rounds[i][0]);
    t.diagnostic(JSON.stringify({row:i+1,rev:normal.results[i].data.state_rev,
      next_state:normal.results[i].data.state,guard_round:normal.applied[i]}));
  }
  assert.equal((await read(b)).state_rev,0);assert.deepEqual((await read(b)).state,rounds[0][0]);
  h.scenario({events:[{op:'move',value:'丙'}]});
  const bad=await h.play(s,3,'N-1',{stream:true});
  assert.equal(bad.status,422);assert.deepEqual((await read(s)).state,rounds[2][2]);assert.equal((await read(s)).state_rev,3);
  assert.match(bad.type,/^application\/json/);
  assert.equal(bad.data.error.code,'state.invalid_transition');
  assert.equal(bad.text.split('\n').filter(line=>line.startsWith('data:')).length,0);
  assert.ok(!bad.text.includes('文'));assert.ok(h.logs().some(x=>x.trace===bad.trace&&x.event_index===0));
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
  const mutation=await runRows(h,mutant,'N-7-');
  const failures=[];
  for(let i=0;i<3;i++){
    assert.throws(()=>assertRow(h,mutation,i),error=>{
      assert.equal(error.code,'ERR_ASSERTION');
      failures.push(i);
      t.diagnostic('N-7 row '+(i+1)+' failed: '+error.message.split('\n')[0]);
      return true;
    });
    assert.deepEqual(mutation.results[i].data.state,{location:'甲',phase:'早'});
  }
  assert.deepEqual(failures,[0,1,2],'all three normal acceptance rows must reject the no-op guard');
  assert.equal(mutation.applied[0],0,'no-op guard produces no engine application trace');
  t.diagnostic('N-7：第一轮就偏离；三行全部失败（3/3）');
});
