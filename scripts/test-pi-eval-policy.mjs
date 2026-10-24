import assert from 'node:assert/strict';
import {authorize,reserve} from './lib/pi-eval-policy.mjs';
assert.throws(()=>authorize([],{WRITER_AGENT_LLM_API_KEY:'fixture'}));
assert.throws(()=>authorize(['--confirm-fixtures'],{}));
for(const url of ['http://example.test','https://user:pass@example.test','https://example.test/?key=bad','https://example.test/#bad'])assert.throws(()=>authorize(['--confirm-fixtures'],{WRITER_AGENT_LLM_API_KEY:'fixture',WRITER_AGENT_LLM_BASE_URL:url}));
const state={calls:0,reserved:0};reserve(state,50000);reserve(state,50000);assert.throws(()=>reserve(state,1));assert.deepEqual(state,{calls:2,reserved:100000});
const large={calls:0,reserved:0};assert.throws(()=>reserve(large,100001));assert.throws(()=>reserve(large,-1));assert.deepEqual(large,{calls:0,reserved:0});
console.log('PASS: explicit synthetic authorization, local key, HTTPS endpoint, two-call and 100,000-token hard caps. Zero model calls.');
