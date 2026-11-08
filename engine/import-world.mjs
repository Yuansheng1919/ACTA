import { object } from './gates.mjs';
import { reject } from './fault.mjs';

const subjectKey = /^角色(?:[A-Z\d]+|[甲乙丙丁])$/u;
const initEntry = e => /^\[initvar\]/iu.test(e.comment ?? '');
function rows(book) {
  if(book==null)return [];
  const entries=(book.spec==='lorebook_v3'?book.data:book)?.entries;
  if(!Array.isArray(entries)&&!object(entries))reject(422,'import.world_entries');
  return Object.entries(entries);
}
function initData(e) {
  try { const v=JSON.parse(e.content); return object(v)?v:{}; } catch { return {}; }
}
export function stateSubjects(books) {
  const names=new Set();
  for(const [,book] of books)for(const [,e] of rows(book))
    if(object(e)&&initEntry(e)) for(const k of Object.keys(initData(e)))if(subjectKey.test(k))names.add(k);
  return [...names];
}
function entry(e, path, diff, selected, policy) {
  if(!object(e)||typeof e.content!=='string')reject(422,'import.world_entry');
  const note=(action,reason,field='')=>diff.push({path:path+field,action,reason});
  // Old state trees and textual mirrors do not participate in engine settlement.
  if(initEntry(e)){
    const raw=initData(e),phase=raw['世界']?.['时段'];
    if(phase!==undefined && !policy.phases.includes(phase))note('not_adopted','invalid_phase','.state.phase');
    for(const k of Object.keys(raw).filter(k=>subjectKey.test(k)))
      if(k!==selected)note('not_adopted','other_role','.state.'+k);
    note('not_adopted','legacy_initial_state'); return null;
  }
  if(/(?:^|\n)\s*(?:世界[.。]|角色[A-Z\d甲乙丙丁]+[.。])/u.test(e.content)){
    note('not_adopted','legacy_state_mirror');return null;
  }
  const position=new Map([[0,'before_char'],[1,'after_char'],['before_char','before_char'],['after_char','after_char']]).get(e.position??0);
  if(!position || e.use_regex || e.selective || Object.keys(e.extensions??{}).length){
    note('not_adopted','unsupported_entry_semantics');return null;
  }
  if(e.depth!==undefined)note('not_adopted','depth_not_supported','.depth');
  for(const k of ['constant','enabled','disable','case_sensitive'])
    if(e[k]!==undefined && typeof e[k]!=='boolean')reject(422,'import.world_flag');
  const keys=e.keys??e.key??[];
  if(!Array.isArray(keys)||keys.some(k=>typeof k!=='string'))reject(422,'import.world_keys');
  const comment=e.comment??'';
  if(typeof comment!=='string')reject(422,'import.world_comment');
  return {comment:comment.trim(),keys,content:e.content,constant:e.constant??false,enabled:e.enabled??!e.disable,
    insertion_order:Number.isSafeInteger(e.insertion_order)?e.insertion_order:(Number.isSafeInteger(e.order)?e.order:100),
    case_sensitive:e.case_sensitive??false,position,use_regex:false,extensions:{}};
}
export function mergeBooks(books,diff,selected,policy) {
  const entries=[],byComment=new Map();
  for(const [source,book] of books)for(const [key,raw] of rows(book)){
    const path=source+'.entries.'+key;
    const value=entry(raw,path,diff,selected,policy);
    const name=typeof raw.comment==='string'?raw.comment.trim():'';
    if(name && byComment.has(name)){
      const index=byComment.get(name);
      entries[index]=value;diff.push({path,action:'replaced',reason:'same_comment_later_source'});
    }else if(value) {
      if(name)byComment.set(name,entries.length);
      entries.push(value);
    }
  }
  return {extensions:{},entries:entries.filter(Boolean)};
}
export function activeLore(world,latest) {
  return (world?.entries??[]).filter(e=>e.enabled && (e.constant || e.keys.some(key=>
    key && (e.case_sensitive?latest.includes(key):latest.toLowerCase().includes(key.toLowerCase())))))
    .sort((a,b)=>a.insertion_order-b.insertion_order).map(e=>({position:e.position,content:e.content}));
}
