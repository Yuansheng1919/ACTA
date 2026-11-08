import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeImport } from '../engine/import.mjs';
import { examplePolicy as p, sections } from '../engine/gates.mjs';
import { harness } from '../acceptance/fixtures/harness.mjs';

const inputs=resolve(process.env.ACTA_ACCEPTANCE_DIR??'acceptance');
const provided=existsSync(inputs+'/samples');
const files=provided?readdirSync(inputs+'/samples').filter(f=>f.endsWith('.png')).sort():[];
const input=f=>readFileSync(inputs+'/samples/'+f);
const spec={age:24,locations:['甲','乙'],phases:['早','晚']};
const texts=Object.fromEntries(sections.map(k=>[k,'合成样本文案']));
const imported=(row,opts={})=>normalizeImport(Buffer.from(JSON.stringify(row)),opts,p);

test('single-role selection precedes overrides; missing profile prose cannot silently inherit shared prose',()=>{
  const row={name:'合成',...spec,...texts,characters:[{name:'甲',...texts},{name:'乙'}]};
  assert.throws(()=>imported(row,{overrides:{characters:['甲']}}),{code:'import.select_one'});
  assert.throws(()=>imported(row,{select:'丙'}),{code:'import.unknown_selection'});
  assert.equal(imported(row,{select:'乙'}).report.publishable,false);
  assert.deepEqual(imported(row,{select:'甲'}).card.spec.characters,['甲']);
  assert.equal(imported({...row,characters:['甲','乙']},{select:'乙'}).report.publishable,false);
  assert.throws(()=>imported({...row,age:17},{select:'甲',overrides:{age:20}}),{code:'spec.age'});
});
test('sparse external world entries override by comment; unknown phase excluded with field report',()=>{
  const book={entries:{7:{comment:'match',content:'旧条目'},55:{comment:'',content:'无名条目'}}};
  const external={entries:{88:{comment:'match',content:'新的条目',position:1,depth:4}}};
  const r=imported({name:'合成',...spec,...texts,phases:['早','午'],character_book:book},{external_world:external});
  assert.deepEqual(r.card.spec.phases,['早']);assert.deepEqual(r.card.world.entries.map(e=>e.content),['新的条目','无名条目']);
  assert.ok(r.report.diff.some(x=>x.reason==='outside_enum'));
  assert.ok(r.report.diff.some(x=>x.reason==='same_comment_later_source'));
  assert.equal(imported({name:'合成',...spec,...texts,phases:['午']}).report.publishable,false);
});

test('d9e18d2: original PNGs vs independent JSON companions, then explicit HTTP import',{skip:!provided},async t=>{
  assert.equal(files.length,5);
  const policy=JSON.parse(readFileSync(inputs+'/policy-sample.json'));
  const h=await harness(t,{policy});
  for(const [i,f] of files.entries()){
    const options=i===3?{select:'角色A'}:{};
    const bytes=input(f),side=input(f.replace(/\.png$/u,'.json'));
    if(i===3){
      assert.throws(()=>normalizeImport(bytes,{},policy),e=>e.code==='import.select_one'&&e.importDetails.choices.length===2);
      const req=await h.request('/v1/card/import',{body:{file:bytes.toString('base64'),dry_run:true}});
      assert.equal(req.status,422);assert.deepEqual(req.data.choices,['角色A','角色B']);
    }
    const parsed=normalizeImport(bytes,options,policy),paired=normalizeImport(side,options,policy);
    assert.deepEqual(parsed.card.texts,paired.card.texts);assert.deepEqual(parsed.card.world,paired.card.world);
    assert.deepEqual(parsed.card.spec,paired.card.spec);assert.deepEqual(parsed.extensions,paired.extensions);
    assert.ok(parsed.card.texts.description.includes('ACTA-PROBE-'+['A1','B2','C3','D4','E5'][i]));
    assert.equal(parsed.report.dual,['equal','absent','different','equal','equal'][i]);
    assert.equal(parsed.report.publishable,false);
    assert.equal(parsed.report.issues.filter(x=>x.code==='card.section_length').length,5);
    if(i===1)assert.equal(parsed.card.meta.creator_notes,JSON.parse(side).creatorcomment);
    if(i===2)assert.equal(parsed.card.spec.name,'新块名字');
    if(i===3){
      assert.equal(parsed.card.world.entries.length,1);
      for(const reason of ['invalid_phase','other_role','legacy_state_mirror','unsupported_entry_semantics'])
        assert.ok(parsed.report.diff.some(x=>x.reason===reason));
    }
    if(i===4){
      assert.ok(JSON.stringify(JSON.parse(side)).includes('must not run'));
      assert.deepEqual(parsed.extensions.map(e=>e.type),['regex','skin','script']);
      assert.ok(!JSON.stringify(parsed).includes('must not run'));
    }
    const req={file:bytes.toString('base64'),...options};
    const raw=await h.request('/v1/card/import',{body:req});
    assert.equal(raw.status,422);assert.equal(raw.data.error.code,'import.review_required');
    const overrides={age:24,locations:policy.locations.slice(0,2),phases:policy.phases};
    const corrected=Object.fromEntries(sections.map(k=>[k,parsed.card.texts[k]+'文'.repeat(policy.lengths[k][0])]));
    const resp=await h.request('/v1/card/import',{body:{...req,overrides,texts:corrected}});
    assert.equal(resp.status,201,resp.text);assert.equal(h.observations().length,0);
  }
});

