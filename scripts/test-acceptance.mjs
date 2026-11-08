// Run the five-PR stack against the owner's public fixtures without switching branches or fetching.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const inputRef='d9e18d247f0097ea387f5de0c44b37219a33f9e9';
const execGit=(args)=>execFileSync('git',args,{cwd:root,stdio:['ignore','pipe','pipe']});
let folder=resolve(process.env.ACTA_ACCEPTANCE_DIR??join(root,'acceptance'));
let temp;
try {
  if(!process.env.ACTA_ACCEPTANCE_DIR && !existsSync(join(folder,'samples'))) {
    const members=execGit(['ls-tree','--name-only','-rz',inputRef,'acceptance/samples','acceptance/policy-sample.json'])
      .toString('utf8').split('\0').filter(Boolean);
    temp=mkdtempSync(join(tmpdir(),'acta-fixtures-'));folder=join(temp,'acceptance');
    for(const path of members) {
      const dest=join(temp,path);
      mkdirSync(dirname(dest),{recursive:true});
      writeFileSync(dest,execGit(['show',inputRef+':'+path]));
    }
  }
  const files=readdirSync(join(folder,'samples'));
  if(!existsSync(join(folder,'policy-sample.json')) || files.filter(f=>f.endsWith('.png')).length!==5 ||
      files.filter(f=>f.endsWith('.json')).length!==5)throw Error('incomplete samples');
  const suite=readdirSync(join(root,'test')).filter(f=>f.endsWith('.test.mjs')).sort().map(f=>join('test',f));
  const child=spawnSync(process.execPath,['--test',...suite],{cwd:root,stdio:'inherit',
    env:{...process.env,ACTA_ACCEPTANCE_DIR:folder}});
  process.exitCode=child.status??1;
} catch {
  console.error('Acceptance inputs unavailable. Provide ACTA_ACCEPTANCE_DIR or fetch the repository main branch containing d9e18d2.');
  process.exitCode=1;
} finally {if(temp)rmSync(temp,{recursive:true,force:true});}
