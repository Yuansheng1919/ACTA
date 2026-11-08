import { Fault, reject } from './fault.mjs';
import { isDeepStrictEqual } from 'node:util';
import { checkSpec, checkSection, sections, object, scan } from './gates.mjs';
import { decodeJson, isPng, isZip, readPng, unzip, limits } from './containers.mjs';
import { mergeBooks, stateSubjects } from './import-world.mjs';

const rowOf = raw => object(raw?.data) ? raw.data : raw;
const isBook = raw => object(raw) && (raw.spec==='lorebook_v3' || Object.hasOwn(raw,'entries') && !raw.description);
const specKeys=['name','age','locations','phases','relation','axes','tone','scale','voice','notes'];
const wireKeys=new Set([...specKeys,...sections,'characters','character_book','creator_notes','creatorcomment','tags',
  'extensions','card_spec','spec','spec_version','data','alternate_greetings','creator','character_version',
  'post_history_instructions','system_prompt','group_only_greetings']);
function flag(path,action,reason) { return {path,action,reason}; }
function interactive(code,details) {
  const error=new Fault(422,code);
  error.importDetails=details; // Sent only to the authenticated caller, never as audit metrics.
  throw error;
}
function inspectContent(input,p) {
  const queue=[input]; let visited=0;
  while(queue.length){
    if(++visited>200000)reject(413,'import.structure_limit');
    const value=queue.pop();
    if(typeof value==='string')scan(value,p,'import');
    else if(value && typeof value==='object')for(const [k,v] of Object.entries(value)){
      if(['age','年龄','年齡'].includes(k) && (typeof v==='number'||typeof v==='string') && Number(v)<18)
        reject(422,'spec.age');
      queue.push(v);
    }
  }
}
function dual(blocks,ctx) {
  const {ccv3,chara}=blocks;
  if(!ccv3 && !chara)reject(422,'import.no_card');
  if(ccv3 && chara) {
    const a=rowOf(chara),b=rowOf(ccv3);
    if(!object(a)||!object(b))reject(422,'import.card_shape');
    const changes=[...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>!isDeepStrictEqual(a[k],b[k]));
    ctx.dual=changes.length?'different':'equal';
    for(const k of changes)ctx.diff.push(flag('dual.'+k,'preferred','ccv3_wins'));
  }
  return ccv3??chara;
}
function unpack(file,ctx,p) {
  if(isZip(file)) {
    const cards=[];
    for(const [name,bytes] of unzip(file)){
      if(isPng(bytes)){
        const {blocks}=readPng(bytes);
        if(Object.keys(blocks).length)cards.push(bytes);
        else ctx.diff.push(flag(name,'not_adopted','auxiliary_image'));
      } else if(/\.json$/iu.test(name)){
        const value=decodeJson(bytes);inspectContent(value,p);
        if(isBook(value))ctx.books.push(['external:'+name,value]);
        else if(object(value)&&(rowOf(value).name || value.ccv3 || value.chara || value.characters))cards.push(bytes);
        else ctx.diff.push(flag(name,'not_adopted','auxiliary_json'));
      } else ctx.diff.push(flag(name,'not_adopted','unsupported_member'));
    }
    if(cards.length>1)reject(422,'import.ambiguous_archive');
    return cards.length?unpack(cards[0],ctx,p):null;
  }
  if(isPng(file)){
    const parsed=readPng(file);ctx.image=parsed.image.toString('base64');
    inspectContent(parsed.blocks,p);return dual(parsed.blocks,ctx);
  }
  const raw=decodeJson(file);inspectContent(raw,p);
  if(isBook(raw)){ctx.books.push(['external',raw]);return null;}
  return object(raw)&&(raw.ccv3||raw.chara)?dual(raw,ctx):raw;
}
function choose(row,books,selection,diff) {
  if(row.characters!==undefined && (!Array.isArray(row.characters)||!row.characters.length))reject(422,'import.role_shape');
  const roles=row.characters??[];
  const names=roles.map(item=>typeof item==='string'?item:item?.name);
  if(names.some(n=>typeof n!=='string'||!n.trim())||new Set(names).size!==names.length)reject(422,'import.role_shape');
  const legacy=stateSubjects(books);
  const choices=names.length>1?names:legacy.length>1?legacy:names;
  if(choices.length>1 && !selection)interactive('import.select_one',{choices,diff});
  if(selection!==undefined && !choices.includes(selection))interactive('import.unknown_selection',{choices,diff});
  const picked=roles.find(r=>(typeof r==='string'?r:r.name)===(selection??names[0]));
  if(choices.length>1)diff.push(flag('characters','selected','explicit_selection'));
  if(object(picked)) {
    const chosen={...row,...picked,name:picked.name,characters:[picked.name]};
    if(names.length>1)for(const k of sections)chosen[k]=picked[k];
    return chosen;
  }
  if(names.length>1)return {...row,name:selection,characters:[selection]};
  if(!names.length && legacy.length>1)return {...row,name:selection,characters:[selection]};
  return row;
}
function registerExtensions(row,diff) {
  const registry=[];
  if(row.extensions!==undefined && !object(row.extensions))reject(422,'import.extensions');
  for(const [k,v] of Object.entries(row.extensions??{})){
    if(k==='acta')continue;
    const type=/regex/i.test(k)?'regex':/skin/i.test(k)?'skin':/guard|script|helper/i.test(k)?'script':'other';
    const count=Array.isArray(v)?v.length:Array.isArray(v?.scripts)?v.scripts.length:1;
    registry.push({key:k,type,count});
    diff.push(flag('extensions.'+k,'registered','never_executed'));
  }
  return registry;
}
function unresolved(e) {
  if(!(e instanceof Fault))throw e;
  return {code:e.code,...e.metrics};
}

