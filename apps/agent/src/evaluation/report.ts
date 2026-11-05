import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {dirname} from 'node:path';
import {runtimeVersion} from '../runtime/governance/index.js';
import type {runEvaluation} from './runner.js';
export function writeReport(path:string,dataset:{version:string;split:string},result:Awaited<ReturnType<typeof runEvaluation>>){
 const git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8'}).trim();
const report={schema:1,at:new Date().toISOString(),commit:git('rev-parse','HEAD'),dirty:git('status','--porcelain','--untracked-files=normal').split('\n').some(line=>line&&!line.endsWith('artifacts/')),runtimeVersion,piVersion:'1.5.0',provider:'local-synthetic-http',model:'synthetic-fixtures',models:[...new Set(result.results.map(r=>r.observation?.metrics.model).filter((value):value is string=>typeof value==='string').concat(result.results.some(r=>r.observation?.modelCalls&&!r.observation.metrics.model)?['fixture']:[]))],promptVersions:{thinking:'thinking-v1',memoryExtraction:'memory-extraction-v3',workerFixture:'worker-eval-json-v1',discussionFixture:'discussion-eval-v1'},toolSchemaVersions:{thinking:'story-tools-v2',denialFixture:'read-private-v1'},dataset,mode:'deterministic-and-mock',realLLMCalled:false,qualityValidated:false,configuration:{concurrency:1},...result};
 mkdirSync(dirname(path),{recursive:true});writeFileSync(path+'.tmp',JSON.stringify(report,null,2)+'\n',{mode:0o600});renameSync(path+'.tmp',path);return report;
}
