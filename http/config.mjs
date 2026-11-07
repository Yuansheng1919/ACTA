import { readFileSync } from 'node:fs';
import { sections, object, examplePolicy } from '../engine/gates.mjs';
import { hash } from '../store/commit.mjs';
import { Fault } from '../engine/fault.mjs';

function invalid(field) { throw new Error('config.invalid.' + field); }

function readConfig(file, field) {
  try {
    // TextDecoder consumes a leading UTF-8 BOM and rejects malformed UTF-8.
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file)));
  } catch { invalid(field); }
}

function checkedTokens(file) {
  const tokens = readConfig(file, 'tokens');
  if (!Array.isArray(tokens) || tokens.some(v => typeof v !== 'string' || !v || /\s/u.test(v)))
    invalid('tokens');
  return tokens.map(hash);
}

export function validatePolicy(p) {
  if (!object(p) || typeof p.version !== 'string' || !p.version.trim()) invalid('policy.version');
  for (const field of ['locations','phases','blocked','templates']) {
    if (!Array.isArray(p[field]) || p[field].some(value => typeof value !== 'string' || !value.trim()))
      invalid('policy.' + field);
  }
  if (!p.locations.length || new Set(p.locations).size !== p.locations.length ||
      p.phases.length !== 2 || new Set(p.phases).size !== 2) invalid('policy.enums');
  for (const field of sections) {
    const range = p.lengths?.[field];
    if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger) ||
        range[0] < 1 || range[1] < range[0]) invalid('policy.lengths.' + field);
  }
  for (const field of ['sentenceWarn','similePer100'])
    if (!Number.isFinite(p[field]) || p[field] < 0) invalid('policy.' + field);
  try { for (const pattern of p.templates) new RegExp(pattern, 'iu'); }
  catch { invalid('policy.templates'); }
  return p;
}

export function loadConfig(env) {
  if (!env.ACTA_DATA?.trim()) invalid('data');
  if (!env.ACTA_TOKEN_FILE?.trim()) invalid('tokens');
  if (!env.ACTA_HMAC_KEY?.trim()) invalid('hmac');
  if (env.ACTA_KEY_VERSION !== undefined && !env.ACTA_KEY_VERSION.trim()) invalid('key_version');
  const initial = checkedTokens(env.ACTA_TOKEN_FILE);
  if (!initial.length) invalid('tokens');
  const policy = validatePolicy(env.ACTA_POLICY === undefined ? examplePolicy : readConfig(env.ACTA_POLICY,'policy'));
  return {
    root: env.ACTA_DATA, hmacKey: env.ACTA_HMAC_KEY, keyVersion: env.ACTA_KEY_VERSION ?? '1', policy,
    credentials() {
      // Keep next-request revocation. A corrupt replacement fails closed until corrected.
      try { return checkedTokens(env.ACTA_TOKEN_FILE); }
      catch { throw new Fault(503, 'auth.config_unavailable'); }
    }
  };
}
