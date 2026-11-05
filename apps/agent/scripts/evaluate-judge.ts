import {readFileSync,mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {z} from 'zod';
import {humanAnnotationSchema,judgeRubric} from '../src/evaluation/judge.js';
import {assertIndependentJudgeDatasets,loadJudgeDataset} from '../src/evaluation/judge-dataset.js';
import {runJudgeFixture} from '../src/evaluation/judge-fixture.js';
import {runtimeVersion} from '../src/runtime/governance/index.js';
const args=process.argv.slice(2).filter(arg=>arg!=='--');
let annotationsPath:string|undefined,split:'dev'|'held-out'='dev';
for(const arg of args){
 if(arg.startsWith('--annotations=')&&annotationsPath===undefined)annotationsPath=arg.slice('--annotations='.length);
 else if(arg.startsWith('--split=')&&['dev','held-out'].includes(arg.slice(8)))split=arg.slice(8) as 'dev'|'held-out';
 else throw Error('Only --split=<dev|held-out> and --annotations=<local human annotations JSON> are supported; synthetic models only');
}
const fixture=(name:string)=>fileURLToPath(new URL(`../src/evaluation/fixtures/${name}.json`,import.meta.url));
const dev=loadJudgeDataset(fixture('judge-dev')),held=loadJudgeDataset(fixture('judge-held-out'));
assertIndependentJudgeDatasets(dev,held);
const dataset=split==='dev'?dev:held;
const annotations=annotationsPath?z.array(humanAnnotationSchema).parse(JSON.parse(readFileSync(annotationsPath,'utf8'))):[];
const abort=new AbortController(),cancel=()=>abort.abort(Error('EVAL_CANCELLED'));
process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
try{
 const result=await runJudgeFixture(dataset,annotations,abort.signal);
 const report={schema:1,at:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim()!=='',runtimeVersion,piVersion:'1.5.0',provider:'local-synthetic-http',model:'judge-fixture',rubric:judgeRubric,...result};
 const path=fileURLToPath(new URL(`../../../.local/evals/agent/judge-${split}.json`,import.meta.url));
 mkdirSync(dirname(path),{recursive:true});writeFileSync(path+'.tmp',JSON.stringify(report,null,2)+'\n',{mode:0o600});renameSync(path+'.tmp',path);
 console.log(JSON.stringify({report:path,calls:result.calls,calibration:result.calibration,qualityValidated:false}));
 if(result.failures.length)process.exitCode=1;
}finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel)}
