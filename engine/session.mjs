import { hash, canonical } from '../store/commit.mjs';
import { guardVersion, schemaVersion, initial } from './guard.mjs';
import { Fault, reject } from './fault.mjs';

const day = 86400000;
const replayMax = 64;
export function assertVersion(card) {
  if(card.guard !== guardVersion || card.schema !== schemaVersion) reject(409,'card.unsupported_version');
}

export class Sessions {
  constructor(storage) { this.storage = storage; this.active = new Map(); }
  open(owner,cardId) {
    const card=this.storage.owned('cards',cardId,owner);
    assertVersion(card);
    const state=initial(card.spec);
    const id=this.storage.create('sessions',owner,{card_revision:cardId,state,rev:0,pending:null,history:[]});
    return {session_id:id,state_rev:0,state};
  }
  read(owner,id) {
    const s=this.storage.owned('sessions',id,owner);
    return {session_id:id,state_rev:s.rev,state:s.state,card_revision:s.card_revision};
  }
  async run({owner,sessionId,turnId,expectedRev,input}, generate) {
    if (typeof turnId!=='string' || !turnId.length || turnId.length>128 ||
        !Number.isSafeInteger(expectedRev) || expectedRev<0) reject(400,'turn.arguments');
    const s=this.storage.owned('sessions',sessionId,owner);
    const card=this.storage.owned('cards',s.card_revision,owner);
    assertVersion(card);
    const key=hash(turnId), fingerprint=hash(JSON.stringify(canonical({expectedRev,input})));
    const previous=s.history.find(r=>r.key===key);
    if(previous) {
      if(previous.fingerprint!==fingerprint || Date.now()-previous.ts>=day) reject(409,'turn.conflict');
      if(previous.failure) reject(previous.failure.status,previous.failure.code,previous.failure.metrics);
      return previous.reply;
    }
    const busy=this.active.get(sessionId);
    if(busy) {
      if(busy.key===key && busy.fingerprint===fingerprint) return busy.promise;
      reject(409,'turn.busy');
    }
    if(s.rev!==expectedRev) reject(409,'turn.stale');
    if(s.pending?.key===key) reject(409,'turn.unconfirmed');
    const save=()=>this.storage.put('sessions',sessionId,s);
    const remember=(entry)=>{
      s.history.push({key,fingerprint,ts:Date.now(),...entry});
      s.history=s.history.filter(r=>Date.now()-r.ts<day).slice(-replayMax);
      s.pending=null;
      save();
    };
    // The synchronous callback marks the turn only after admission and before dispatch.
    let dispatched=false;
    const mark=()=>{
      if(s.pending) s.history.push({...s.pending,ts:Date.now(),
        failure:{status:409,code:'turn.unconfirmed',metrics:{}}});
      s.pending={key,fingerprint};save();dispatched=true;
    };
    const promise=Promise.resolve().then(async()=>{
      let result;
      try { result=await generate({card,state:s.state,rev:s.rev,mark}); }
      catch(e) {
        if(dispatched && e instanceof Fault) remember({failure:{status:e.status,code:e.code,metrics:e.metrics}});
        throw e;
      }
      s.state=result.state;
      s.rev++;
      const reply={...result.reply,state:s.state,state_rev:s.rev};
      remember({reply});
      return reply;
    });
    this.active.set(sessionId,{key,fingerprint,promise});
    try { return await promise; }
    finally { this.active.delete(sessionId); }
  }
}
