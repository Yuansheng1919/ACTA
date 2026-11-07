import http from 'node:http';
import https from 'node:https';
import { Fault, reject } from './fault.mjs';

export function directConfig({endpoint,model,key,timeoutMs=480000}) {
  let url;
  try { url=new URL(endpoint); } catch { throw Error('config.invalid.direct_url'); }
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.username || url.password || url.hash || url.search ||
      !(url.protocol==='https:' || local && url.protocol==='http:'))throw Error('config.invalid.direct_url');
  if(typeof model!=='string' || !model.trim())throw Error('config.invalid.direct_model');
  if(typeof key!=='string' || !key.trim() || /[\r\n]/u.test(key))throw Error('config.invalid.direct_key');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0)throw Error('config.invalid.direct_timeout');
  return {url,model,key,timeoutMs};
}

function tokenCount(value) {return Number.isSafeInteger(value)&&value>=0?value:null;}

// One POST, one terminal response. Native http.request does not follow redirects or retry the POST.
export async function runDirect(config, task) {
  const {instruction,...data}=task;
  const payload=Buffer.from(JSON.stringify({model:config.model,stream:false,
    messages:[{role:'system',content:instruction},{role:'user',content:JSON.stringify(data)}]}));
  const transport=config.url.protocol==='https:'?https:http;
  let request,timer;
  let expired=false;
  try {
    const response=await new Promise((resolve,rejectRequest)=>{
      request=transport.request(config.url,{method:'POST',agent:false,headers:{
        authorization:'Bearer '+config.key,'content-type':'application/json','content-length':payload.length}},
        resolve);
      request.once('error',rejectRequest);
      timer=setTimeout(()=>{expired=true;request.destroy();},config.timeoutMs);
      request.end(payload);
    });
    if(response.statusCode!==200){
      const status=response.statusCode;
      response.destroy();
      if(status===408 || status===504)reject(504,'direct.timeout');
      reject(502,[400,403,451].includes(status)?'direct.rejected':'direct.upstream_error');
    }
    let bytes=0;const parts=[];
    for await(const part of response){
      bytes+=part.length;
      if(bytes>1024*1024){response.destroy();reject(502,'direct.response_size');}
      parts.push(part);
    }
    let result;
    try {result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));}
    catch {reject(502,'direct.protocol');}
    const choice=result?.choices?.[0],message=choice?.message;
    const usage={input_tokens:tokenCount(result?.usage?.prompt_tokens),output_tokens:tokenCount(result?.usage?.completion_tokens)};
    if(message?.refusal || choice?.finish_reason==='content_filter')reject(502,'direct.refused',usage);
    if(choice?.finish_reason!=='stop'||message?.tool_calls||message?.function_call||
       message?.role!=='assistant'||typeof message.content!=='string'||!message.content.trim())
      reject(502,'direct.protocol',usage);
    return {text:message.content,usage};
  } catch(e) {
    if(expired)reject(504,'direct.timeout');
    if(e instanceof Fault)throw e;
    reject(502,'direct.transport');
  } finally {clearTimeout(timer);request?.destroy();}
}
