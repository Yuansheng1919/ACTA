import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validatePolicy } from '../http/config.mjs';
import { checkSpec, checkSections, checkProse, examplePolicy, scan, sections } from '../engine/gates.mjs';

test('three rule classes have distinct verdicts at all three gates', () => {
  const p=validatePolicy({...examplePolicy,blocked:['STOP'],patterns:['X[0-9]+'],templates:['[named]']});
  for(const [probe,code] of [['ＳＴＯＰ','blocked'],['x12','pattern'],['[named]','template']]) {
    const checks=[
      ()=>checkSpec({name:probe,age:18,locations:['甲'],phases:['早']},p),
      ()=>checkSections(Object.fromEntries(sections.map(k=>[k,'合成文案'+probe])),p),
      ()=>checkProse('文'.repeat(1200)+probe,p)
    ];
    for(const check of checks)assert.throws(check,{code:'verdict.'+code});
  }
  scan('n',p,'test'); // Brackets in a v2 name are literal.
  assert.throws(()=>scan('STOP x12 [named]',p,'test'),{code:'verdict.blocked'});
  assert.throws(()=>validatePolicy({...p,patterns:['[']}),/policy.patterns/);
  assert.throws(()=>validatePolicy({...p,patterns:null}),/policy.patterns/);
});
test('legacy policy preserves regex templates and their old verdict',()=>{
  const {patterns,...legacy}=examplePolicy;
  const p=validatePolicy({...legacy,templates:['name[0-9]+']});
  assert.throws(()=>scan('name7',p,'test'),{code:'verdict.template'});
});
test('owner sample policy loads unchanged and routes each hit',{skip:!process.env.ACTA_ACCEPTANCE_DIR},()=>{
  const p=validatePolicy(JSON.parse(readFileSync(process.env.ACTA_ACCEPTANCE_DIR+'/policy-sample.json','utf8')));
  for(const [input,code] of [['未成年','blocked'],['校服','pattern'],['【场外点名】','template']])
    assert.throws(()=>scan(input,p,'test'),{code:'verdict.'+code});
});
