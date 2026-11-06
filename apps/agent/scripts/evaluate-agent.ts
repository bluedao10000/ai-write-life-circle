import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadEvaluationSplit,selectEvaluationDataset,assertIndependentDatasets} from '../src/evaluation/dataset.js';
import {categories,type Category} from '../src/evaluation/task-schema.js';
import {runEvaluation} from '../src/evaluation/runner.js';
import {executeEvaluation} from '../src/evaluation/executors.js';
import {writeReport} from '../src/evaluation/report.js';
const args=process.argv.slice(2).filter(arg=>arg!=='--');
for(const arg of args)if(!/^--(?:category|split)=/.test(arg))throw Error('Unsupported option; this runner executes synthetic fixtures only');
const category=args.find(arg=>arg.startsWith('--category='))?.slice(11);
if(category&&!categories.includes(category as Category))throw Error('Unknown evaluation category');
const split=args.find(arg=>arg.startsWith('--split='))?.slice(8)??'dev';
if(!['dev','held-out'].includes(split))throw Error('Unknown dataset split');
const fixtureDirectory=fileURLToPath(new URL('../src/evaluation/fixtures/datasets/',import.meta.url));
const dev=loadEvaluationSplit(fixtureDirectory,'dev'),held=loadEvaluationSplit(fixtureDirectory,'held-out');assertIndependentDatasets(dev,held);
const data=selectEvaluationDataset(split==='dev'?dev:held,category as Category|undefined);
if(!data.tasks.length)throw Error('Empty evaluation selection');
const abort=new AbortController();const cancel=()=>abort.abort(Error('EVAL_CANCELLED'));process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
try{
 const result=await runEvaluation(data.tasks,executeEvaluation,abort.signal);
 const path=resolve(fileURLToPath(new URL('../../../.local/evals/agent/',import.meta.url)),`${split}-${category??'all'}.json`);
 writeReport(path,{version:data.version,split:data.split,datasetVersions:data.datasetVersions},result);console.log(JSON.stringify({report:path,metrics:result.metrics}));
 if(result.results.some(task=>!task.passed))process.exitCode=1;
}finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel)}