export function normalizeImport(file,options,p,base) {
  if(!Buffer.isBuffer(file)||!file.length)reject(400,'import.file');
  if(file.length>limits.upload)reject(413,'import.size');
  if(!object(options))reject(400,'import.options');
  const ctx={diff:[],dual:'absent',books:[],image:null};
  const kind=isPng(file)?'png':isZip(file)?'zip':'json';
  let raw=unpack(file,ctx,p);
  if(!raw){
    if(!ctx.books.length)reject(422,'import.no_card');
    if(!base)interactive('import.base_required',{fields:['base_revision']});
    raw={...base.spec,...base.texts,...base.meta,character_book:base.world};
    ctx.image=base.image??null;
  }
  if(!object(raw)||!object(rowOf(raw)))reject(422,'import.card_shape');
  const original=rowOf(raw);
  const metaSpec=original.extensions?.acta?.spec??original.card_spec;
  if(original.characters!==undefined && metaSpec?.characters!==undefined &&
      !isDeepStrictEqual(original.characters,metaSpec.characters))reject(422,'import.conflicting_role_slots');
  const root={...original,characters:original.characters??metaSpec?.characters};
  if(original!==raw)for(const k of [...sections,'name'])if(Object.hasOwn(raw,k)&&raw[k]!==root[k])
    ctx.diff.push(flag(k,'preferred','nested_data_wins'));
  if(options.external_world!==undefined){inspectContent(options.external_world,p);ctx.books.push(['external',options.external_world]);}
  const books=[['embedded',root.character_book],...ctx.books];
  const row=choose(root,books,options.select,ctx.diff);
  books[0]=['embedded',row.character_book];
  const embedded=row.extensions?.acta?.spec??row.card_spec??{};
  if(!object(embedded))reject(422,'import.spec_shape');
  if(root.characters?.length===1 && typeof root.characters[0]==='string' && root.characters[0]!==row.name)reject(422,'spec.single_role');
  const source={...embedded,...row};
  const spec=Object.fromEntries(specKeys.filter(k=>Object.hasOwn(source,k)).map(k=>[k,source[k]]));
  spec.characters=[row.name];
  const overrides=options.overrides??{},textChanges=options.texts??{};
  if(!object(overrides)||!object(textChanges))reject(400,'import.overrides');
  for(const [k,v] of Object.entries(overrides)){
    if(!specKeys.includes(k)||k==='name')reject(400,'import.override_field');
    spec[k]=v;ctx.diff.push(flag('spec.'+k,'overridden','manual'));
  }
  if(Object.keys(textChanges).some(k=>!sections.includes(k)))reject(400,'import.text_field');
  const texts=Object.fromEntries(sections.map(k=>[k,Object.hasOwn(textChanges,k)?textChanges[k]:row[k]]));
  for(const k of Object.keys(textChanges))ctx.diff.push(flag(k,'overridden','manual'));
  const issues=[];
  if(Array.isArray(root.characters)&&root.characters.length>1 && root.characters.every(x=>typeof x==='string') &&
      !sections.every(k=>Object.hasOwn(textChanges,k)))issues.push({code:'import.separate_profile_text'});
  for(const k of ['age','locations','phases'])if(!Object.hasOwn(spec,k))issues.push({code:'import.required',path:k});
  for(const k of ['phases','locations'])if(Array.isArray(spec[k])) {
    const kept=spec[k].filter(v=>p[k].includes(v));
    if(kept.length!==spec[k].length)ctx.diff.push(flag('spec.'+k,'not_adopted','outside_enum'));
    spec[k]=kept;
  }
  try {checkSpec(spec,p);}catch(e){issues.push(unresolved(e));}
  for(const k of sections){
    try {checkSection(k,texts[k],p);}
    catch(e){if(e.code?.startsWith('verdict.'))throw e;issues.push(unresolved(e));}
  }
  const world=mergeBooks(books,ctx.diff,options.select,p);
  const extensions=registerExtensions(row,ctx.diff);
  for(const [k,v] of Object.entries(row))if(!wireKeys.has(k) && v!=='' && v!=null)
    ctx.diff.push(flag(k,'not_adopted','unknown_field'));
  for(const k of ['system_prompt','post_history_instructions','alternate_greetings','group_only_greetings'])
    if(row[k]?.length)ctx.diff.push(flag(k,'not_adopted','unsupported_portable_field'));
  const tags=row.tags??[],notes=row.creator_notes??row.creatorcomment??'';
  if(!Array.isArray(tags)||tags.some(x=>typeof x!=='string')||typeof notes!=='string')reject(422,'import.meta');
  return {card:{spec,texts,world,meta:{tags,creator_notes:notes},image:ctx.image},extensions,
    report:{kind,dual:ctx.dual,diff:ctx.diff,issues,publishable:issues.length===0}};
}

export function importBytes(value) {
  if(object(value))return Buffer.from(JSON.stringify(value));
  if(typeof value!=='string'||!value)reject(400,'import.file');
  const decoded=Buffer.from(value,'base64');
  if(decoded.toString('base64')!==value)reject(400,'import.base64');
  return decoded;
}
