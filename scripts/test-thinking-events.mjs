import test from 'node:test';
import assert from 'node:assert/strict';
import {readThinkingEvents} from './lib/thinking-events.mjs';
test('eval drains more than 200 events without dropping later tool calls',async()=>{
 const events=Array.from({length:451},(_,i)=>({id:i+1,type:i===450?'tool_started':'text_delta'}));let calls=0;
 const result=await readThinkingEvents(async path=>{calls++;const after=Number(new URL(path,'http://fixture').searchParams.get('after'));const items=events.slice(after,after+200);return {items,cursor:items.at(-1).id}},'/session',451);
 assert.equal(calls,3);assert.equal(result.items.length,451);assert.equal(result.items.filter(e=>e.type==='tool_started').length,1);
 await assert.rejects(readThinkingEvents(async()=>({items:[],cursor:0}),'/session',1),/STALLED/);
});
