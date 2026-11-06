import {chmodSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {evaluateMemoryQuality,memoryQualityAnnotationSchema,memoryQualityReviewTemplate,memoryQualityRubric,parseMemoryQualityDataset} from '../src/evaluation/memory-quality.js';

function options(raw:string[]){
 const args=raw.filter(value=>value!=='--'),out:Record<string,string>={};
 for(const arg of args){
  const match=/^--(cases|annotations|template)=([^=].*)$/.exec(arg);
  if(!match||out[match[1]!])throw Error('Use --cases=<absolute path> with exactly one of --annotations=<absolute path> or --template=<absolute path>');
  out[match[1]!]=match[2]!;
 }
 if(!out.cases||Boolean(out.annotations)===Boolean(out.template))throw Error('Use --cases=<absolute path> with exactly one of --annotations=<absolute path> or --template=<absolute path>');
 for(const path of Object.values(out))if(!isAbsolute(path))throw Error('MEMORY_QUALITY_PATH_MUST_BE_ABSOLUTE');
 return out as {cases:string;annotations?:string;template?:string};
}
function writePrivate(path:string,value:unknown){
 mkdirSync(dirname(path),{recursive:true});
 const temp=path+'.tmp';
 writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});
 chmodSync(temp,0o600);renameSync(temp,path);chmodSync(path,0o600);
}

const cli=options(process.argv.slice(2));
const dataset=parseMemoryQualityDataset(JSON.parse(readFileSync(cli.cases,'utf8')));
if(cli.template){
 writePrivate(cli.template,memoryQualityReviewTemplate(dataset));
 console.log(JSON.stringify({template:cli.template,datasetVersion:dataset.version,cases:dataset.cases.length,rubricVersion:memoryQualityRubric.version}));
}else{
 const annotations=z.array(memoryQualityAnnotationSchema).parse(JSON.parse(readFileSync(cli.annotations!,'utf8')));
 const metrics=evaluateMemoryQuality(dataset,annotations);
 const report={
  schemaVersion:1,at:new Date().toISOString(),mode:'offline-human-review',realLLMCalled:false,qualityValidated:false,
  originDeclaration:'Caller supplied; the evaluator does not independently verify extraction origin.',
  ...metrics,qualitySuccessRate:metrics.qualitySuccessRate.value,
  qualitySuccessCounts:{accepted:metrics.qualitySuccessRate.numerator,reviewed:metrics.qualitySuccessRate.denominator},
  reportPath:fileURLToPath(new URL(`../../../.local/evals/agent/memory-quality-${dataset.split}.json`,import.meta.url)),
 };
 writePrivate(report.reportPath,report);
 console.log(JSON.stringify({report:report.reportPath,split:dataset.split,inputOrigin:dataset.origin,reviewedCases:metrics.reviewedCases,annotations:metrics.annotations,qualitySuccessRate:report.qualitySuccessRate}));
}
