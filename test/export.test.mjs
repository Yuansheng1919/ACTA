import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,readdirSync,existsSync,rmSync,writeFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { harness,spec } from '../acceptance/fixtures/harness.mjs';
import { decodeJson,readPng,unzip } from '../engine/containers.mjs';
import { normalizeImport } from '../engine/import.mjs';
import { examplePolicy as p } from '../engine/gates.mjs';
import { hash } from '../store/commit.mjs';
import { guardVersion,schemaVersion } from '../engine/guard.mjs';

async function asset(h,uri,token=h.tokens[0]) {
  const res=await fetch(h.url+uri,{headers:{authorization:'Bearer '+token}});
  return {status:res.status,bytes:Buffer.from(await res.arrayBuffer()),type:res.headers.get('content-type')};
}
test('published revision pins all three stamps, validates hashes, ownership and restart downloads',async t=>{
  const h=await harness(t),r=await h.request('/v1/card/build',{body:{spec}});
  assert.equal(r.status,201);const pub=r.data,rev=pub.card_revision;
  const png=await asset(h,pub.files.file),zip=await asset(h,pub.files.bundle),world=await asset(h,pub.files.world);
  assert.equal(png.type,'image/png');assert.equal(zip.type,'application/zip');
  assert.equal(hash(zip.bytes),pub.bundle_sha256);const archive=unzip(zip.bytes);
  assert.deepEqual(archive.get('card.png'),png.bytes);
  const blocks=readPng(png.bytes).blocks;
  for(const key of ['chara','ccv3']){
    const {data}=blocks[key],ext=data.extensions.acta;
    assert.deepEqual([ext.card_revision,ext.schema_version,ext.guard_version],[rev,schemaVersion,guardVersion]);
    assert.deepEqual(data.character_book,decodeJson(world.bytes));
    assert.equal(ext.portable.server_guard,false);assert.deepEqual(ext.state_schema.properties.phase.enum,spec.phases);
  }
  const manifest=decodeJson((await asset(h,pub.files.manifest)).bytes);
  for(const value of manifest.files)assert.equal(hash(archive.get(value.name)),value.sha256);
  const notes=(await asset(h,pub.files.capabilities)).bytes.toString();
  assert.ok(notes.includes(rev));assert.ok(notes.includes('不可用'));assert.ok(!notes.includes('{{'));
  assert.equal((await asset(h,pub.files.file,h.tokens[1])).status,404);
  await h.restart();assert.deepEqual((await asset(h,pub.files.bundle)).bytes,zip.bytes);
  // Pre-feature published entities have no stored bundle pointer.
  const record=join(h.root,'cards',rev+'.json'),old=JSON.parse(readFileSync(record));
  delete old.bundle_sha256;writeFileSync(record,JSON.stringify(old));rmSync(join(h.root,'assets',rev+'.zip'));
  assert.deepEqual((await asset(h,pub.files.file)).bytes,png.bytes);
});
test('staged write failure exposes no card or partial download',async t=>{
  const h=await harness(t);
  writeFileSync(join(h.root,'assets'),'block-directory-creation');
  assert.equal((await h.request('/v1/card/build',{body:{spec}})).status,500);
  assert.deepEqual(readdirSync(join(h.root,'cards')),[]);
});
const dir=resolve(process.env.ACTA_ACCEPTANCE_DIR??'acceptance','samples');
test('project five original PNGs: normalized PNG and ZIP can be imported again with identical texts, schema and lore',{skip:!existsSync(dir)},async t=>{
  const h=await harness(t);
  for(const f of readdirSync(dir).filter(f=>f.endsWith('.png')).sort()){
    const bytes=readFileSync(join(dir,f));
    const opts={overrides:{age:24,locations:['甲','乙'],phases:['早','晚']},...(f.startsWith('D')?{select:'角色A'}:{})};
    const original=normalizeImport(bytes,opts,p);
    const imported=await h.request('/v1/card/import',{body:{file:bytes.toString('base64'),...opts}});
    assert.equal(imported.status,201);
    const pub=imported.data;
    const exported=(await asset(h,pub.files.file)).bytes;
    const packed=(await asset(h,pub.files.bundle)).bytes;
    assert.deepEqual(readPng(exported).image,readPng(bytes).image);
    for(const format of [exported,packed]){
      const restored=normalizeImport(format,{},p);
      assert.equal(restored.report.publishable,true);assert.equal(restored.report.dual,'equal');
      for(const k of ['spec','texts','world','meta','image'])assert.deepEqual(restored.card[k],original.card[k]);
      const second=await h.request('/v1/card/import',{body:{file:format.toString('base64')}});
      assert.equal(second.status,201);assert.notEqual(second.data.card_revision,pub.card_revision);
      const secondExt=readPng((await asset(h,second.data.files.file)).bytes).blocks.ccv3.data.extensions.acta;
      const firstExt=readPng(exported).blocks.ccv3.data.extensions.acta;
      assert.deepEqual(secondExt.state_schema,firstExt.state_schema);
      assert.equal(secondExt.guard_version,firstExt.guard_version);
    }
    const raw=readPng(exported).blocks.ccv3;raw.data.extensions.acta.guard_version='unsupported';
    assert.ok(normalizeImport(Buffer.from(JSON.stringify(raw)),{},p).report.issues.some(x=>x.code==='import.unsupported_versions'));
  }
});
