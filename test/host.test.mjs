import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHost, prepareHost } from '../engine/host.mjs';

const entry = fileURLToPath(new URL('../mock/fake-host.mjs', import.meta.url));
test('stock host contract: five modes, single-use warm worker and cleanup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acta-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [mode, code] of [['ok',null],['empty','host.empty'],['refuse','host.refused'],
    ['slow','host.timeout'],['dirty',null]]) {
    const worker = await prepareHost({ root, entry, env: { HOST_MODE: mode }, timeoutMs: mode === 'slow' ? 200 : 5000 });
    if (code) await assert.rejects(worker.run('合成'), { code });
    else assert.match((await worker.run('合成')).text, mode === 'ok' ? /占位内容/ : /校服/);
    await assert.rejects(worker.run('again'), { code: 'host.already_used' });
    assert.deepEqual(await readdir(root), []);
  }
});
test('artifact order, empty first part, stale artifact and nonzero exit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acta-parts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const program = join(root, 'parts.mjs');
  await writeFile(program, `import fs from 'node:fs';
    for await(const data of process.stdin) {}
    fs.mkdirSync('out'); fs.writeFileSync('out/part-10.md','后');
    fs.writeFileSync('out/part-2.md',process.env.MODE==='blank'?' ':'前');
    if(process.env.MODE==='stale')fs.utimesSync('out/part-2.md',1,1);
    if(process.env.MODE==='bad')process.exitCode=1;`);
  const run = MODE => runHost({ root, entry: program, env: { MODE } }, 'test');
  assert.equal((await run('ok')).text, '前后');
  for(const [mode,code] of [['blank','host.empty'],['stale','host.invalid_artifact'],['bad','host.failed']])
    await assert.rejects(run(mode), { code });
});
