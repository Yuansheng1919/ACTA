import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSpec, checkSections, checkProse, count, examplePolicy as p, sections } from '../engine/gates.mjs';
import { settle } from '../engine/guard.mjs';
const spec = { name:'合成', age:18, locations:['甲','乙'], phases:['早','晚'] };

test('M1-01 NFC Unicode code points and all five field boundaries', () => {
  assert.equal(count('e\u0301 \n𠮷。'),3);
  const texts = Object.fromEntries(sections.map(k=>[k,'文'.repeat(p.lengths[k][0])]));
  for (const key of sections) {
    const [min,max] = p.lengths[key];
    for(const n of [min-1,min,min+1,max-1,max,max+1]) {
      const check=()=>checkSections({...texts,[key]:'文'.repeat(n)},p);
      if(n<min||n>max) assert.throws(check,{code:'card.section_length'}); else check();
    }
    for(const bad of [null,undefined,' \t']) assert.throws(()=>checkSections({...texts,[key]:bad},p),{code:'card.missing_section'});
  }
  checkSpec(spec,p);
  for(const change of [{age:17},{age:18.5},{phases:[]},{locations:['丙']},{characters:['甲','乙']},{notes:'校服'}])
    assert.throws(()=>checkSpec({...spec,...change},p));
});
test('M0-03 hard prose band and lexical/template redlines', () => {
  for(const n of [1199,1200,1500,1501,1599,1600,1601]) {
    const check=()=>checkProse('文'.repeat(n),p);
    if(n<1200 || n>1500) assert.throws(check,e=>e.code==='verdict.len_over' && e.metrics.direct_fail===(n>=1600));
    else check();
  }
  assert.throws(()=>checkProse('文'.repeat(1200)+'校服',p),{code:'verdict.blocked'});
  assert.throws(()=>checkProse('文'.repeat(1200)+'【场外点名】',p),{code:'verdict.template'});
});
test('M1-05 guard rejects unknown paths, wrong types and out-of-set values', () => {
  const state={location:'甲',phase:'早'};
  for(const e of [{op:'path',value:'乙'},{op:'move',value:1},{op:'move',value:'丙'},{op:'phase',value:'晚',role:'extra'}])
    assert.throws(()=>settle(state,[e],spec));
  assert.deepEqual(state,{location:'甲',phase:'早'});
});
