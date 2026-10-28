import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJSON} from '../src/runtime/fingerprint.js';
import {tools} from '../src/tools/registry.js';
import type {Config} from '../src/config.js';

test('tool deduplication canonicalizes nested property order and avoids the second lookup', async()=>{
 assert.equal(canonicalJSON({z:[{a:1,b:2}],q:3}),canonicalJSON({q:3,z:[{b:2,a:1}]}));
 assert.notEqual(canonicalJSON([1,2]),canonicalJSON([2,1]));
 let network=0; const original=globalThis.fetch;
 globalThis.fetch=async()=>{network++;return new Response('{"items":[],"sources":[]}',{headers:{'content-type':'application/json'}})};
 try {
  const config={storyOrigin:'http://127.0.0.1:8791',model:{limits:{maxToolResultBytes:1000}}} as Config;
  const tool=tools(config,'session','fixture',new AbortController().signal,()=>{},()=>{},['chapters']).find(t=>t.name==='read_chapter')!;
  await tool.execute('first',{chapterId:'one',revisionId:'two'},new AbortController().signal,()=>{},{} as never);
  await tool.execute('second',{revisionId:'two',chapterId:'one'},new AbortController().signal,()=>{},{} as never);
  assert.equal(network,1);
 } finally {globalThis.fetch=original}
});
