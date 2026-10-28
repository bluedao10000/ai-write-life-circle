// Explicit opt-in; only synthetic discussion is sent. No real manuscript/state is loaded.
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {PiHost} from '../apps/agent/dist/runtime/pi-host.js';
import {Store} from '../apps/agent/dist/sessions/store.js';
if(!process.argv.includes('--confirm-synthetic')) throw Error('Use --confirm-synthetic; this makes at most one paid call per configured model.');
for(const name of ['DEEPSEEK','OPENAI']) {
 const key=process.env[`WRITER_AGENT_CHAT_${name}_KEY`];
 const endpoint=process.env[`WRITER_AGENT_CHAT_${name}_URL`];
 const model=process.env[`WRITER_AGENT_CHAT_${name}_MODEL`];
 if(!key||!endpoint||!model){console.log(JSON.stringify({model:name,status:'UNVERIFIED',reason:'Explicit smoke configuration absent'}));continue}
 const u=new URL(endpoint);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw Error('INVALID_SMOKE_URL');
 const state=await mkdtemp(join(tmpdir(),'story2u-chat-smoke-'));const id='th-'+randomUUID();
 const selected={provider:name.toLowerCase(),model,endpoint,protocol:'thinking-v1',tokenParameter:name==='OPENAI'?'max_completion_tokens':'max_tokens',limits:{maxTurnsPerRequest:2,maxToolCalls:1,maxInputTokens:16000,maxOutputTokens:name==='OPENAI'?8192:4096,maxSessionTokens:32000,maxConcurrentSessions:1,maxDurationMs:120000,maxToolResultBytes:1024}};
 const story=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({sessionId:id,authorId:'synthetic',bookId:'synthetic',model:selected,scopes:[]}))});
 await new Promise(r=>story.listen(0,'127.0.0.1',r));
 const host=new PiHost({state,port:1,version:'live-smoke',token:'synthetic',key,model:selected,storyOrigin:`http://127.0.0.1:${story.address().port}`},new Store(state));
 try {
  await host.create({sessionId:id,authorId:'synthetic',bookId:'synthetic',createdAt:new Date().toISOString(),model:selected,scopes:[],capability:'synthetic'});
  await host.accept(id,{text:'我想以张居正为原型写平行宇宙科幻小说，怎样通过有代价的选择讨论好人品？请简短提出三个不同视角。'},'synthetic','synthetic');
  await host.active.get(id)?.done;const result=host.get(id).view.messages.at(-1);
  console.log(JSON.stringify({model:name,status:result.status,code:result.errorCode,characters:result.text.length,usage:host.get(id).view.usage}));
  if(result.status!=='completed')process.exitCode=1;
 } finally {await host.close();story.closeAllConnections();await new Promise(r=>story.close(r));await rm(state,{recursive:true,force:true})}
}
