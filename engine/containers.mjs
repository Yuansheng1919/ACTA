import {inflateRawSync,inflateSync} from 'node:zlib';
import {reject as fail} from './fault.mjs';
export function decodeJson(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); }
  catch { fail(422,'import.invalid_json'); }
}
// CRC-32/ISO-HDLC, also available on Node versions without zlib.crc32.
const table = Uint32Array.from({length:256}, (_,byte) => {
  let crc = byte;
  for(let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);
  return crc>>>0;
});
export function crc32(bytes) {
  let crc=0xffffffff;
  for(const byte of bytes) crc=(crc>>>8)^table[(crc^byte)&255];
  return (crc^0xffffffff)>>>0;
}
export const limits={upload:8*1024*1024, expanded:16*1024*1024, entry:8*1024*1024, entries:96, metadata:2*1024*1024};
const sig=Buffer.from([137,80,78,71,13,10,26,10]);
export const isPng=b=>b.subarray(0,8).equals(sig);
export const isZip=b=>b.length>=4 && [0x04034b50,0x06054b50].includes(b.readUInt32LE());
const fatal=()=>fail(422,'invalid_container');
function cap(n,max){if(n>max)fail(413,'archive_limit');}
function unbase64(v) {
  if(!v.length||v.length>limits.metadata*4/3+4)fail(413,'card_metadata_limit');
  const s=v.toString('ascii');
  const bytes=Buffer.from(s,'base64');
  if(v.some(b=>b>127)||bytes.toString('base64')!==s)fatal();
  return decodeJson(bytes);
}
export function readPng(buf) {
  if(!isPng(buf))fatal();
  let at=8,first=true,end=false,dataSeen=false;
  const kept=[sig], blocks={};
  while(at<buf.length) {
    if(at+12>buf.length)fatal();
    const n=buf.readUInt32BE(at), stop=at+12+n;
    if(stop>buf.length)fatal();
    const type=buf.toString('ascii',at+4,at+8), data=buf.subarray(at+8,stop-4);
    if(crc32(buf.subarray(at+4,stop-4))!==buf.readUInt32BE(stop-4))fail(422,'png_crc');
    if(first && (type!=='IHDR'||n!==13))fatal();
    if(type==='IHDR' && (!first || n!==13 || !data.readUInt32BE(0)||!data.readUInt32BE(4) || data.readUInt32BE(0)*data.readUInt32BE(4)>32000000))fatal();
    first=false;
    if(['tEXt','iTXt','zTXt'].includes(type)) {
      const i=data.indexOf(0), k=data.toString('latin1',0,Math.max(0,i));
      if(i>0 && ['ccv3','chara'].includes(k)) {
        if(Object.hasOwn(blocks,k))fail(422,'duplicate_card_chunk');
        let v=data.subarray(i+1);
        if(type==='zTXt') {
          if(v[0]!==0)fatal();
          try{v=inflateSync(v.subarray(1),{maxOutputLength:limits.metadata*2});}catch{fatal();}
        } else if(type==='iTXt') {
          if(v[0]!==0 || v[1]!==0)fail(422,'unsupported_itxt');
          const lang=v.indexOf(0,2), label=v.indexOf(0,lang+1);
          if(lang<0||label<0)fatal();
          v=v.subarray(label+1);
        }
        blocks[k]=unbase64(v);
      }
    } else {
      if (['IHDR','PLTE','IDAT','IEND','tRNS','gAMA','sRGB','cHRM','pHYs'].includes(type))
        kept.push(buf.subarray(at,stop));
      if(type==='IDAT')dataSeen=true;
      if(type==='IEND'){if(n||stop!==buf.length)fatal();end=true;}
    }
    at=stop;
  }
  if(!end||!dataSeen)fatal();
  return {blocks,image:Buffer.concat(kept)};
}
function pathName(raw) {
  let name; try{name=new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch{fatal();}
  if(!name||name.length>240||/[\\:\x00-\x1f]/u.test(name)||name.startsWith('/')||
    name.replace(/\/$/u,'').split('/').some(k=>k==='.'||k==='..'||!k))fail(422,'unsafe_archive_path');
  return name;
}
export function unzip(buf) {
  cap(buf.length,limits.upload);
  let e=-1;
  for(let i=buf.length-22;i>=Math.max(0,buf.length-65557);i--)
    if(buf.readUInt32LE(i)===0x06054b50 && i+22+buf.readUInt16LE(i+20)===buf.length){e=i;break;}
  if(e<0||buf.readUInt32LE(e+4)!==0)fatal();
  const count=buf.readUInt16LE(e+10);
  if(count!==buf.readUInt16LE(e+8))fatal();
  cap(count,limits.entries);
  const base=buf.readUInt32LE(e+16); let at=base,total=0;
  if(base+buf.readUInt32LE(e+12)!==e)fatal();
  const files=new Map(),seen=new Set();
  for(let i=0;i<count;i++) {
    if(at+46>e||buf.readUInt32LE(at)!==0x02014b50)fatal();
    const flags=buf.readUInt16LE(at+8), method=buf.readUInt16LE(at+10);
    const crc=buf.readUInt32LE(at+16),compressed=buf.readUInt32LE(at+20),size=buf.readUInt32LE(at+24);
    const nl=buf.readUInt16LE(at+28),ex=buf.readUInt16LE(at+30),cm=buf.readUInt16LE(at+32);
    const local=buf.readUInt32LE(at+42),end=at+46+nl+ex+cm;
    if(end>e||(flags&~0x080e)||![0,8].includes(method)||buf.readUInt16LE(at+34)!==0)fatal();
    const name=pathName(buf.subarray(at+46,at+46+nl));
    if(seen.has(name)||((buf.readUInt32LE(at+38)>>>16)&0xf000)===0xa000)fail(422,'unsafe_archive_entry');
    seen.add(name); cap(size,limits.entry); total+=size;cap(total,limits.expanded);
    if(local+30>base||buf.readUInt32LE(local)!==0x04034b50||buf.readUInt16LE(local+8)!==method||buf.readUInt16LE(local+6)!==flags)fatal();
    const ll=buf.readUInt16LE(local+26),start=local+30+ll+buf.readUInt16LE(local+28);
    if(start+compressed>base||pathName(buf.subarray(local+30,local+30+ll))!==name)fatal();
    const bytes=buf.subarray(start,start+compressed);
    let data=bytes;
    if(method===8){try{data=inflateRawSync(bytes,{maxOutputLength:Math.max(1,size)});}catch{fail(422,'invalid_deflate');}}
    if(data.length!==size||crc32(data)!==crc)fatal();
    if(isZip(data)||/\.(?:zip|charx)$/iu.test(name))fail(413,'nested_archive');
    if(!name.endsWith('/'))files.set(name,data);
    at=end;
  }
  if(at!==e)fatal(); return files;
}
