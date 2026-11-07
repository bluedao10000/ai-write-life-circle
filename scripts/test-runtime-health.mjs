import assert from 'node:assert/strict';
import {createPiWorkerFixture,until} from './lib/pi-worker-fixture.mjs';
const f=await createPiWorkerFixture();
try{
 const origin=f.env.WRITER_AGENT_PI_STORY_ORIGIN;
 const healthPath=origin+'/internal/v1/runtime/health';
 const metricsPath=origin+'/internal/v1/runtime/metrics';
 const probe=async(token=f.keys.rpc)=>{const res=await fetch(healthPath,{headers:{authorization:'Bearer '+token}});return {status:res.status,body:await res.json()}};
 const metrics=async(token=f.keys.rpc)=>{const res=await fetch(metricsPath,{headers:{authorization:'Bearer '+token}});return {status:res.status,contentType:res.headers.get('content-type'),body:await res.text()}};
 assert.equal((await probe('wrong')).status,401);
 assert.equal((await metrics('wrong')).status,401);
 await f.call('/internal/v1/runtime/health',{status:404});
 const initial=await probe();assert.equal(initial.status,200);assert.equal(initial.body.liveness,true);assert.equal(initial.body.readiness,false);assert.equal(initial.body.thinking.status,'unavailable');assert.equal(initial.body.worker.status,'unavailable');assert.equal(initial.body.worker.pendingTasks,null);
 const initialMetrics=await metrics();
 assert.equal(initialMetrics.status,200);assert.equal(initialMetrics.contentType,'text/plain; version=0.0.4; charset=utf-8');
 assert.match(initialMetrics.body,/writer_agent_runtime_liveness 1/);
 assert.match(initialMetrics.body,/writer_agent_runtime_ready 0/);
 assert.match(initialMetrics.body,/writer_agent_worker_executors\{state="enabled"\} 4/);
 assert.doesNotMatch(initialMetrics.body,/^writer_agent_worker_pending_tasks /m);
 assert.doesNotMatch(initialMetrics.body,/^writer_agent_thinking_run_attempts/m);
 const pi=f.start('pi'),worker=f.start('pi-worker');
 await until(()=>pi.output.includes('agent_started')&&worker.output.includes('worker_started'),'processes ready');
 const ready=await until(async()=>{const {body}=await probe();return body.readiness&&body},'aggregate readiness');
 assert.equal(ready.degraded,false);assert.equal(ready.api,'ready');assert.equal(ready.provider,'not_probed');assert.equal(ready.worker.enabledExecutors,4);assert.equal(ready.worker.onlineExecutors,4);assert.equal(ready.worker.pendingTasks,0);assert.equal(ready.thinking.counts.failedSessions,0);
 const readyMetrics=await metrics();
 assert.equal(readyMetrics.status,200);
 for(const expected of [
  /writer_agent_runtime_ready 1/,
  /writer_agent_worker_executors\{state="enabled"\} 4/,
  /writer_agent_worker_executors\{state="online"\} 4/,
  /writer_agent_worker_pending_tasks 0/,
  /writer_agent_thinking_tasks\{state="failed_session"\} 0/,
  /writer_agent_thinking_run_attempts\{state="completed"\} 0/,
  /writer_agent_thinking_run_terminal_samples 0/,
  /writer_agent_worker_task_receipts\{kind="review\.execute",state="completed"\} 0/,
  /writer_agent_worker_role_steps\{role="creative\.plan\.planner",state="admission"\} 0/,
 ])assert.match(readyMetrics.body,expected);
 await f.stop(pi);
 const withoutThinking=(await probe()).body;
 assert.equal(withoutThinking.liveness,true);assert.equal(withoutThinking.readiness,false);assert.equal(withoutThinking.degraded,true);assert.equal(withoutThinking.worker.readiness,true);assert.equal(withoutThinking.thinking.status,'unavailable');
 const withoutThinkingMetrics=await metrics();assert.match(withoutThinkingMetrics.body,/writer_agent_runtime_ready 0/);assert.match(withoutThinkingMetrics.body,/writer_agent_thinking_ready 0/);
 const replacement=f.start('pi');await until(()=>replacement.output.includes('agent_started'),'Thinking restarted');
 await until(async()=>(await probe()).body.readiness,'Thinking reconnected');
 await f.stop(worker);
 const withoutWorker=await until(async()=>{const {body}=await probe();return body.worker.status==='unavailable'&&body},'heartbeat expiry');
 assert.equal(withoutWorker.liveness,true);assert.equal(withoutWorker.thinking.readiness,true);assert.equal(withoutWorker.readiness,false);assert.equal(withoutWorker.worker.pendingTasks,null);
 const withoutWorkerMetrics=await metrics();assert.match(withoutWorkerMetrics.body,/writer_agent_runtime_ready 0/);assert.doesNotMatch(withoutWorkerMetrics.body,/^writer_agent_worker_pending_tasks /m);
 assert.equal(f.calls,0,'health probes must not call models');
 assert(!JSON.stringify(withoutWorker).includes(f.keys.rpc));assert(!withoutWorkerMetrics.body.includes(f.keys.rpc));
 console.log('PASS: authenticated private runtime health and Prometheus metrics, Go liveness, Thinking stop/restart, Worker heartbeat expiry, unknown stale counts, zero model calls.');
}finally{await f.close()}
