import test from 'node:test';
import assert from 'node:assert/strict';
import {Type} from 'typebox';
import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';
import {ModelRequestGate,executionContext,definition,governanceMetrics} from '../src/runtime/governance/runtime.js';
import {governTool,type ToolPolicy} from '../src/runtime/governance/tool-gateway.js';
import {tools,type StoryExecution} from '../src/tools/registry.js';
import type {Config} from '../src/config.js';
const context=(signal=new AbortController().signal)=>executionContext({executionId:'execution',traceId:'trace',role:'thinking',authorizationVersion:1,scopes:['creative'],deadline:Date.now()+10000,signal});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return {promise,resolve}};

test('model transport waits for durable reservation and refuses concurrent preparation and replay',async()=>{
 const hold=deferred(),entered=deferred();let sent=0;
 const gate=new ModelRequestGate(context(),{authorize:async()=>{}});
 const transport=gate.transport(async()=>{sent++;return new Response('{}')});
 await assert.rejects(transport('http://example.invalid'),/RESERVATION_REQUIRED/);
 const preparing=gate.prepare({reserve:async()=>{entered.resolve();await hold.promise}});await entered.promise;
 await assert.rejects(transport('http://example.invalid'),/RESERVATION_REQUIRED/);
 await assert.rejects(gate.prepare({reserve:async()=>{}}),/REPLAY/);
 assert.equal(sent,0);hold.resolve();await preparing;await transport('http://example.invalid');
 await assert.rejects(transport('http://example.invalid'),/RESERVATION_REQUIRED/);assert.equal(sent,1);
});

test('authorization denial, persistence failure and cancellation never send a model request',async()=>{
 for(const failure of ['authorization','persistence','cancel']){
  let sent=0,reserved=0;const abort=new AbortController();
  const gate=new ModelRequestGate(context(abort.signal),{authorize:async()=>{if(failure==='authorization')throw Error('AUTHORIZATION_REVOKED')}});
  await assert.rejects(gate.prepare({reserve:async()=>{reserved++;if(failure==='persistence')throw Error('SQLITE_WRITE_FAILED');abort.abort(Error('cancelled'))}}));
  await assert.rejects(gate.transport(async()=>{sent++;return new Response('{}')})('http://example.invalid'));
  assert.equal(sent,0);assert.equal(reserved,failure==='authorization'?0:1);
 }
});

test('tool gateway rejects scope and schema expansion and propagates cancellation before publishing results',async()=>{
 let calls=0;const abort=new AbortController();
 const policy:ToolPolicy={name:'lookup',risk:'read',replay:'safe',requiredScopes:['creative'],maxInputBytes:100,maxOutputBytes:100,timeoutMs:1000,idempotencyRequired:false};
 const tool=governTool({name:'lookup',description:'bounded lookup',parameters:Type.Object({query:Type.String()},{additionalProperties:false}),replay:'safe',execute:async()=>{calls++;abort.abort(Error('revoked'));return {output:[{type:'text',text:'secret'}]}}},policy,context(abort.signal),{authorize:async()=>{}});
 await assert.rejects(tool.execute({query:'x',bookId:'other'},{} as never,BACKGROUND_CONTEXT),/TOOL_EXECUTION_FAILED/);assert.equal(calls,0);
 await assert.rejects(tool.execute({query:'x'},{} as never,BACKGROUND_CONTEXT),/revoked/);assert.equal(calls,1);
 const denied=governTool({...tool,name:'lookup'}, {...policy,requiredScopes:['notes']},context(),{authorize:async()=>{}});
 await assert.rejects(denied.execute({query:'x'},{} as never,BACKGROUND_CONTEXT),/AUTHORIZATION_REVOKED/);
});

test('stored story receipt and local skill both reauthorize without replaying a side effect',async()=>{
 const config={model:{limits:{maxToolResultBytes:10000}}} as Config;
 const ex:StoryExecution={messageId:'author',runId:'run',dialogueRecording:true,writes:{record_story_changes:{arguments:{},result:'{"status":"applied","changeId":"receipt","changes":[]}'}},persist:()=>{}};
 let revoked=false,checks=0;const authority={authorize:async()=>{checks++;if(revoked)throw Error('AUTHORIZATION_REVOKED')}};
 const registered=tools(config,'session','SECRET_CAPABILITY',new AbortController().signal,()=>{},()=>true,['creative'],ex,{context:context(),authority});
 const write=registered.find(t=>t.name==='record_story_changes')!;
 const args={changes:[{intent:'decide',kind:'character',patch:{name:'A'},evidence:[{messageId:'author',quote:'A'}]}]};
 const first=await write.execute(args,{} as never,BACKGROUND_CONTEXT);assert.match(JSON.stringify(first),/receipt/);
 revoked=true;await assert.rejects(write.execute(args,{} as never,BACKGROUND_CONTEXT),/AUTHORIZATION_REVOKED/);
 await assert.rejects(registered.find(t=>t.name==='load_analysis_skill')!.execute({name:'plot-analysis'},{} as never,BACKGROUND_CONTEXT),/AUTHORIZATION_REVOKED/);
 assert.equal(checks,3);
 assert(!JSON.stringify(governanceMetrics()).includes('execution'));
 assert.throws(()=>definition('unregistered-planner'),/UNSUPPORTED_TASK_KIND/);
});
