import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadConfig} from '../src/config.js';
test('registry uses isolated credential references, safe bounds, explicit enabled state and no fallback on bad config',()=>{
 const root=mkdtempSync(join(tmpdir(),'pi-models-'));const token=join(root,'token'),file=join(root,'models');writeFileSync(token,'t'.repeat(64),{mode:0o600});
 const env={WRITER_AGENT_PI_SERVICE_TOKEN_FILE:token,WRITER_AGENT_PI_LLM_API_KEY:'synthetic-default'};
 try {
   const fallback=loadConfig(env);assert.equal(fallback.model.limits.maxTurnsPerRequest,4);assert.equal(fallback.model.limits.maxOutputTokens,4096);
   assert.equal(loadConfig({...env,WRITER_AGENT_PI_LLM_MODEL:'openai.gpt-oss-120b-1:0'}).model.limits.maxOutputTokens,8192);
   const model={...fallback.model,modelId:'deepseek',contextWindow:65536,billingPolicy:'standard-points-v1'};
   writeFileSync(file,JSON.stringify([{model,keyEnv:'SYNTHETIC_KEY',enabled:true}]),{mode:0o600});
   const registered=loadConfig({...env,WRITER_AGENT_PI_MODELS_FILE:file,SYNTHETIC_KEY:'independent-fixture'});
   assert.equal(registered.models?.[0].key,'independent-fixture');
   assert.throws(()=>loadConfig({...env,WRITER_AGENT_PI_MODELS_FILE:file}),/MODEL_KEY_REQUIRED/);
   writeFileSync(file,JSON.stringify([{model:{...model,endpoint:'https://example.invalid/?secret=never'},keyEnv:'SYNTHETIC_KEY',enabled:false}]));
   assert.throws(()=>loadConfig({...env,WRITER_AGENT_PI_MODELS_FILE:file}),/INVALID_MODEL_ENDPOINT/);
   writeFileSync(file,JSON.stringify([{model,keyEnv:'SYNTHETIC_KEY',enabled:false}]));
   assert.equal(loadConfig({...env,WRITER_AGENT_PI_MODELS_FILE:file}).models?.[0].enabled,false);
 }finally{rmSync(root,{recursive:true,force:true})}
});
