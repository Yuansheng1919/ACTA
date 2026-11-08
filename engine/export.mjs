import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { crc32, limits, readPng, unzip, decodeJson } from './containers.mjs';
import { hash } from '../store/commit.mjs';
import { reject } from './fault.mjs';

const template=readFileSync(new URL('../docs/导出说明模板.md',import.meta.url),'utf8');
const signature=Buffer.from([137,80,78,71,13,10,26,10]);
function chunk(type,body) {
  const b=Buffer.alloc(body.length+12);
  b.writeUInt32BE(body.length);b.write(type,4,'ascii');body.copy(b,8);
  b.writeUInt32BE(crc32(b.subarray(4,-4)),b.length-4);return b;
}
const blank=Buffer.concat([signature,chunk('IHDR',Buffer.from('00000001000000010806000000','hex')),
  chunk('IDAT',deflateSync(Buffer.alloc(5))),chunk('IEND',Buffer.alloc(0))]);

function markdownLabel(text) {
  return text.replace(/[\r\n]+/gu,' ').replace(/[\\`*_{}\[\]<>()|#!]/gu,'\\$&');
}
function explanation(stamp,world) {
  const values={...stamp,entry_count:world.entries.length,
    world_entries:world.entries.map((e,i)=>'- '+(i+1)+'. '+markdownLabel(e.comment||'无注释条目')+
      '（'+(e.enabled?'启用':'停用')+'，'+(e.constant?'常驻':'关键字')+'，'+e.position+'）').join('\n')||'本修订未附世界书条目。'};
  return template.replace(/\{\{(\w+)\}\}/gu,(_,k)=>String(values[k]));
}

function packPng(card,stamp,world) {
  const ext={...stamp,spec:card.spec,state_schema:{type:'object',additionalProperties:false,
    required:['location','phase'],properties:{location:{type:'string',enum:card.spec.locations},
      phase:{type:'string',enum:card.spec.phases}}},portable:{texts:true,world:true,server_guard:false,session_resume:false}};
  const data={name:card.spec.name,...card.texts,tags:card.meta?.tags??[],creator_notes:card.meta?.creator_notes??'',
    character_book:world,extensions:{acta:ext},creator:'',character_version:card.id,alternate_greetings:[],
    system_prompt:'',post_history_instructions:''};
  const cover=card.image?readPng(Buffer.from(card.image,'base64')).image:blank;
  const meta=(key,obj)=>{
    const raw=Buffer.from(JSON.stringify(obj));
    if(raw.length>limits.metadata)reject(413,'export.metadata_limit');
    return chunk('tEXt',Buffer.from(key+'\0'+raw.toString('base64'),'ascii'));
  };
  const png=Buffer.concat([cover.subarray(0,-12),
    meta('chara',{spec:'chara_card_v2',spec_version:'2.0',data}),
    meta('ccv3',{spec:'chara_card_v3',spec_version:'3.0',data:{...data,group_only_greetings:[]}}),cover.subarray(-12)]);
  if(png.length>limits.entry)reject(413,'export.size');
  return png;
}

// Four fixed UTF-8 member names, no compression or nesting.
function zip(members) {
  const blocks=[],directory=[];let offset=0;
  for(const [name,bytes] of members) {
    const fn=Buffer.from(name),crc=crc32(bytes);
    const l=Buffer.alloc(30);l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt16LE(0x800,6);
    l.writeUInt16LE(33,12);l.writeUInt32LE(crc,14);l.writeUInt32LE(bytes.length,18);
    l.writeUInt32LE(bytes.length,22);l.writeUInt16LE(fn.length,26);
    const d=Buffer.alloc(46);d.writeUInt32LE(0x02014b50);d.writeUInt16LE(20,4);d.writeUInt16LE(20,6);
    d.writeUInt16LE(0x800,8);d.writeUInt16LE(33,14);d.writeUInt32LE(crc,16);
    d.writeUInt32LE(bytes.length,20);d.writeUInt32LE(bytes.length,24);d.writeUInt16LE(fn.length,28);d.writeUInt32LE(offset,42);
    blocks.push(l,fn,bytes);directory.push(d,fn);offset+=l.length+fn.length+bytes.length;
  }
  const cd=Buffer.concat(directory),tail=Buffer.alloc(22);
  tail.writeUInt32LE(0x06054b50);tail.writeUInt16LE(members.size,8);tail.writeUInt16LE(members.size,10);
  tail.writeUInt32LE(cd.length,12);tail.writeUInt32LE(offset,16);
  if(offset+cd.length+tail.length>limits.upload)reject(413,'export.size');
  return Buffer.concat([...blocks,cd,tail]);
}

export function exportBundle(card) {
  const stamp={card_revision:card.id,schema_version:card.schema,guard_version:card.guard};
  const world=card.world??{extensions:{},entries:[]};
  const files=new Map([['card.png',packPng(card,stamp,world)],['world.json',Buffer.from(JSON.stringify(world))],
    ['CAPABILITIES.md',Buffer.from(explanation(stamp,world))]]);
  const manifest={...stamp,files:[...files].map(([name,data])=>({name,bytes:data.length,sha256:hash(data)}))};
  files.set('manifest.json',Buffer.from(JSON.stringify(manifest)));
  return zip(files);
}

export function verifyBundle(bytes,card) {
  const members=unzip(bytes),manifest=decodeJson(members.get('manifest.json'));
  for(const item of manifest.files) {
    const body=members.get(item.name);
    if(!body || body.length!==item.bytes || hash(body)!==item.sha256)reject(500,'export.integrity');
  }
  const {blocks}=readPng(members.get('card.png')),world=decodeJson(members.get('world.json'));
  for(const [chunk,format,version] of [['chara','chara_card_v2','2.0'],['ccv3','chara_card_v3','3.0']]){
    const item=blocks[chunk],stamp=item?.data?.extensions?.acta;
    if(item?.spec!==format || item.spec_version!==version || stamp?.card_revision!==card.id ||
       stamp.schema_version!==card.schema || stamp.guard_version!==card.guard ||
       !isDeepStrictEqual(world,item.data.character_book) || !isDeepStrictEqual(card.spec,stamp.spec) ||
       Object.entries(card.texts).some(([k,v])=>item.data[k]!==v))reject(500,'export.integrity');
  }
  return members;
}
