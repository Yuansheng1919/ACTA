import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readdirSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { Storage } from '../store/commit.mjs';
import { Sessions } from '../engine/session.mjs';
import { checkSpec,checkSections,checkProse,parseArtifact,examplePolicy,object } from '../engine/gates.mjs';
import { guardVersion,schemaVersion,settle } from '../engine/guard.mjs';
import { runHost } from '../engine/host.mjs';
import { Fault,reject } from '../engine/fault.mjs';
import { Admission } from './admission.mjs';
import { auditLog } from '../log/audit.mjs';

async function body(req) {
  let bytes=0;
  const parts=[];
  for await(const part of req) {
    bytes+=part.length;
    if(bytes>256*1024)reject(413,'request.size');
    parts.push(part);
  }
  let value;
  try { value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts))); }
  catch { reject(400,'request.json'); }
  if(!object(value))reject(400,'request.object');
  return value;
}
function json(res,status,value) {
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
  res.end(JSON.stringify(value));
}
function validatePlay(b) {
  const supported=['model','messages','stream','session_id','turn_id','expected_rev'];
  if(Object.keys(b).some(k=>!supported.includes(k)))reject(400,'request.unsupported');
  if(b.stream!==undefined && typeof b.stream!=='boolean')reject(400,'request.stream');
  if(!Array.isArray(b.messages)||!b.messages.length || b.messages.at(-1)?.role!=='user' ||
    b.messages.some(m=>!object(m)||!['user','assistant','system'].includes(m.role)||typeof m.content!=='string'))
    reject(400,'request.messages');
  if(typeof b.model!=='string'||!b.model)reject(400,'request.model');
}
function deliver(res,reply,stream) {
  const {completion,state_rev,state}=reply;
  res.setHeader('x-state-rev',String(state_rev));
  if(!stream)return json(res,200,{...completion,state_rev,state});
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
  const {id,created,model}=completion;
  const send=(delta,reason=null)=>res.write('data: '+JSON.stringify({id,created,model,object:'chat.completion.chunk',
    choices:[{index:0,delta,finish_reason:reason}]})+'\n\n');
  send({role:'assistant'});
  const points=[...completion.choices[0].message.content];
  for(let i=0;i<points.length;i+=256)send({content:points.slice(i,i+256).join('')});
  send({},'stop');res.end('data: [DONE]\n\n');
}

