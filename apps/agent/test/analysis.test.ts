import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {AgentTask} from '@writer-agent/contracts';
import {ModelGateway,GatewayError} from '../src/runtime/model-gateway.js';
import {executeAnalysis,validateAnalysis} from '../src/agents/analysis/executor.js';
import {executionContract,strategy,synthesisOutputSchemaVersion,validateAnalysisPrompt} from '../src/agents/analysis/prompt.js';

const task=(outputSchemaVersion:AgentTask['outputSchemaVersion']):AgentTask=>({kind:'novel.analyze',strategyVersion:strategy,outputSchemaVersion,request:{system:'Go prompt',schemaName:'novel_analysis'}} as AgentTask);
const gateway=(text:string)=>({validate(){},execute:async()=>({text,usage:null})} as unknown as ModelGateway);

test('Analysis prompt accepts both phases and rejects other strategies',()=>{
 assert.doesNotThrow(()=>validateAnalysisPrompt(task('novel-analysis-candidates-v1')));
 assert.doesNotThrow(()=>validateAnalysisPrompt(task(synthesisOutputSchemaVersion)));
 for(const change of [{kind:'knowledge.extract'},{strategyVersion:'next-strategy'},{outputSchemaVersion:'next-schema'}])assert.throws(()=>validateAnalysisPrompt({...task('novel-analysis-candidates-v1'),...change} as AgentTask),/AGENT_CONFIG_CHANGED/);
 assert.match(executionContract,/^sha256:[a-f0-9]{64}$/);
});

test('Analysis executor accepts chapter candidates and rejects malformed output',async()=>{
 const chapter={findings:[{kind:'character',title:'身份',statement:'林舟是医师。',confidence:0.8,entityNames:['林舟'],evidence:[{chapterId:'CH-000001',quote:'林舟是医师。'}]}],entities:[{kind:'character',name:'林舟'}]};
 assert.ok((await executeAnalysis(task('novel-analysis-candidates-v1'),gateway(JSON.stringify(chapter)),new AbortController().signal)).text);
 await assert.rejects(executeAnalysis(task('novel-analysis-candidates-v1'),gateway(JSON.stringify({...chapter,findings:[{...chapter.findings[0],confidence:2}]})),new AbortController().signal),(e:unknown)=>e instanceof GatewayError&&e.code==='LLM_INVALID_OUTPUT');
 await assert.rejects(executeAnalysis(task('novel-analysis-candidates-v1'),gateway('not json'),new AbortController().signal),(e:unknown)=>e instanceof GatewayError&&e.code==='LLM_INVALID_OUTPUT');
});

test('Synthesis executor requires the empty entities array Go requests',async()=>{
 const finding={kind:'conflict',title:'时间矛盾',statement:'同一事件出现在两章之前。',confidence:0.6,evidence:[{chapterId:'CH-000001',quote:'三年前'}]};
 await assert.rejects(executeAnalysis(task(synthesisOutputSchemaVersion),gateway(JSON.stringify({findings:[finding]})),new AbortController().signal),(e:unknown)=>e instanceof GatewayError&&e.code==='LLM_INVALID_OUTPUT');
 const response=await executeAnalysis(task(synthesisOutputSchemaVersion),gateway(JSON.stringify({findings:[finding],entities:[]})),new AbortController().signal);
 assert.match(response.text,/conflict/);
 await assert.rejects(executeAnalysis(task(synthesisOutputSchemaVersion),gateway(JSON.stringify({findings:[{...finding,kind:'character'}],entities:[]})),new AbortController().signal),(e:unknown)=>e instanceof GatewayError&&e.code==='LLM_INVALID_OUTPUT');
});
