import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {PiHost} from "../src/runtime/pi-host.js";
import {AutonomyCoordinator} from "../src/runtime/governance/task-coordinator.js";
import {Store} from "../src/sessions/store.js";
import type {Config} from "../src/config.js";
import type {ThinkingMessageInput} from "@writer-agent/contracts";

const listen=async(server:ReturnType<typeof createServer>)=>{
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  return `http://127.0.0.1:${(server.address() as {port:number}).port}`;
};
const body=async(req:AsyncIterable<unknown>)=>{
  const chunks:Uint8Array[]=[];
  for await(const chunk of req)chunks.push(Buffer.from(chunk as Uint8Array));
  return JSON.parse(Buffer.concat(chunks).toString()) as Record<string,unknown>;
};
type Mode="complete"|"missing"|"bad-plan"|"hang"|"ordinary"|"needs-input"|"write-tool"|"tool-failure"|"provider-failure"|"revoked"|"post-evidence-failure"|"post-completion-failure";

const autonomyBounds={maxToolCalls:3,maxTurns:4,maxDurationMs:5000};
const autonomyRequest={completionCriteria:"给出结论并说明依据",approveReadOnlyTools:true as const,maxSteps:1};
const adoptedPlan={
  goal:"核对林舟是否已经离开旧城",
  completionCriteria:autonomyRequest.completionCriteria,
  steps:[{stepId:"s1",tool:"search_knowledge" as const,purpose:"核对旧城相关内容"}],
};

