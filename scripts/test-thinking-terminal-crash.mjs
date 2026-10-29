import assert from 'node:assert/strict';
import {startThinkingFixture,seedThinkingBook} from './lib/thinking-fixture.mjs';
const f=await startThinkingFixture({completionCrash:true});
try {
 const book=await seedThinkingBook(f),base=`/v1/studio/books/${book.bookId}/thinking`;
 const session=await f.call(base+'/sessions',{method:'POST',key:'terminal-session',body:{modelId:'default'},status:201});
 const path=base+'/sessions/'+session.sessionId;
 await f.call(path+'/messages',{method:'POST',key:'terminal-question',body:{text:'Synthetic completed question'},status:202});
 await f.waitForCompletionCheckpoint();await f.stopAgent('SIGKILL');const count=f.calls.length;
 await f.restartAgent();const restored=await f.call(path);
 assert.equal(restored.status,'idle');assert.equal(restored.run.status,'completed');assert.equal(restored.run.resumable,false);
 assert.equal(restored.messages.at(-1).status,'completed');assert.equal(restored.run.failure,undefined);
 const events=await f.call(path+'/events?after=0');assert(events.items.some(e=>e.type==='message_completed'));assert(events.items.some(e=>e.type==='session_completed'));assert(!events.items.some(e=>e.code==='AGENT_RESTARTED'));
 await f.call(path+'/resume',{method:'POST',key:'forbid-double-charge',body:{runId:restored.run.runId,confirmAdditionalCost:true},status:409});
 assert.equal(f.calls.length,count);
 console.log('PASS: real SIGKILL at durable completion barrier; completed terminal state survives, Resume rejected, no duplicate model call.');
}finally{await f.close()}
