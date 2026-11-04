import {setTimeout as delay} from 'node:timers/promises';
import {startThinkingFixture} from './thinking-fixture.mjs';

// Observations come from the public Go API backed by the real Pi Durable process.
export async function executeThinkingEvaluation(task,signal,result){
 const recovery=task.environment.scenario==='thinking-recovery';
 if(task.capability!=='thinking')throw Error('EVAL_CAPABILITY_MISMATCH');
 if(task.stoppingCriteria.maxModelCalls<(recovery?2:1)||task.stoppingCriteria.maxTokens<40000)throw Error('EVAL_MODEL_BUDGET');
 signal.throwIfAborted();
 const f=await startThinkingFixture({modelBudget:task.stoppingCriteria,chatDelta:()=>({content:'合成候选建议，等待作者确认。'})});
 const wait=async(fn)=>{for(;;){signal.throwIfAborted();const value=await fn();if(value)return value;await delay(40,undefined,{signal})}};
 try{
  signal.throwIfAborted();
  const book=await f.call('/v1/studio/books',{method:'POST',key:task.taskId+'-book',body:{operation:'create',baseVersion:0,title:task.taskId},status:201});
  const base=`/v1/studio/books/${book.bookId}/thinking`;
  const model=await f.call(base+'/capabilities');
  const session=await f.call(base+'/sessions',{method:'POST',key:task.taskId+'-session',body:{consent:true,model,scopes:[]},status:201});
  const path=base+'/sessions/'+session.sessionId;
  f.config.hang=true;
  const input={method:'POST',key:task.taskId,body:{text:task.request},status:202};
  const accepted=await f.call(path+'/messages',input);
  await f.waitForProviderCall(0);signal.throwIfAborted();
  const replayed=await f.call(path+'/messages',input);
  result.trace.push({action:'provider_entered'});
  const before=await f.call(path);
  let interrupted;
  if(recovery){
   await f.stopAgent('SIGKILL');result.trace.push({action:'thinking_sigkill'});
   await f.restartAgent();signal.throwIfAborted();
   interrupted=await f.call(path);result.trace.push({action:'thinking_restarted'});
  }else{
   await f.call(path+'/cancel',{method:'POST',body:{}});
   interrupted=await f.call(path);result.trace.push({action:'cancel_acknowledged'});
  }
  result.metrics={sameReceipt:replayed.messageId===accepted.messageId,initialStatus:interrupted.run.status,initialMessageStatus:interrupted.messages.at(-1)?.status??null,automaticCalls:f.calls.length-1,unknownUsageRetained:before.usage.incomplete&&interrupted.usage.incomplete&&before.usage.charged>0&&interrupted.usage.charged>=before.usage.charged};
  f.config.hang=false;f.releaseProviders();
  if(recovery){
   const resume={method:'POST',key:task.taskId+'-resume',body:{runId:interrupted.run.runId,confirmAdditionalCost:true},status:202};
   await f.call(path+'/resume',resume);
   await wait(async()=>{const state=await f.call(path);return state.status==='idle'&&state});
   const calls=f.calls.length;
   await f.call(path+'/resume',resume);
   result.metrics.duplicateCalls=f.calls.length-calls;
   result.trace.push({action:'explicit_resume_replayed'});
  }else{
   await f.call(path+'/resume',{method:'POST',key:task.taskId+'-denied',body:{runId:interrupted.run.runId,confirmAdditionalCost:true},status:409});
   const calls=f.calls.length;
   await f.call(path+'/messages',{...input,status:409});
   result.metrics.duplicateCalls=f.calls.length-calls;
   // Read through Go/Pi after attempting to release the cancelled provider response.
   await f.call(path);result.trace.push({action:'provider_release_attempt_and_message_replay'});
  }
  await f.restartAPI();
  const final=await f.call(path);
  result.metrics={...result.metrics,finalStatus:final.run.status,finalMessageStatus:final.messages.at(-1)?.status??null,attempt:final.run.attempt,acceptedUsers:final.messages.filter(message=>message.role==='user').length,originalMessagePreserved:final.messages.some(message=>message.id===accepted.messageId&&message.role==='user'),unknownUsageRetained:result.metrics.unknownUsageRetained&&final.usage.incomplete&&final.usage.charged>=interrupted.usage.charged};
  result.inputTokens=final.usage.incomplete?null:final.usage.input;
  result.outputTokens=final.usage.incomplete?null:final.usage.output;
  result.chargedTokens=final.usage.incomplete?null:final.usage.charged;
  if(final.usage.incomplete)result.budgetExposure={tokens:final.usage.charged,authority:'thinking-durable'};
  result.trace.push({action:'go_restarted_terminal_read',name:final.run.status});
  return result;
 }finally{
  result.modelCalls=f.calls.length;result.toolCalls=f.tools.length;
  result.metrics.modelCalls=result.modelCalls;result.metrics.toolCalls=result.toolCalls;
  if(result.modelCalls&&result.chargedTokens===0){result.inputTokens=null;result.outputTokens=null;result.chargedTokens=null}
  await f.close();
 }
}
