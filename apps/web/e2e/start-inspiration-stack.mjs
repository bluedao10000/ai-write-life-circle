import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {startThinkingFixture, seedThinkingBook} from '../../../scripts/lib/thinking-fixture.mjs';
const f=await startThinkingFixture({chatModels:true});await seedThinkingBook(f);
// Local test-only proxy generates per-request signed identities. Nothing reaches production.
const proxy=createServer(async(req,res)=>{
  try {
    const chunks=[];for await(const chunk of req) chunks.push(chunk);
    const headers=new Headers();for(const [k,v] of Object.entries(req.headers)) if(v && !['host','connection','content-length','authorization'].includes(k)) headers.set(k,Array.isArray(v)?v.join(','):v);
    headers.set('Authorization','Bearer '+f.bearer);
    for(const [k,v] of Object.entries(f.identity.headers(req.method,req.url))) headers.set(k,v);
    const result=await fetch(f.api+req.url,{method:req.method,headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})});
    res.writeHead(result.status,{'Content-Type':result.headers.get('content-type')??'application/json'});res.end(Buffer.from(await result.arrayBuffer()));
  }catch {res.writeHead(502);res.end('{}')}
});await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
const vite=spawn('pnpm',['exec','vite','--host','127.0.0.1','--port','5191'],{stdio:'inherit',env:{...process.env,VITE_WRITER_AGENT_MODE:'api',VITE_WRITER_AGENT_AUTH:'',WRITER_AGENT_API_TARGET:`http://127.0.0.1:${proxy.address().port}`}});
let closing=false;async function close(){if(closing)return;closing=true;vite.kill('SIGTERM');proxy.closeAllConnections();proxy.close();await f.close();process.exit(0)}
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>void close());vite.once('exit',()=>void close());
