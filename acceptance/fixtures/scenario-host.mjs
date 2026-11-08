// Additional synthetic positive/boundary artifacts; the original five-mode mock stays intact.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
let text='';
process.stdin.setEncoding('utf8');
for await(const part of process.stdin)text+=part;
const task=JSON.parse(text);
const cfg=process.env.SCENARIO ? JSON.parse(readFileSync(process.env.SCENARIO,'utf8')) : {};
const seen={kind:task.kind,rev_input_state:task.state??null,repair:!!task.correct};
if(process.env.OBSERVE)appendFileSync(process.env.OBSERVE,JSON.stringify(seen)+'\n');
if(cfg.delay)await new Promise(r=>setTimeout(r,cfg.delay));
if(cfg.stdoutProbe)process.stdout.write(cfg.stdoutProbe);
if(cfg.refuse){
  process.stderr.write('policy refusal '+(cfg.errorProbe??''));process.exitCode=1;
} else {
  let value;
  if(task.kind==='draft') {
    value=Object.fromEntries(Object.keys(task.limits).map(k=>[k,'合成文案']));
    if(cfg.missing)delete value.description;
    if(cfg.blank)value.scenario='  ';
    if(cfg.short && !task.correct)value.first_mes='短';
    if(cfg.failField)value.description='短';
  } else {
    const suffix=cfg.suffix??'';
    value={text:'文'.repeat(Math.max(0,(cfg.length??1200)-[...suffix].length))+suffix,events:cfg.events??[]};
  }
  mkdirSync('out',{recursive:true});
  writeFileSync('out/part-001.md',JSON.stringify(value));
  process.stdout.write('.'); // No response body on stdout.
}
