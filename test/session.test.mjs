import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage,hash } from '../store/commit.mjs';
import { Sessions } from '../engine/session.mjs';
import { guardVersion,schemaVersion } from '../engine/guard.mjs';

test('M1-04 atomic replay persists, orphan in flight is distinguishable',async t=>{
  const root=mkdtempSync(join(tmpdir(),'acta-commit-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const store=new Storage(root),sessions=new Sessions(store),owner=hash('fixture');
  const card=store.create('cards',owner,{guard:guardVersion,schema:schemaVersion,spec:{locations:['甲','乙'],phases:['早','晚']}});
  const {session_id}=sessions.open(owner,card);
  const args={owner,sessionId:session_id,turnId:'one',expectedRev:0,input:{a:1}};
  let calls=0;
  const gen=async({mark})=>{mark();calls++;return {reply:{id:'stable'},state:{location:'乙',phase:'早'}};};
  const [a,b]=await Promise.all([sessions.run(args,gen),sessions.run(args,gen)]);
  assert.deepEqual(a,b);assert.equal(a.state_rev,1);assert.equal(calls,1);
  const restarted=new Sessions(new Storage(root));
  assert.deepEqual(await restarted.run(args,gen),a);assert.equal(calls,1);
  await assert.rejects(restarted.run({...args,input:{a:2}},gen),{status:409});
  const s=store.owned('sessions',session_id,owner);s.pending={key:hash('two')};store.put('sessions',session_id,s);
  await assert.rejects(restarted.run({...args,turnId:'two',expectedRev:1},gen),{code:'turn.unconfirmed'});
});
