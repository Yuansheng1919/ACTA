import { reject } from './fault.mjs';

export const sections = ['description', 'personality', 'scenario', 'first_mes', 'mes_example'];
export const examplePolicy = {
  version: 'synthetic-1', locations: ['甲','乙'], phases: ['早','晚'],
  blocked: ['校服','未成年','幼态','校园'], templates: ['【场外点名】'],
  lengths: Object.fromEntries(sections.map(key => [key,[4,1200]])),
  sentenceWarn: 45, similePer100: 4
};

export function count(text) {
  return [...text.normalize('NFC').replace(/\s/gu, '')].length;
}

export function object(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function scan(text, policy, path) {
  const normalized = text.normalize('NFKC').toLowerCase();
  if (policy.blocked.some(word => normalized.includes(word.normalize('NFKC').toLowerCase())))
    reject(422, 'verdict.blocked', { path });
  if (policy.templates.some(pattern => new RegExp(pattern, 'iu').test(normalized)))
    reject(422, 'verdict.template', { path });
}

export function checkSpec(spec, policy) {
  if (!object(spec)) reject(422, 'spec.required');
  if (!Number.isSafeInteger(spec.age) || spec.age < 18) reject(422, 'spec.age', { path: 'age' });
  if (typeof spec.name !== 'string' || !spec.name.trim()) reject(422, 'spec.name');
  if (spec.characters !== undefined && (!Array.isArray(spec.characters) ||
      spec.characters.length !== 1 || spec.characters[0] !== spec.name)) reject(422, 'spec.single_role');
  for (const key of ['locations','phases']) {
    const list = spec[key];
    if (!Array.isArray(list) || !list.length || new Set(list).size !== list.length ||
        list.some(value => !policy[key].includes(value))) reject(422, 'spec.enum', { path: key });
  }
  // Include optional notes, caller-supplied axes, and nested values in the text checks.
  const pending = [spec];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') scan(value, policy, 'spec');
    else if (value && typeof value === 'object') for (const field of Object.values(value)) pending.push(field);
  }
  return spec;
}

function style(text, policy) {
  const n = count(text);
  const sentences = text.split(/[。！？.!?]+/u).filter(s => s.trim()).length;
  const similes = (text.match(/仿佛|宛如|好像|犹如/gu) ?? []).length;
  return { sentence_length: n / Math.max(1,sentences) > policy.sentenceWarn,
    simile_density: similes * 100 / Math.max(n,1) > policy.similePer100 };
}

export function checkSections(value, policy) {
  const texts = {};
  for (const key of sections) {
    const text = value?.[key];
    if (typeof text !== 'string' || !text.trim()) reject(422, 'card.missing_section', { path: key });
    scan(text, policy, key);
    const actual = count(text);
    const [min,max] = policy.lengths[key];
    if (actual < min || actual > max) reject(422, 'card.section_length', { path: key, min, max, actual });
    texts[key] = text;
  }
  return { texts, warn: style(Object.values(texts).join('。'), policy) };
}

export function checkProse(text, policy) {
  if (typeof text !== 'string') reject(422, 'prose.invalid');
  const actual = count(text);
  if (actual < 1200 || actual > 1500)
    reject(422, 'verdict.len_over', { min:1200, max:1500, actual, direct_fail:actual>=1600 });
  scan(text, policy, 'prose');
  return { actual, warn: style(text, policy) };
}

export function parseArtifact(text, kind) {
  // Plain host prose makes no state changes. A structured artifact can propose events.
  if (kind === 'play' && !text.trimStart().startsWith('{')) return { text, events: [] };
  let data;
  try { data = JSON.parse(text); } catch { reject(422,'artifact.invalid_json'); }
  if (!object(data)) reject(422,'artifact.invalid_json');
  return data;
}
