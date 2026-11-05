import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {AgentTask} from '@writer-agent/contracts';
import {executeMemory,memoryConsolidationStrategy,validateMemory} from '../src/agents/memory/executor.js';
import {GatewayError} from '../src/runtime/model-gateway.js';
import {definition} from '../src/runtime/governance/runtime.js';

function task():AgentTask{
 return {
  taskId:randomUUID(),kind:'memory.consolidate',bookId:'book',authorId:'author',leaseToken:randomUUID(),executorEpoch:1,attempt:1,
  deadline:new Date(Date.now()+30000).toISOString(),strategyVersion:memoryConsolidationStrategy,revisionId:'',
  contentHash:'',inputHash:'sha256:'+'a'.repeat(64),model:{provider:'fixture',model:'fixture',endpoint:'http://127.0.0.1:1',execution:'local'},
  configFingerprint:'fixture',outputSchemaVersion:'memory-candidate-v1',reservedTokens:12000,budgetDay:'2026-11-05',consent:{backgroundMemoryConsolidation:true},
  request:{system:'Consolidate bounded task evidence.',input:'{}',schemaName:'memory_consolidation',schema:{type:'object'}},
 };
}
function gateway(text:string){
 return {
  validate:()=>undefined,
  execute:async()=>({text,usage:{inputTokens:100,outputTokens:30},modelCalls:1}),
 };
}

test('memory consolidation is a governed one-call Worker task',()=>{
 const value=definition('memory.consolidate');
 const extraction=definition('memory.extract.v3');
 assert.equal(value.mode,'go-task');
 assert.equal(value.tools,'none');
 assert.equal(value.modelCalls,1);
 assert.equal(value.output,'memory-candidate-v1');
 assert.equal(extraction.mode,'durable');
 assert.equal(extraction.tools,'none');
 assert.equal(extraction.output,'memory-candidate-v3');
 assert.doesNotThrow(()=>validateMemory(task(),gateway('') as never));
 for(const change of [{strategyVersion:'other'},{request:{...task().request,schemaName:'other'}},{request:{...task().request,schema:undefined}}]){
  assert.throws(()=>validateMemory({...task(),...change} as AgentTask,gateway('') as never),(error)=>error instanceof GatewayError&&error.code==='AGENT_CONFIG_CHANGED');
 }
});

test('memory output is exact, bounded and may decline to create a candidate',async()=>{
 const valid=[
  '{"content":null,"taskIds":[],"relations":[]}',
  '{"content":"先核对来源，再整理可复用的操作经验。","taskIds":["task-a","task-b"],"relations":[{"memoryId":"pm-1","kind":"refinement","reason":"补充了来源核对步骤。"}]}',
 ];
 for(const text of valid)assert.equal((await executeMemory(task(),gateway(text) as never,new AbortController().signal)).text,text);
 const invalid=[
  'not json',
  '{"content":"x","taskIds":[],"relations":[]}',
  '{"content":null,"taskIds":["task-a"],"relations":[]}',
  '{"content":"x","taskIds":["task-a","task-a"],"relations":[]}',
  '{"content":"x","taskIds":["task-a","task-b"],"relations":[{"memoryId":"pm-1","kind":"replace","reason":"x"}]}',
  '{"content":"x","taskIds":["task-a","task-b"],"relations":[],"extra":true}',
 ];
 for(const text of invalid)await assert.rejects(()=>executeMemory(task(),gateway(text) as never,new AbortController().signal),(error)=>error instanceof GatewayError&&error.code==='LLM_INVALID_OUTPUT');
});
