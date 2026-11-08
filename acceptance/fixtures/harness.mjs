import http from 'node:http';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync,readFileSync,writeFileSync,existsSync,readdirSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

export const spec={name:'合成角色',age:18,characters:['合成角色'],locations:['甲','乙'],phases:['早','晚']};
const key=()=>randomBytes(24).toString('hex');
export async function harness(t,cfg={}) {
  const root=mkdtempSync(join(tmpdir(),'acta-e2e-')), tokens=[key(),key()],hmacKey=key();
  const save=(name,data)=>writeFileSync(join(root,name),JSON.stringify(data),{mode:0o600});
  save('tokens.json',tokens);save('scenario.json',{});
  let enginePort,child;
  const daemon=[],access=[];
  async function stop() {
    if(!child)return;
    const exited=once(child,'exit');child.kill('SIGKILL');await exited;child=undefined;
  }
  async function restart(settings={}) {
    await stop();
    Object.assign(cfg,settings);save('config.json',cfg);
    child=fork(fileURLToPath(new URL('./service.mjs',import.meta.url)),[],{
      execArgv:[],silent:true,env:{PATH:process.env.PATH,TEST_ROOT:root,TEST_HMAC:hmacKey}
    });
    child.stdout.on('data',x=>daemon.push(x.toString()));
    child.stderr.on('data',x=>daemon.push(x.toString()));
    const current=child;
    const {port}=await new Promise((resolve,reject)=>{
      const onExit=()=>reject(Error('test service exited before ready'));
      current.once('exit',onExit);
      current.once('message',m=>{current.off('exit',onExit);resolve(m);});
    });
    enginePort=port;
  }
  // An independent listening HTTP reverse proxy. Replace the forwarded chain at this boundary.
  const proxy=http.createServer((req,res)=>{
    if(req.url.startsWith('/admin')){res.writeHead(404);res.end();access.push('edge 404');return;}
    const upstream=http.request({hostname:'127.0.0.1',port:enginePort,method:req.method,path:req.url,
      headers:{...req.headers,'x-forwarded-for':req.socket.remoteAddress}},incoming=>{
      res.writeHead(incoming.statusCode,incoming.headers);
      access.push('edge '+incoming.statusCode);incoming.pipe(res);
    });
    upstream.on('error',()=>res.destroy());req.pipe(upstream);
  });
  t.after(async()=>{await stop();proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));rmSync(root,{recursive:true,force:true});});
  await restart();proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
  const url='http://127.0.0.1:'+proxy.address().port;
  async function request(path,{body,token=tokens[0],headers={},direct=false}={}){
    const hh={...headers};
    if(token)hh.authorization='Bearer '+token;
    if(body!==undefined)hh['content-type']='application/json';
    const res=await fetch((direct?'http://127.0.0.1:'+enginePort:url)+path,{
      method:body===undefined?'GET':'POST',headers:hh,body:body===undefined?undefined:JSON.stringify(body)});
    const text=await res.text();let data;try{data=JSON.parse(text);}catch{}
    return {status:res.status,text,data,trace:res.headers.get('x-trace-id'),type:res.headers.get('content-type')};
  }
  const observations=()=>existsSync(join(root,'observe.jsonl'))?
    readFileSync(join(root,'observe.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  const logs=()=>readdirSync(join(root,'logs')).flatMap(f=>readFileSync(join(root,'logs',f),'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)));
  const build=async(token=tokens[0])=>{
    const r=await request('/v1/card/build',{token,body:{spec}});
    assert.equal(r.status,201,r.text);return r.data.card_revision;
  };
  const open=async(card,token=tokens[0])=>{
    const r=await request('/v1/sessions',{token,body:{card_revision:card}});
    assert.equal(r.status,201,r.text);return r.data.session_id;
  };
  const play=(session,rev,id,extra={},options={})=>request('/v1/chat/completions',{...options,body:{
    model:'engine',session_id:session,expected_rev:rev,turn_id:id,messages:[{role:'user',content:'合成输入'}],...extra}});
  return {root,url,tokens,hmacKey,logs,daemon,access,request,build,open,play,restart,stop,observations,
    scenario:data=>save('scenario.json',data),replaceTokens:value=>save('tokens.json',value)};
}