async function fixture(mode:Mode,options:{maxTurns?:number;maxToolCalls?:number}={}){
  const state=mkdtempSync(join(tmpdir(),"pi-autonomy-"));
  const id="th-"+randomUUID();
  const scopes=["knowledge"];
  const goal="核对林舟是否已经离开旧城";
  const completionCriteria="给出结论，并说明所依据的作品资料";
  const payloads:Record<string,unknown>[]=[];
  let providerCalls=0,storyCalls=0,planWasDurable=false,host!:PiHost,revoked=false,releaseSecond!:()=>void;
  const second=new Promise<void>(resolve=>{releaseSecond=resolve});
  const provider=createServer(async(req,res)=>{
    const value=await body(req);
    payloads.push(value);providerCalls++;
    if(mode==="provider-failure"&&providerCalls===2 || mode==="post-evidence-failure"&&providerCalls===3 || mode==="post-completion-failure"&&providerCalls===4){
      res.writeHead(500,{"content-type":"application/json"});
      res.end('{"error":{"message":"synthetic provider failure"}}');
      return;
    }
    if(mode==="revoked"&&providerCalls===2)await second;
    const messages=(value.messages??[]) as {role:string;content?:unknown}[];
    const toolResults=messages.filter(message=>message.role==="tool").length;
    const recoveredEvidence=messages.some(message=>typeof message.content==="string"&&message.content.includes("Recovered successful read-only tool results"));
    const names=((value.tools??[]) as {function?:{name?:string}}[]).map(tool=>tool.function?.name);
    const boundedAutonomy=names.includes("adopt_autonomy_plan")||names.includes("complete_autonomy");
    let call:{name:string;arguments:Record<string,unknown>}|undefined;
    const text="已完成只读核对。";
    if(mode!=="hang"&&boundedAutonomy){
      if(toolResults===0&&!(mode==="post-evidence-failure"&&recoveredEvidence)){
        call={
          name:"adopt_autonomy_plan",
          arguments:mode==="bad-plan"
            ? {goal,completionCriteria,steps:[{stepId:"s1",tool:"read_chapter",purpose:"读取未授权章节"}]}
            : {goal,completionCriteria,steps:[{stepId:"s1",tool:"search_knowledge",purpose:"核对旧城相关内容"}]},
        };
      }else if(toolResults===1&&mode==="needs-input"){
        call={name:"complete_autonomy",arguments:{status:"needs_input",summary:"缺少旧城资料。",completedStepIds:[],remainingSteps:[{stepId:"s1",reason:"资料中没有旧城记录"}]}};
      }else if(toolResults===1&&mode==="write-tool"){
        call={name:"record_story_changes",arguments:{changes:[]}};
      }else if(toolResults===1){
        call={name:"search_knowledge",arguments:{stepId:"s1",query:"林舟 旧城"}};
      }else if((toolResults===2&&(mode==="complete"||mode==="post-completion-failure"))||(mode==="post-evidence-failure"&&recoveredEvidence)){
        call={name:"complete_autonomy",arguments:{status:"complete",summary:"已完成只读核对。",completedStepIds:["s1"],remainingSteps:[]}};
      }
    }
    res.writeHead(200,{"content-type":"text/event-stream"});
    if(mode==="hang"){
      req.on("close",()=>res.end());
      return;
    }
    const delta=call?{tool_calls:[{index:0,id:`call-${providerCalls}`,type:"function",function:{name:call.name,arguments:JSON.stringify(call.arguments)}}]}:{content:text};
    res.write("data: "+JSON.stringify({id:"fixture",object:"chat.completion.chunk",choices:[{index:0,delta,finish_reason:null}]})+"\n\n");
    res.write("data: "+JSON.stringify({choices:[{index:0,delta:{},finish_reason:call?"tool_calls":"stop"}],usage:{prompt_tokens:120,completion_tokens:30,total_tokens:150}})+"\n\n");
    res.end("data: [DONE]\n\n");
    void names;
  });
  const model={modelId:"fixture",displayName:"Fixture",provider:"fixture",model:"fixture",endpoint:await listen(provider),protocol:"thinking-v1" as const,limits:{maxTurnsPerRequest:options.maxTurns??4,maxToolCalls:options.maxToolCalls??3,maxInputTokens:32000,maxOutputTokens:512,maxSessionTokens:500000,maxConcurrentSessions:2,maxDurationMs:5000,maxToolResultBytes:24000}};
  const story=createServer(async(req,res)=>{
    res.setHeader("content-type","application/json");
    if(req.url?.endsWith("/authorize")){
      if(revoked){res.statusCode=403;res.end(JSON.stringify({code:"AUTHORIZATION_REVOKED"}));return}
      res.end(JSON.stringify({sessionId:id,authorId:"author",bookId:"book",model,scopes}));
      return;
    }
    const value=await body(req);
    storyCalls++;
    assert.equal(value.tool,"search_knowledge");
    assert.deepEqual(value.arguments,{query:"林舟 旧城"});
    if(mode==="tool-failure"){res.statusCode=500;res.end(JSON.stringify({code:"synthetic"}));return}
    const current=host.store.state(id)?.checkpoint?.autonomy;
    planWasDurable=current?.plan?.steps[0]?.status==="running"&&current.status==="running";
    res.end(JSON.stringify({items:[{chapterId:"ch-1",title:"旧城"}],sources:[]}));
  });
  const config:Config={state,port:1,version:"test",key:"fixture",token:"t".repeat(64),storyOrigin:await listen(story),model,models:[{model,key:"fixture",enabled:true,description:"fixture"}]};
  host=new PiHost(config,new Store(state));
  await host.create({sessionId:id,authorId:"author",bookId:"book",createdAt:new Date().toISOString(),model,scopes:["knowledge"],capability:"fixture"});
  const send=async(input:ThinkingMessageInput,key:string=randomUUID())=>{
    await host.accept(id,input,key,"fixture");
    const done=host.active.get(id)?.done;
    if(done)await done;
    return host.get(id).view.messages.at(-1)!;
  };
  const resume=async(runId:string,key:string=randomUUID())=>{
    await host.accept(id,{text:"Resume accepted message",recovery:{runId,confirmAdditionalCost:true}},key,"fixture");
    const done=host.active.get(id)?.done;
    if(done)await done;
    return host.get(id).view.messages.at(-1)!;
  };
  return {
    id,goal,completionCriteria,payloads,send,resume,
    get providerCalls(){return providerCalls},
    get storyCalls(){return storyCalls},
    get planWasDurable(){return planWasDurable},
    host,
    revoke(){revoked=true},
    releaseSecond(){releaseSecond()},
    async waitForProviderCalls(after:number){
      for(let i=0;i<200;i++){
        if(providerCalls>=after)return;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      throw Error("provider call timeout");
    },
    async reopen(){
      await host.close();
      host=new PiHost(config,new Store(state));
      await host.ready;
      return host;
    },
    async close(){
      releaseSecond();
      await host.close();provider.closeAllConnections();story.closeAllConnections();provider.close();story.close();rmSync(state,{recursive:true,force:true});
    },
  };
}

test("autonomy coordinator seals terminal plans and preserves only evidenced steps across recovery",()=>{
  const initial=AutonomyCoordinator.initial(autonomyRequest,adoptedPlan.goal,["knowledge"],autonomyBounds);
  initial.adopt(adoptedPlan);
  assert.throws(()=>initial.adopt(adoptedPlan),/AUTONOMY_PLAN_REJECTED/);
  assert.throws(()=>initial.beginStep("missing","search_knowledge"),/AUTONOMY_PLAN_REJECTED/);
  assert.throws(()=>initial.beginStep("s1","read_chapter"),/AUTONOMY_PLAN_REJECTED/);

  const needsInput=AutonomyCoordinator.restore(initial.projection(),adoptedPlan.goal,["knowledge"],autonomyBounds);
  needsInput.complete({status:"needs_input",summary:"缺少资料。",completedStepIds:[],remainingSteps:[{stepId:"s1",reason:"没有对应记录"}]});
  assert.throws(()=>needsInput.beginStep("s1","search_knowledge"),/AUTONOMY_PLAN_REJECTED/);

  const evidenced=AutonomyCoordinator.restore(initial.projection(),adoptedPlan.goal,["knowledge"],autonomyBounds);
  evidenced.beginStep("s1","search_knowledge");
  evidenced.completeStep("s1");
  evidenced.markFailure("PROVIDER_UNAVAILABLE");
  const withoutEvidence=AutonomyCoordinator.restore(evidenced.projection(),adoptedPlan.goal,["knowledge"],autonomyBounds);
  withoutEvidence.resume();
  assert.equal(withoutEvidence.projection().plan?.steps[0]?.status,"pending");

  const recovered=AutonomyCoordinator.restore(evidenced.projection(),adoptedPlan.goal,["knowledge"],autonomyBounds);
  recovered.resume(new Set(["s1"]));
  assert.equal(recovered.projection().plan?.steps[0]?.status,"completed");
  recovered.complete({status:"complete",summary:"已完成。",completedStepIds:["s1"],remainingSteps:[]});
  recovered.markFailure("PROVIDER_UNAVAILABLE");
  const afterCompletion=AutonomyCoordinator.restore(recovered.projection(),adoptedPlan.goal,["knowledge"],autonomyBounds);
  afterCompletion.resume();
  assert.equal(afterCompletion.projection().status,"completed");
  assert.equal(afterCompletion.projection().completion?.status,"complete");
});

test("bounded autonomy persists a plan before one governed read and records explicit completion",async()=>{
  const f=await fixture("complete");
  try{
    const reply=await f.send({text:f.goal,autonomy:{completionCriteria:f.completionCriteria,approveReadOnlyTools:true,maxSteps:1}});
    assert.equal(reply.status,"completed",reply.errorCode);
    assert.equal(f.storyCalls,1);
    assert.equal(f.planWasDurable,true);
    assert.equal(f.providerCalls,4);
    const saved=f.host.store.state(f.id)!;
    const userMessageId=saved.requests[Object.keys(saved.requests)[0]!]?.messageId;
    assert.equal(saved.autonomy?.[userMessageId]?.status,"completed",JSON.stringify(saved.autonomy));
    const user=f.host.get(f.id).view.messages.find(message=>message.role==="user")!;
    assert.equal(user.autonomy?.status,"completed");
    assert.equal(user.autonomy?.plan?.steps[0]?.status,"completed");
    assert.equal(user.autonomy?.completion?.status,"complete");
    assert.equal(saved.view.messages.some(message=>"autonomy" in message),false);
    assert.equal(saved.autonomy?.[user.id]?.status,"completed");
    assert.equal(f.host.store.history(f.id)?.items.find(message=>message.id===user.id)?.autonomy?.status,"completed");
    const names=f.payloads.flatMap(value=>((value.tools??[]) as {function?:{name?:string}}[]).map(tool=>tool.function?.name));
    assert(names.includes("adopt_autonomy_plan"));
    assert(names.includes("complete_autonomy"));
    assert(!names.includes("record_story_changes"));
    assert(!names.includes("request_turn_organize"));
    const before=f.providerCalls;
    const reopened=await f.reopen();
    assert.equal(f.providerCalls,before);
    assert.equal(reopened.get(f.id).view.messages.find(message=>message.role==="user")?.autonomy?.status,"completed");
  }finally{await f.close()}
});

test("autonomy uses the exact one-tool and four-turn budget floor",async()=>{
  const f=await fixture("complete",{maxTurns:4,maxToolCalls:1});
  try{
    const reply=await f.send({text:f.goal,autonomy:{completionCriteria:f.completionCriteria,approveReadOnlyTools:true,maxSteps:1}});
    assert.equal(reply.status,"completed",reply.errorCode);
    assert.equal(f.providerCalls,4);
    assert.equal(f.storyCalls,1);
  }finally{await f.close()}
});

test("autonomy rejects expanded plans and missing completion without reporting success",async()=>{
  const invalid=await fixture("bad-plan");
  try{
    const reply=await invalid.send({text:invalid.goal,autonomy:{completionCriteria:invalid.completionCriteria,approveReadOnlyTools:true,maxSteps:1}});
    assert.equal(reply.status,"failed");
    assert.equal(reply.errorCode,"AUTONOMY_PLAN_REJECTED");
    assert.equal(invalid.storyCalls,0);
  }finally{await invalid.close()}

  const incomplete=await fixture("missing");
  try{
    const reply=await incomplete.send({text:incomplete.goal,autonomy:{completionCriteria:incomplete.completionCriteria,approveReadOnlyTools:true,maxSteps:1}});
    assert.equal(reply.status,"failed");
    assert.equal(reply.errorCode,"AUTONOMY_INCOMPLETE");
    const user=incomplete.host.get(incomplete.id).view.messages.find(message=>message.role==="user")!;
    assert.equal(user.autonomy?.status,"failed");
    assert.equal(user.autonomy?.completion,undefined);
  }finally{await incomplete.close()}
});

test("needs_input records every remaining step and remains a visible non-success plan outcome",async()=>{
  const f=await fixture("needs-input");
  try{
    const reply=await f.send({text:f.goal,autonomy:{completionCriteria:f.completionCriteria,approveReadOnlyTools:true,maxSteps:1}});
    assert.equal(reply.status,"completed",reply.errorCode);
    assert.equal(f.storyCalls,0);
    const state=f.host.get(f.id).view.messages.find(message=>message.role==="user")?.autonomy;
    assert.equal(state?.status,"needs_input");
    assert.deepEqual(state?.completion?.completedStepIds,[]);
    assert.deepEqual(state?.completion?.remainingSteps,[{stepId:"s1",reason:"资料中没有旧城记录"}]);
  }finally{await f.close()}
});

test("write tools are unavailable and cannot affect story state",async()=>{
  const f=await fixture("write-tool");
  try{
    const reply=await f.send({text:f.goal,autonomy:{completionCriteria:f.completionCriteria,approveReadOnlyTools:true,maxSteps:1}});
    assert.equal(reply.status,"failed");
    assert.equal(reply.errorCode,"TOOL_EXECUTION_FAILED");
    assert.equal(f.storyCalls,0);
    const names=f.payloads.flatMap(value=>((value.tools??[]) as {function?:{name?:string}}[]).map(tool=>tool.function?.name));
    assert(!names.includes("record_story_changes"));
    assert(!names.includes("offer_story_changes"));
    assert(!names.includes("request_turn_organize"));
  }finally{await f.close()}
});

test("tool and provider failures retain failure state without a completion receipt",async()=>{
  const tool=await fixture("tool-failure");
  try{
    const reply=await tool.send({text:tool.goal,autonomy:{completionCriteria:tool.completionCriteria,approveReadOnlyTools:true,maxSteps:1}});
    assert.equal(reply.status,"failed");
    assert.equal(reply.errorCode,"TOOL_EXECUTION_FAILED");
    const state=tool.host.get(tool.id).view.messages.find(message=>message.role==="user")?.autonomy;
    assert.equal(state?.status,"failed");
    assert.equal(state?.completion,undefined);
  }finally{await tool.close()}

  const provider=await fixture("provider-failure");
  try{
    const reply=await provider.send({text:provider.goal,autonomy:{completionCriteria:provider.completionCriteria,approveReadOnlyTools:true,maxSteps:1}});
    assert.equal(reply.status,"failed");
    assert.equal(reply.errorCode,"PROVIDER_UNAVAILABLE");
    const state=provider.host.get(provider.id).view.messages.find(message=>message.role==="user")?.autonomy;
    assert.equal(state?.status,"failed");
    assert.equal(state?.completion,undefined);
  }finally{await provider.close()}
});

test("explicit recovery reuses completed tool evidence and can finish after a persisted completion",async()=>{
  const afterEvidence=await fixture("post-evidence-failure");
  try{
    const failed=await afterEvidence.send({text:afterEvidence.goal,autonomy:{completionCriteria:afterEvidence.completionCriteria,approveReadOnlyTools:true,maxSteps:1}});
    assert.equal(failed.status,"failed");
    assert.equal(failed.errorCode,"PROVIDER_UNAVAILABLE");
    assert.equal(afterEvidence.storyCalls,1);
    const failedState=afterEvidence.host.store.state(afterEvidence.id)!;
    assert.equal(failedState.checkpoint?.autonomy?.plan?.steps[0]?.status,"completed");
    assert.equal(failedState.checkpoint?.autonomyEvidence?.s1?.tool,"search_knowledge");
    assert.match(failedState.checkpoint?.autonomyEvidence?.s1?.output??"",/旧城/);
    const reply=await afterEvidence.resume(failedState.view.run!.runId,"resume-after-evidence");
    assert.equal(reply.status,"completed",reply.errorCode);
    assert.equal(afterEvidence.storyCalls,1);
    assert.equal(afterEvidence.providerCalls,5);
    assert(afterEvidence.payloads.slice(3).some(payload=>JSON.stringify(payload).includes("Recovered successful read-only tool results")));
    assert.equal(afterEvidence.host.store.state(afterEvidence.id)?.checkpoint?.autonomy?.completion?.status,"complete");
  }finally{await afterEvidence.close()}

  const afterCompletion=await fixture("post-completion-failure");
  try{
    const failed=await afterCompletion.send({text:afterCompletion.goal,autonomy:{completionCriteria:afterCompletion.completionCriteria,approveReadOnlyTools:true,maxSteps:1}});
    assert.equal(failed.status,"failed");
    assert.equal(failed.errorCode,"PROVIDER_UNAVAILABLE");
    const failedState=afterCompletion.host.store.state(afterCompletion.id)!;
    assert.equal(failedState.checkpoint?.autonomy?.status,"failed");
    assert.equal(failedState.checkpoint?.autonomy?.completion?.status,"complete");
    const reply=await afterCompletion.resume(failedState.view.run!.runId,"resume-after-completion");
    assert.equal(reply.status,"completed",reply.errorCode);
    assert.equal(afterCompletion.storyCalls,1);
    assert.equal(afterCompletion.providerCalls,5);
    assert.equal(afterCompletion.host.store.state(afterCompletion.id)?.checkpoint?.autonomy?.status,"completed");
  }finally{await afterCompletion.close()}
});

test("authorization revocation before an evidence call prevents the lookup and success claim",async()=>{
  const f=await fixture("revoked");
  try{
    await f.host.accept(f.id,{text:f.goal,autonomy:{completionCriteria:f.completionCriteria,approveReadOnlyTools:true,maxSteps:1}},"revoke","fixture");
    await f.waitForProviderCalls(2);
    assert.equal(f.host.store.state(f.id)?.checkpoint?.autonomy?.status,"planned");
    f.revoke();
    f.releaseSecond();
    const done=f.host.active.get(f.id)?.done;
    if(done)await done;
    const reply=f.host.get(f.id).view.messages.at(-1)!;
    assert.equal(reply.status,"failed");
    assert.equal(reply.errorCode,"AUTHORIZATION_REVOKED");
    assert.equal(f.storyCalls,0);
    const state=f.host.get(f.id).view.messages.find(message=>message.role==="user")?.autonomy;
    assert.equal(state?.status,"failed");
    assert.equal(state?.completion,undefined);
  }finally{await f.close()}
});

test("ordinary messages keep their existing one-call path and expose no autonomy state",async()=>{
  const f=await fixture("ordinary");
  try{
    const reply=await f.send({text:"普通讨论"});
    assert.equal(reply.status,"completed",reply.errorCode);
    assert.equal(f.providerCalls,1);
    assert.equal(f.storyCalls,0);
    const user=f.host.get(f.id).view.messages.find(message=>message.role==="user")!;
    assert.equal(user.autonomy,undefined);
    const names=f.payloads.flatMap(value=>((value.tools??[]) as {function?:{name?:string}}[]).map(tool=>tool.function?.name));
    assert(!names.includes("adopt_autonomy_plan"));
    assert(!names.includes("complete_autonomy"));
  }finally{await f.close()}
});

test("cancelling and expiring bounded autonomy never present a completed plan",async()=>{
  const cancelled=await fixture("hang");
  try{
    await cancelled.host.accept(cancelled.id,{text:cancelled.goal,autonomy:{completionCriteria:cancelled.completionCriteria,approveReadOnlyTools:true,maxSteps:1}},"cancel","fixture");
    const done=cancelled.host.active.get(cancelled.id)?.done;
    await new Promise(resolve=>setTimeout(resolve,100));
    await cancelled.host.cancel(cancelled.id);
    if(done)await done;
    const user=cancelled.host.get(cancelled.id).view.messages.find(message=>message.role==="user")!;
    assert.equal(user.autonomy?.status,"cancelled");
    assert.equal(user.autonomy?.completion,undefined);
  }finally{await cancelled.close()}

  const expired=await fixture("hang");
  try{
    await expired.host.accept(expired.id,{text:expired.goal,autonomy:{completionCriteria:expired.completionCriteria,approveReadOnlyTools:true,maxSteps:1,deadlineMs:1000}},"deadline","fixture");
    const done=expired.host.active.get(expired.id)?.done;
    if(done)await done;
    const reply=expired.host.get(expired.id).view.messages.at(-1)!;
    assert.equal(reply.status,"failed");
    assert.equal(reply.errorCode,"DURATION_EXCEEDED");
    const user=expired.host.get(expired.id).view.messages.find(message=>message.role==="user")!;
    assert.equal(user.autonomy?.status,"failed");
    assert.equal(user.autonomy?.completion,undefined);
  }finally{await expired.close()}
});
