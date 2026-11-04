import {readFileSync,mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {z} from 'zod';
import {judgeCaseSchema,humanAnnotationSchema,judgeRubric} from '../src/evaluation/judge.js';
import {runJudgeFixture} from '../src/evaluation/judge-fixture.js';
import {runtimeVersion} from '../src/runtime/governance/index.js';
const args=process.argv.slice(2).filter(arg=>arg!=='--');
if(args.length>1||args.some(arg=>!arg.startsWith('--annotations=')))throw Error('Only --annotations=<local human annotations JSON> is supported; synthetic models only');
const cases=z.array(judgeCaseSchema).parse(JSON.parse(readFileSync(new URL('../src/evaluation/fixtures/judge-dev.json',import.meta.url),'utf8')));
const annotations=args[0]?z.array(humanAnnotationSchema).parse(JSON.parse(readFileSync(args[0].slice('--annotations='.length),'utf8'))):[];
const abort=new AbortController(),cancel=()=>abort.abort(Error('EVAL_CANCELLED'));
process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
try{
 const result=await runJudgeFixture(cases,annotations,abort.signal);
 const report={schema:1,at:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim()!=='',runtimeVersion,piVersion:'1.5.0',provider:'local-synthetic-http',model:'judge-fixture',rubric:judgeRubric,...result};
 const path=fileURLToPath(new URL('../../../.local/evals/agent/judge-dev.json',import.meta.url));
 mkdirSync(dirname(path),{recursive:true});writeFileSync(path+'.tmp',JSON.stringify(report,null,2)+'\n',{mode:0o600});renameSync(path+'.tmp',path);
 console.log(JSON.stringify({report:path,calls:result.calls,calibration:result.calibration,qualityValidated:false}));
 if(result.failures.length)process.exitCode=1;
}finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel)}
