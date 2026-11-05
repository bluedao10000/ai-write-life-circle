import assert from 'node:assert/strict';
import {createPiWorkerFixture,until} from './lib/pi-worker-fixture.mjs';
const f=await createPiWorkerFixture();
try{
 const path=f.env.WRITER_AGENT_PI_STORY_ORIGIN+'/internal/v1/runtime/health';
 const probe=async(token=f.keys.rpc)=>{const res=await fetch(path,{headers:{authorization:'Bearer '+token}});return {status:res.status,body:await res.json()}};
 assert.equal((await probe('wrong')).status,401);
 await f.call('/internal/v1/runtime/health',{status:404});
 const initial=await probe();assert.equal(initial.status,200);assert.equal(initial.body.liveness,true);assert.equal(initial.body.readiness,false);assert.equal(initial.body.thinking.status,'unavailable');assert.equal(initial.body.worker.status,'unavailable');assert.equal(initial.body.worker.pendingTasks,null);
 const pi=f.start('pi'),worker=f.start('pi-worker');
 await until(()=>pi.output.includes('agent_started')&&worker.output.includes('worker_started'),'processes ready');
 const ready=await until(async()=>{const {body}=await probe();return body.readiness&&body},'aggregate readiness');
 assert.equal(ready.degraded,false);assert.equal(ready.api,'ready');assert.equal(ready.provider,'not_probed');assert.equal(ready.worker.enabledExecutors,4);assert.equal(ready.worker.onlineExecutors,4);assert.equal(ready.worker.pendingTasks,0);assert.equal(ready.thinking.counts.failedSessions,0);
 await f.stop(pi);
 const withoutThinking=(await probe()).body;
 assert.equal(withoutThinking.liveness,true);assert.equal(withoutThinking.readiness,false);assert.equal(withoutThinking.degraded,true);assert.equal(withoutThinking.worker.readiness,true);assert.equal(withoutThinking.thinking.status,'unavailable');
 const replacement=f.start('pi');await until(()=>replacement.output.includes('agent_started'),'Thinking restarted');
 await until(async()=>(await probe()).body.readiness,'Thinking reconnected');
 await f.stop(worker);
 const withoutWorker=await until(async()=>{const {body}=await probe();return body.worker.status==='unavailable'&&body},'heartbeat expiry');
 assert.equal(withoutWorker.liveness,true);assert.equal(withoutWorker.thinking.readiness,true);assert.equal(withoutWorker.readiness,false);assert.equal(withoutWorker.worker.pendingTasks,null);
 assert.equal(f.calls,0,'health probes must not call models');
 assert(!JSON.stringify(withoutWorker).includes(f.keys.rpc));
 console.log('PASS: authenticated private runtime health, Go liveness, Thinking stop/restart, Worker heartbeat expiry, unknown stale counts, zero model calls.');
}finally{await f.close()}