test('corrupt PNG CRC and non-canonical uploads are rejected',async()=>{
  const {importBytes}=await import('../engine/import.mjs');
  assert.throws(()=>importBytes('***'),{code:'import.base64'});
  if(provided){
    const b=Buffer.from(input(files[0]));b[b.length-1]^=1;
    assert.throws(()=>normalizeImport(b,{},p),{code:'png_crc'});
  }
});

test('deflated ZIP with a card and external book; nested archive rejected',()=>{
  // Synthetic archives produced independently by the standard ZIP writer.
  const zip=Buffer.from('UEsDBBQAAAAIAAt/Z13tqu/kgQAAANkAAAAJAAAAY2FyZC5qc29uq1bKS8xNVbJSUHo+ZZOSjoJSYjqIZ2QCZObkJyeWZObnFQMFosHysUDRgozE4lSI0LPpK8FCKanFyUWZBSC1IJOeTuh41jHh2bT2Zws7QEYWpBYV5+cl5mSWVGKTLk5OzUssyszHJpeWWVRcEp8Ltg9DEigcn1qRmFuQk4ohXQsAUEsDBBQAAAAIAAt/Z10U/zPhRgAAAFMAAAAKAAAAd29ybGQuanNvbqtWSs0rKcpMLVayUqhWMgeTyfm5uUBRIFvp6YSOZx0TlHQUgIJ5JTDBJdNeNq94Nnfh89nrQFIF+cWZJZn5eUA5w9raWgBQSwECFAMUAAAACAALf2dd7arv5IEAAADZAAAACQAAAAAAAAAAAAAAgAEAAAAAY2FyZC5qc29uUEsBAhQDFAAAAAgAC39nXRT/M+FGAAAAUwAAAAoAAAAAAAAAAAAAAIABqAAAAHdvcmxkLmpzb25QSwUGAAAAAAIAAgBvAAAAFgEAAAAA','base64');
  const result=normalizeImport(zip,{},p);
  assert.equal(result.report.kind,'zip');assert.equal(result.report.publishable,true);
  assert.equal(result.card.world.entries[0].content,'外部条目');
  assert.throws(()=>normalizeImport(Buffer.from('UEsDBBQAAAAIAAt/Z11FJca6BgAAAAQAAAAKAAAAbmVzdGVkLnppcAvwZmYBAFBLAQIUAxQAAAAIAAt/Z11FJca6BgAAAAQAAAAKAAAAAAAAAAAAAACAAQAAAABuZXN0ZWQuemlwUEsFBgAAAAABAAEAOAAAAC4AAAAAAA==','base64'),{},p),{code:'nested_archive'});
});
