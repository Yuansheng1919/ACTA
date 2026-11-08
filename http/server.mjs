import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readdirSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { publishCard,downloads,download } from '../store/card-assets.mjs';
import { Storage } from '../store/commit.mjs';
import { normalizeImport, importBytes } from '../engine/import.mjs';
import { activeLore } from '../engine/import-world.mjs';
import { Sessions } from '../engine/session.mjs';
import { checkSpec,checkSections,checkProse,parseArtifact,examplePolicy,object } from '../engine/gates.mjs';
import { guardVersion,schemaVersion,settle } from '../engine/guard.mjs';
import { runDirect } from '../engine/direct.mjs';
import { runHost } from '../engine/host.mjs';
import { Fault,reject } from '../engine/fault.mjs';
import { Admission } from './admission.mjs';
import { auditLog } from '../log/audit.mjs';

async function body(req,limit=256*1024) {
  let bytes=0;
  const parts=[];
  for await(const part of req) {
    bytes+=part.length;
    if(bytes>limit)reject(413,'request.size');
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
  const {root,host,direct,policy=examplePolicy,guard=settle,afterCommit}=options;
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
    const counters=()=>({attempts:sent,upstream_calls:direct||!sent?sent:null,
      tool_roundtrips:direct||!sent?0:null,host_invocations:direct?0:sent});
    res.setHeader('x-trace-id',trace);
    const route=(req.url??'').split('?')[0];
    async function attempt(kind,task,check) {
      const start=Date.now();
      const text=JSON.stringify(task);
      if([...text].length>20000)reject(413,'context.size');
      sent++;
      const attemptFields={...fields,attempt:sent,...counters(),runner:direct?'direct':'host',model:direct?'configured-direct':'configured-profile',queue_ms:0,
        input_tokens:null,output_tokens:null};
      let verdict='ok',metrics={};
      try {
        stage=direct?'direct':'host';
        audit.write('job_dispatch',{...attemptFields,outcome:'unknown'});
        const raw=direct?await runDirect(direct,task):await runHost({...host,root:jobs},text);
        Object.assign(attemptFields,raw.usage);
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
        const parts=route.slice('/v1/card/'.length).split('/');
        const card=storage.owned('cards',parts[0],owner);
        if(parts.length!==1){
          const kind=parts[1];
          if(parts.length!==2 || !Object.hasOwn(downloads,kind))reject(404,'route.missing');
          const payload=download(storage,card,kind);
          res.writeHead(200,{'content-type':downloads[kind][1],'cache-control':'private, no-store',
            'content-disposition':'attachment; filename="'+downloads[kind][0]+'"','content-length':payload.length});
          return res.end(payload);
        }
        return json(res,200,{card:{id:card.id,spec:card.spec,texts:card.texts,guard:card.guard,schema:card.schema}});
      }
      if(req.method==='GET' && route.startsWith('/v1/sessions/'))
        return json(res,200,sessions.read(owner,route.slice('/v1/sessions/'.length)));
      if(req.method!=='POST'||!['/v1/card/build','/v1/card/import','/v1/sessions','/v1/chat/completions'].includes(route))
        reject(404,'route.missing');
      stage='input';
      const b=await body(req,route==='/v1/card/import'?12*1024*1024:undefined);
      if(route==='/v1/card/import'){
        const base=b.base_revision?storage.owned('cards',b.base_revision,owner):null;
        const {card,extensions,report}=normalizeImport(importBytes(b.file),b,policy,base);
        if(b.dry_run!==undefined && typeof b.dry_run!=='boolean')reject(400,'import.dry_run');
        if(b.dry_run)return json(res,200,{...report,extensions,preview:{spec:card.spec,texts:card.texts,world:card.world}});
        if(!report.publishable)return json(res,422,{error:{code:'import.review_required',trace},...report,extensions});
        const publication=publishCard(storage,owner,{...card,extensions,guard:guardVersion,schema:schemaVersion});
        audit.write('import_finish',{...fields,card_revision:publication.card_revision,container:report.kind,dual:report.dual,
          changes:report.diff.length,registered:extensions.length,attempts:0,ms:Date.now()-began});
        return json(res,201,{...publication,...report,extensions});
      }
      if(route==='/v1/sessions')return json(res,201,sessions.open(owner,b.card_revision));
      if(route==='/v1/card/build') {
        const spec=checkSpec(b.spec,policy);
        const task={kind:'draft',instruction:'按规格写五段文案，返回对应字段组成的 JSON 对象。',spec,limits:policy.lengths};
        if([...JSON.stringify(task)].length>19800)reject(413,'context.size');
        const check=data=>checkSections(data,policy);
        const result=await admit.job(owner,async()=>{
          try{return await attempt('draft',task,check);}
          catch(e) {
            if(direct || !['card.section_length','card.missing_section'].includes(e.code))throw e;
            return attempt('draft',{...task,correct:{rule:e.code,field:e.metrics.path}},check);
          }
        });
        stage='commit';
        const publication=publishCard(storage,owner,{spec,texts:result.texts,guard:guardVersion,schema:schemaVersion});
        fields.card_revision=publication.card_revision;
        audit.write('job_finish',{...fields,verdict:'ok',ms:Date.now()-began,...counters()});
        return json(res,201,{...publication,checks:{ok:true,warn:result.warn},engine:guardVersion});
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
          spec:card.spec,texts:card.texts,state,history:b.messages,world:activeLore(card.world,b.messages.at(-1).content)};
        if([...JSON.stringify(task)].length>20000)reject(413,'context.size');
        return admit.job(owner,async()=>{
          mark();
          const result=await attempt('play',task,data=>{
            const checked=checkProse(data.text,policy);
            const next=guard(state,Object.hasOwn(data,'events')?data.events:[],card.spec,details=>{
              audit.write('guard_turn',{...fields,guard_round:rev+1,...details});
            });
            return {...checked,text:data.text,state:next};
          });
          stage='commit';
          return {state:result.state,reply:{completion:{id:'chatcmpl-'+trace,created:Math.floor(Date.now()/1000),
            object:'chat.completion',model:b.model,choices:[{index:0,message:{role:'assistant',content:result.text},finish_reason:'stop'}]}}};
        });
      });
      fields.rev_after=reply.state_rev;
      fields.original_job=reply.completion.id.slice('chatcmpl-'.length);
      audit.write('job_finish',{...fields,...counters(),verdict:'ok',ms:Date.now()-began,
        ...audit.proof(reply.completion.choices[0].message.content)});
      if(afterCommit)await afterCommit({res,trace});
      if(!res.destroyed)deliver(res,reply,b.stream===true);
    } catch(e) {
      const known=e instanceof Fault;
      const status=known?e.status:500,code=known?e.code:'internal';
      if(fields.rev_before!==undefined && known)fields.rev_after=fields.rev_before;
      audit.write('job_failed',{...fields,stage,verdict:code,...(known?e.metrics:{}),...counters(),ms:Date.now()-began});
      if(!res.destroyed&&!res.headersSent)json(res,status,{error:{code,trace},...(known?e.importDetails:{})});
    }
  });
}
