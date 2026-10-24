import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const supplied=process.argv.slice(2);let directory;
try{
 let paths=supplied;
 if(paths.length===0){
  directory=await mkdtemp(join(tmpdir(),'pi-knowledge-parity-'));paths=[];
  for(const kind of ['go','pi']){const output=join(directory,kind+'.json');paths.push(output);await new Promise((resolve,reject)=>{const p=spawn(process.execPath,[new URL('./eval-knowledge.mjs',import.meta.url).pathname,...(kind==='pi'?['--pi']:[])],{env:{...process.env,WRITER_AGENT_KNOWLEDGE_EVAL_OUTPUT:output},stdio:['ignore','ignore','inherit'],timeout:180000});p.once('error',reject);p.once('exit',code=>code===0?resolve():reject(Error('Knowledge '+kind+' fixture failed')))})}
 }
 assert.equal(paths.length,2,'Pass Go/Pi report JSON paths or no arguments');
 const reports=await Promise.all(paths.map(async p=>JSON.parse(await readFile(p,'utf8'))));
 for(const r of reports){assert.equal(r.mode,'http-mock-engineering');assert.equal(r.engineeringFailures,0);assert.equal(r.cases,24);assert.equal(r.qualityValidated,false)}
 const shape=r=>r.results.map(c=>({id:c.id,execution:c.execution,remoteCalls:c.remoteCalls,jobs:c.engineeringJobs.map(j=>Object.fromEntries(['status','failureCode','usage','attempts','modelCalls','usageIncomplete'].filter(k=>k in j).map(k=>[k,j[k]])))}));
 assert.deepEqual(shape(reports[0]),shape(reports[1]));
 console.log('PASS: Go/Pi Knowledge parity across 24 identical synthetic scenarios: domain status, failure code, usage, attempts and call counts. No paid model.');
}finally{if(directory)await rm(directory,{recursive:true,force:true})}
