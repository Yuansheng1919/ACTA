import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { directConfig,runDirect } from '../engine/direct.mjs';
import { harness } from '../acceptance/fixtures/harness.mjs';
import { sections } from '../engine/gates.mjs';

const envelope=(text,extra={})=>({choices:[{finish_reason:'stop',message:{role:'assistant',content:text,...extra}}],
  usage:{prompt_tokens:10,completion_tokens:5}});
async function upstream(t,fn){
  const calls=[];
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const b of req)body+=b;
    const payload=JSON.parse(body);
    calls.push({method:req.method,path:req.url,payload});
    await fn(res,payload,req);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
  return {calls,config:{endpoint:'http://127.0.0.1:'+server.address().port+'/v1/chat/completions',key:randomUUID(),model:'synthetic'}};
}
test('direct wire shape: one real POST, no tools, refusals/redirects/invalid output never switch runner',async t=>{
  let mode='ok';
  const fake=await upstream(t,(res,payload)=>{
    if(mode==='redirect'){res.writeHead(307,{location:'/second'});return res.end();}
    if(mode==='http-reject'){res.writeHead(403);return res.end('private diagnostic');}
    const data=JSON.parse(payload.messages[1].content);
    const text=data.kind==='draft'?JSON.stringify(Object.fromEntries(sections.map(k=>[k,mode==='short'?'短':'合成素材']))):
      JSON.stringify({text:'文'.repeat(1200),events:[]});
    const result=envelope(text,mode==='refuse'?{refusal:'private refusal'}:{});
    if(mode==='content_filter')result.choices[0].finish_reason='content_filter';
    res.end(JSON.stringify(result));
  });
  const h=await harness(t,{direct:fake.config});const card=await h.build(),s=await h.open(card);
  const ok=await h.play(s,0,'ok');assert.equal(ok.status,200);
  const repeat=await h.play(s,0,'ok');assert.deepEqual(repeat.data,ok.data);
  assert.equal(fake.calls.length,2);assert.equal(h.observations().length,0);
  for(const c of fake.calls){
    assert.equal(c.method,'POST');assert.equal(c.path,'/v1/chat/completions');
    assert.deepEqual(Object.keys(c.payload).sort(),['messages','model','stream']);
    assert.deepEqual(c.payload.messages.map(m=>m.role),['system','user']);assert.equal(c.payload.stream,false);
  }
  const log=h.logs().find(x=>x.trace===ok.trace&&x.event==='job_attempt');
  assert.deepEqual([log.upstream_calls,log.tool_roundtrips,log.host_invocations,log.input_tokens,log.output_tokens],[1,0,0,10,5]);
  assert.equal(h.logs().find(x=>x.trace===repeat.trace&&x.event==='job_finish').upstream_calls,0);
  for(const m of ['refuse','content_filter','http-reject','redirect']){
    mode=m;const before=fake.calls.length;
    const r=await h.play(s,1,m,{stream:true});
    assert.equal(r.status,502);assert.ok(!r.text.includes('private'));assert.equal(fake.calls.length-before,1);
    assert.equal((await h.request('/v1/sessions/'+s)).data.state_rev,1);
  }
  mode='short';const before=fake.calls.length;
  const draft=await h.request('/v1/card/build',{body:{spec:{name:'甲',age:18,locations:['甲'],phases:['早']}}});
  assert.equal(draft.status,422);assert.equal(fake.calls.length-before,1);assert.equal(h.observations().length,0);
});
test('wire has zero header/body bytes before the final direct-response fragment is gated',async t=>{
  let notify,release;
  const first=new Promise(r=>{notify=r;});const hold=new Promise(r=>{release=r;});
  t.after(()=>release());
  const fake=await upstream(t,async(res,payload)=>{
    const task=JSON.parse(payload.messages[1].content);
    if(task.kind==='draft')return res.end(JSON.stringify(envelope(JSON.stringify(Object.fromEntries(sections.map(k=>[k,'合成卡文']))))));
    const wire=JSON.stringify(envelope(JSON.stringify({text:'文'.repeat(1200)+'校服',events:[]})));
    res.write(wire.slice(0,-140));notify();await hold;res.end(wire.slice(-140));
  });
  const h=await harness(t,{direct:fake.config}),s=await h.open(await h.build());
  // Connect directly to the engine listener so proxy buffering cannot hide a leak.
  let responded=false,bytes=0;
  const pending=new Promise((resolve,reject)=>{
    const req=http.request(h.engineUrl()+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+h.tokens[0]}},res=>{
      responded=true;res.on('data',b=>{bytes+=b.length;});res.on('end',()=>resolve([res.statusCode,res.headers['content-type']]));
    });
    req.on('error',reject);req.end(JSON.stringify({model:'engine',session_id:s,turn_id:'late',expected_rev:0,stream:true,
      messages:[{role:'user',content:'合成'}]}));
  });
  await first;await delay(40);const early=[responded,bytes];release();
  const [status,type]=await pending;assert.deepEqual(early,[false,0]);assert.equal(status,422);assert.match(type,/json/);
});
test('deadline covers incomplete upstream body; no second POST',async t=>{
  const fake=await upstream(t,res=>{res.writeHead(200);res.write('{');});
  await assert.rejects(runDirect(directConfig({...fake.config,timeoutMs:150}),{instruction:'合成'}),{code:'direct.timeout'});
  assert.equal(fake.calls.length,1);
});
