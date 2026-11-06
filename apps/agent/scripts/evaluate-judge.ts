import {readFileSync,mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {z} from 'zod';
import {humanAnnotationSchema,judgeRubric} from '../src/evaluation/judge.js';
import {assertIndependentJudgeDatasets,loadJudgeDataset} from '../src/evaluation/judge-dataset.js';
import {runJudgeFixture} from '../src/evaluation/judge-fixture.js';
import {liveJudgeBudget,liveJudgeSettings,parseJudgeArguments,runJudgeLive} from '../src/evaluation/judge-live.js';
import {runtimeVersion} from '../src/runtime/governance/index.js';
const {annotationsPath,split,live,confirmedBudget}=parseJudgeArguments(process.argv.slice(2));
const fixture=(name:string)=>fileURLToPath(new URL(`../src/evaluation/fixtures/${name}.json`,import.meta.url));
const dev=loadJudgeDataset(fixture('judge-dev')),held=loadJudgeDataset(fixture('judge-held-out'));
assertIndependentJudgeDatasets(dev,held);
const dataset=split==='dev'?dev:held;
const annotations=annotationsPath?z.array(humanAnnotationSchema).parse(JSON.parse(readFileSync(annotationsPath,'utf8'))):[];
const abort=new AbortController(),cancel=()=>abort.abort(Error('EVAL_CANCELLED'));
process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
try{
 const settings=live?liveJudgeSettings():null;
 const budget=live?liveJudgeBudget(dataset.cases.length,confirmedBudget!):null;
 const result=live?await runJudgeLive(dataset,annotations,abort.signal,settings!,budget!):await runJudgeFixture(dataset,annotations,abort.signal);
 const report={schema:1,at:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim()!=='',runtimeVersion,piVersion:'1.5.0',provider:live?settings!.config.Provider:'local-synthetic-http',model:live?settings!.config.Model:'judge-fixture',rubric:judgeRubric,...result};
 const path=fileURLToPath(new URL(`../../../.local/evals/agent/judge-${live?'live-':''}${split}.json`,import.meta.url));
 mkdirSync(dirname(path),{recursive:true});writeFileSync(path+'.tmp',JSON.stringify(report,null,2)+'\n',{mode:0o600});renameSync(path+'.tmp',path);
 console.log(JSON.stringify({report:path,calls:result.calls,calibration:result.calibration,qualityValidated:false}));
 if(result.failures.length)process.exitCode=1;
}finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel)}
