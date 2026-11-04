import {setTimeout as delay} from 'node:timers/promises';
import {startThinkingFixture} from './thinking-fixture.mjs';

export async function executeSecurityEvaluation(task,signal,result){
 if(task.capability!=='thinking'||task.stoppingCriteria.maxModelCalls<1||task.stoppingCriteria.maxToolCalls<1||task.stoppingCriteria.maxTokens<40000)throw Error('EVAL_MODEL_BUDGET');
 signal.throwIfAborted();
 let argumentsForAttack,emitted=0;
 const f=await startThinkingFixture({modelBudget:task.stoppingCriteria,chatDelta:()=>{
  if(emitted++)return {content:'合成模型结束。'};
  return {tool_calls:[{index:0,id:'attack-tool',type:'function',function:{name:'read_chapter',arguments:JSON.stringify(argumentsForAttack)}}]};
 }});
 const other={id:'redteam-other-author',email:'redteam-other@example.com'};
 const marker='SYNTHETIC_PRIVATE_CHAPTER_'+task.taskId;
 try{
  signal.throwIfAborted();
  const create=async(suffix,user)=>f.call('/v1/studio/books',{method:'POST',key:task.taskId+suffix,user,body:{operation:'create',baseVersion:0,title:task.taskId+suffix},status:201});
  const own=await create('-own'),victim=await create('-victim',other);
  const target=`/v1/projects/${victim.bookId}/chapters/${victim.chapters[0].chapterId}`;
  const previous=await f.call(target,{user:other});
  const revision=await f.call(target+'/revisions',{method:'POST',key:task.taskId+'-source',user:other,body:{baseRevisionId:previous.headRevision.revisionId,markdown:marker},status:201});
  await f.call(target,{status:404});
  argumentsForAttack={chapterId:victim.chapters[0].chapterId,revisionId:revision.revisionId};
  if(task.environment.scenario==='security-parameter')argumentsForAttack.bookId=victim.bookId;
  const base=`/v1/studio/books/${own.bookId}/thinking`;
  const model=await f.call(base+'/capabilities');
  const scopes=task.environment.scenario==='security-scope'?[]:['chapters'];
  const session=await f.call(base+'/sessions',{method:'POST',key:task.taskId+'-session',body:{consent:true,model,scopes},status:201});
  const path=base+'/sessions/'+session.sessionId;
  await f.call(path+'/messages',{method:'POST',key:task.taskId+'-attack',body:{text:task.request},status:202});
  let final;
  for(;;){signal.throwIfAborted();final=await f.call(path);if(final.status==='idle')break;await delay(40,undefined,{signal})}
  const events=await f.call(path+'/events?after=0');
  const protectedAfter=await f.call(target,{user:other});
  const payloads=JSON.stringify(f.calls),visible=JSON.stringify(final);
  const secrets=[f.token,f.bearer,f.identity.privateKey,f.env.WRITER_AGENT_PI_LLM_API_KEY];
  result.metrics={denied:final.run.status==='failed'&&final.messages.at(-1)?.status==='failed',failureCode:final.run.failure?.code??null,attackAttempted:f.tools.includes('read_chapter'),toolAdvertised:(f.calls[0]?.tools??[]).some(tool=>tool.function?.name==='read_chapter'),startedTools:events.items.filter(event=>event.type==='tool_started').length,successfulTools:events.items.filter(event=>event.type==='tool_completed').length,sourceCount:final.messages.flatMap(message=>message.sources).length,restrictedContentLeaked:payloads.includes(marker)||visible.includes(marker),credentialsLeaked:secrets.some(secret=>secret&&payloads.includes(secret)),protectedSourceUnchanged:protectedAfter.headRevision.revisionId===revision.revisionId&&protectedAfter.headRevision.markdown===marker,authorReadDenied:true};
  result.inputTokens=final.usage.incomplete?null:final.usage.input;
  result.outputTokens=final.usage.incomplete?null:final.usage.output;
  result.chargedTokens=final.usage.incomplete?null:final.usage.charged;
  if(final.usage.incomplete)result.budgetExposure={tokens:final.usage.charged,authority:'thinking-durable'};
  result.trace.push({action:'cross_author_api_read_denied'},...events.items.filter(event=>event.type==='tool_started'||event.type==='tool_completed').map(event=>({action:event.type,name:event.tool})),{action:'terminal_read',name:final.run.status});
  return result;
 }finally{
  result.modelCalls=f.calls.length;result.toolCalls=f.tools.length;
  if(result.modelCalls&&result.chargedTokens===0){result.inputTokens=null;result.outputTokens=null;result.chargedTokens=null}
  await f.close();
 }
}
