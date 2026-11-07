import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, readdir, readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { reject } from './fault.mjs';

const diagnosticsLimit = 8192;
const artifactLimit = 1024 * 1024;

async function readParts(dir, started) {
  const out = join(dir, 'out');
  const folder = await lstat(out).catch(() => null);
  if (!folder?.isDirectory()) reject(502, 'host.empty');
  const parts = (await readdir(out)).filter(name => /^part-\d+\.md$/.test(name))
    .map(name => ({ name, seq: Number(name.slice(5, -3)) })).sort((a, b) => a.seq - b.seq);
  if (!parts.length) reject(502, 'host.empty');
  let size = 0;
  const texts = [];
  for (const [i, part] of parts.entries()) {
    const file = join(out, part.name);
    const stat = await lstat(file);
    if (!stat.isFile() || Math.ceil(stat.mtimeMs) < started || part.seq === parts[i-1]?.seq)
      reject(502, 'host.invalid_artifact');
    size += stat.size;
    if (size > artifactLimit) reject(502, 'host.artifact_limit');
    const raw = await readFile(file);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
    catch { reject(502, 'host.encoding'); }
    if (i === 0 && !text.trim()) reject(502, 'host.empty');
    texts.push(text);
  }
  return texts.join('');
}

// A prepared worker already owns a new job directory and can receive stdin exactly once.
export async function prepareHost({ root, entry, profile = 'default', env = {}, timeoutMs = 480000 }) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(root, 'work-'));
  const child = spawn(process.execPath, [resolve(entry), profile, '-'], {
    cwd: dir, shell: false, stdio: ['pipe', 'ignore', 'pipe'],
    env: { PATH: process.env.PATH, ...env, PROFILE: profile }
  });
  let diagnostic = Buffer.alloc(0);
  child.stderr.on('data', data => {
    if (diagnostic.length < diagnosticsLimit)
      diagnostic = Buffer.concat([diagnostic, data.subarray(0, diagnosticsLimit - diagnostic.length)]);
  });
  child.stdin.on('error', () => {});
  let spawnError = false;
  const exit = new Promise(resolveExit => {
    child.once('error', () => { spawnError = true; });
    child.once('close', code => resolveExit(code));
  });
  let used = false;
  const dispose = async () => {
    child.kill('SIGKILL');
    await exit;
    await rm(dir, { recursive: true, force: true });
  };
  return {
    dispose,
    async run(taskText, { signal } = {}) {
      if (used) reject(500, 'host.already_used');
      used = true;
      const started = Date.now();
      const kill = () => child.kill('SIGKILL');
      let expired = false;
      const timer = setTimeout(() => { expired = true; kill(); }, timeoutMs);
      signal?.addEventListener('abort', kill, { once: true });
      try {
        if (signal?.aborted) kill();
        else child.stdin.end(taskText, 'utf8');
        const code = await exit;
        if (expired || signal?.aborted) reject(504, 'host.timeout');
        const stderr = diagnostic.toString('utf8');
        if (/policy refusal|content.filter|策略拒绝/i.test(stderr)) reject(502, 'host.refused');
        if (code !== 0 || spawnError) {
          if (/auth|balance|quota|鉴权|余额/i.test(stderr)) reject(502, 'host.unavailable');
          if (/timeout|connect|超时|连接/i.test(stderr)) reject(502, 'host.transport');
          reject(502, 'host.failed');
        }
        return { text: await readParts(dir, started), attempts: 1, ms: Date.now() - started,
          usage: { input_tokens: null, output_tokens: null } };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', kill);
        await rm(dir, { recursive: true, force: true });
      }
    }
  };
}

export async function runHost(config, taskText, options) {
  return (await prepareHost(config)).run(taskText, options);
}