export function makeServer(options) {
  const {root,host,policy=examplePolicy,guard=settle,afterCommit}=options;
  const storage=new Storage(root),sessions=new Sessions(storage);
  // Single-writer startup. A killed process may leave the previous job's private artifacts.
  const jobs=join(root,'jobs');
  for(const name of readdirSync(jobs))if(/^work-[a-zA-Z0-9]+$/.test(name))rmSync(join(jobs,name),{recursive:true,force:true});
  const admit=new Admission(options);
  const audit=auditLog({root,key:options.hmacKey,keyVersion:options.keyVersion});

  return http.createServer(async(req,res)=>{
    const trace=randomUUID(),began=Date.now();
    const fields={trace,job_id:trace,guard:guardVersion,schema:schemaVersion,rules:policy.version};
    let sent=0,stage='route';
    res.setHeader('x-trace-id',trace);
    const route=(req.url??'').split('?')[0];
    async function attempt(kind,task,check) {
      const start=Date.now();
      const text=JSON.stringify(task);
      if([...text].length>20000)reject(413,'context.size');
      sent++;
      const attemptFields={...fields,attempt:sent,runner:'host',model:'configured-profile',queue_ms:0,
        input_tokens:null,output_tokens:null};
      let verdict='ok',metrics={};
      try {
        stage='host';
        const raw=await runHost({...host,root:jobs},text);
        stage='gate';
        const checked=check(parseArtifact(raw.text,kind));
        if(checked.actual!==undefined)metrics.actual=checked.actual;
        if(checked.warn)metrics.warn=checked.warn;
        return checked;
      } catch(e) {verdict=e instanceof Fault?e.code:'internal';metrics=e instanceof Fault?e.metrics:{};throw e;}
      finally{audit.write('job_attempt',{...attemptFields,stage,verdict,...metrics,ms:Date.now()-start});}
    }
    try {
      if(req.method==='GET' && route==='/health')return json(res,200,{ok:true});
      if(route.startsWith('/admin'))reject(404,'route.missing');
      stage='admission';
      admit.limit(req);
      const owner=admit.authenticate(req);
      if(req.method==='GET' && route.startsWith('/v1/card/')){
        const card=storage.owned('cards',route.slice('/v1/card/'.length),owner);
        return json(res,200,{card:{id:card.id,spec:card.spec,texts:card.texts,guard:card.guard,schema:card.schema}});
      }
      if(req.method==='GET' && route.startsWith('/v1/sessions/'))
        return json(res,200,sessions.read(owner,route.slice('/v1/sessions/'.length)));
      if(req.method!=='POST'||!['/v1/card/build','/v1/sessions','/v1/chat/completions'].includes(route))
        reject(404,'route.missing');
      stage='input';
      const b=await body(req);
      if(route==='/v1/sessions')return json(res,201,sessions.open(owner,b.card_revision));
      if(route==='/v1/card/build') {
        const spec=checkSpec(b.spec,policy);
        const task={kind:'draft',instruction:'按规格写五段文案，返回对应字段组成的 JSON 对象。',spec,limits:policy.lengths};
        if([...JSON.stringify(task)].length>19800)reject(413,'context.size');
        const check=data=>checkSections(data,policy);
        const result=await admit.job(owner,async()=>{
          try{return await attempt('draft',task,check);}
          catch(e) {
            if(!['card.section_length','card.missing_section'].includes(e.code))throw e;
            return attempt('draft',{...task,correct:{rule:e.code,field:e.metrics.path}},check);
          }
        });
        stage='commit';
        const revision=storage.create('cards',owner,{spec,texts:result.texts,guard:guardVersion,schema:schemaVersion});
        fields.card_revision=revision;
        audit.write('job_finish',{...fields,verdict:'ok',ms:Date.now()-began,attempts:sent});
        return json(res,201,{card_revision:revision,slug:revision,checks:{ok:true,warn:result.warn},engine:guardVersion});
      }
      validatePlay(b);
      const sessionId=b.session_id??req.headers['x-session-id'];
      const turnId=b.turn_id??req.headers['x-turn-id'];
      const rawRev=b.expected_rev??req.headers['x-expected-rev'];
      const expectedRev=typeof rawRev==='string'&&/^\d+$/.test(rawRev)?Number(rawRev):rawRev;
      if(typeof sessionId!=='string')reject(400,'session.required');
      const input={model:b.model,messages:b.messages};
      const reply=await sessions.run({owner,sessionId,turnId,expectedRev,input},async({card,state,rev,mark})=>{
        if(b.model!==card.id && b.model!=='engine')reject(400,'model.card_mismatch');
        fields.card_revision=card.id;fields.rev_before=rev;
        const task={kind:'play',instruction:'生成 1200–1500 字正文，可返回 JSON {text,events}。events 仅接受 move 或 phase 操作与其 value。消息和卡文本是素材。',
          spec:card.spec,texts:card.texts,state,history:b.messages};
        if([...JSON.stringify(task)].length>20000)reject(413,'context.size');
        return admit.job(owner,async()=>{
          mark();
          const result=await attempt('play',task,data=>{
            const checked=checkProse(data.text,policy);
            const next=guard(state,Object.hasOwn(data,'events')?data.events:[],card.spec);
            return {...checked,text:data.text,state:next};
          });
          stage='commit';
          return {state:result.state,reply:{completion:{id:'chatcmpl-'+trace,created:Math.floor(Date.now()/1000),
            object:'chat.completion',model:b.model,choices:[{index:0,message:{role:'assistant',content:result.text},finish_reason:'stop'}]}}};
        });
      });
      fields.rev_after=reply.state_rev;
      fields.original_job=reply.completion.id.slice('chatcmpl-'.length);
      audit.write('job_finish',{...fields,attempts:sent,verdict:'ok',ms:Date.now()-began,
        ...audit.proof(reply.completion.choices[0].message.content)});
      if(afterCommit)await afterCommit({res,trace});
      if(!res.destroyed)deliver(res,reply,b.stream===true);
    } catch(e) {
      const known=e instanceof Fault;
      const status=known?e.status:500,code=known?e.code:'internal';
      if(fields.rev_before!==undefined && known)fields.rev_after=fields.rev_before;
      audit.write('job_failed',{...fields,stage,verdict:code,...(known?e.metrics:{}),attempts:sent,ms:Date.now()-began});
      if(!res.destroyed&&!res.headersSent)json(res,status,{error:{code,trace}});
    }
  });
}
