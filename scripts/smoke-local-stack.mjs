import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {stripVTControlCharacters} from 'node:util'
import {createServer} from 'node:net'
import {mkdtemp,mkdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('..',import.meta.url))
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r))
const directory=await mkdtemp(join(tmpdir(),'writer-go-stack-'));await mkdir(join(directory,'harness'))
const child=spawn(process.execPath,[join(root,'scripts/dev-local-stack.mjs')],{cwd:root,env:{...process.env,FORCE_COLOR:'0',WRITER_AGENT_API_PORT:String(port),WRITER_AGENT_HARNESS_ROOT:join(directory,'harness'),WRITER_AGENT_STATE_DIR:join(directory,'state'),VITE_WRITER_AGENT_PROJECT_ID:'stack-smoke'},stdio:['ignore','pipe','pipe']})
let output='',webURL='';child.stdout.on('data',c=>{output+=c;const match=stripVTControlCharacters(output).match(/Local:\s+(http:\/\/127\.0\.0\.1:\d+)/);if(match)webURL=match[1]});child.stderr.on('data',c=>output+=c)
const exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})))
try{const deadline=Date.now()+30000;while(Date.now()<deadline){if(webURL){try{const r=await fetch(webURL+'/v1/projects/stack-smoke/workspace');if(r.status===200){assert.equal((await r.json()).project.projectId,'stack-smoke');break}}catch{}}
 if(child.exitCode!==null)throw Error(output);await new Promise(r=>setTimeout(r,100))}
 assert.ok(webURL,'Vite did not start: '+output);assert.equal((await fetch(webURL+'/v1/projects/stack-smoke/workspace')).status,200)
}finally{child.kill('SIGTERM');let timer;try{await Promise.race([exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Stack did not stop: '+output)),8000)})])}finally{clearTimeout(timer);await rm(directory,{recursive:true,force:true})}}
for(const url of [`http://127.0.0.1:${port}/healthz`,webURL]){let stopped=false;for(let i=0;i<30;i++){try{await fetch(url,{signal:AbortSignal.timeout(100)})}catch{stopped=true;break};await new Promise(r=>setTimeout(r,100))};assert.equal(stopped,true,'Orphan server: '+url)}
console.log('Default dev:local started Go + Vite, proxied Workspace, and stopped both process groups.')
