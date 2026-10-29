import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync,readFileSync,rmSync,writeFileSync,chmodSync,mkdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";

// Build the real previous runtime, never a schema approximation checked into
// the current tree. Everything remains under temporary directories.
const root=mkdtempSync(join(tmpdir(),"thinking-legacy-build-"));
try {
 execFileSync("git",["worktree","add","--detach",join(root,"legacy"),"4dfdca1"],{stdio:"inherit"});
 const repository=join(root,"legacy");
 execFileSync("pnpm",["install","--offline","--frozen-lockfile"],{cwd:repository,stdio:"inherit"});
 execFileSync("pnpm",["build:agent"],{cwd:repository,stdio:"inherit"});
 execFileSync("go",["build","-C",join(repository,"apps/api-go"),"-o",join(root,"legacy-api"),"./cmd/server"],{stdio:"inherit"});
 execFileSync("go",["build","-C","apps/api-go","-o",join(root,"rollback"),"./cmd/thinking-rollback"],{stdio:"inherit"});
 execFileSync("pnpm",["exec","tsx","scripts/test-thinking-rollback.mts"],{env:{...process.env,WRITER_AGENT_LEGACY_STORE:join(repository,"apps/agent/dist")},stdio:"inherit"});

 const id=`th-${randomUUID()}`,state=join(root,"registry.json"),converted=join(root,"legacy.json"),compatible=join(root,"compatible.json");
 const record={sessionId:id,bookId:"synthetic-book",ownerId:"synthetic-author",title:"Synthetic",createdAt:"2026-10-29T00:00:00Z",model:{provider:"synthetic",model:"fixture",endpoint:"https://example.invalid",protocol:"thinking-v1",limits:{maxTurnsPerRequest:2,maxToolCalls:2,maxInputTokens:1000,maxOutputTokens:100,maxSessionTokens:2000,maxConcurrentSessions:1,maxDurationMs:10000,maxToolResultBytes:1000}},scopes:[],deleted:false,cleanupPending:false,nonce:randomUUID(),toolCalls:0,billOp:"reserved-operation",billedPoints:9,authorizationVersion:1};
 const registry={schema:1,sessions:{[id]:record},requests:{receipt:{hash:"fingerprint",id}}};
 writeFileSync(state,JSON.stringify(registry),{mode:0o600});chmodSync(state,0o600);
 const original=readFileSync(state,"utf8");
 execFileSync(join(root,"rollback"),[state,converted,"--legacy-go"],{stdio:"inherit"});
 assert.equal(readFileSync(state,"utf8"),original);
 const legacy=JSON.parse(readFileSync(converted,"utf8"));
 assert.equal(legacy.sessions[id].authorizationVersion,undefined);assert.equal(legacy.sessions[id].billOp,"reserved-operation");assert.equal(legacy.sessions[id].billedPoints,9);assert.equal(legacy.requests.receipt.hash,"fingerprint");
 const cancelDir=join(root,"cancel");mkdirSync(cancelDir,{mode:0o700});
 writeFileSync(join(cancelDir,"state.json"),JSON.stringify({...registry,cancelledReceipts:{receipt:true},sessions:{[id]:{...record,resumeBlocked:true,cancelPending:true}}}),{mode:0o600});
 assert.throws(()=>execFileSync(join(root,"rollback"),[join(cancelDir,"state.json"),join(cancelDir,"unsafe.json"),"--legacy-go"],{stdio:"pipe"}),/durable cancellation fence/);
 execFileSync(join(root,"rollback"),[join(cancelDir,"state.json"),compatible,"--compatible-go"],{stdio:"inherit"});
 const preserved=JSON.parse(readFileSync(compatible,"utf8"));
 assert.equal(preserved.sessions[id].resumeBlocked,true);assert.equal(preserved.sessions[id].cancelPending,true);assert.equal(preserved.cancelledReceipts.receipt,true);
 console.log("PASS: real pre-reliability Pi parses/recover converted state; Go CLI preserves billing/receipts and rejects unsafe legacy cancellation projection.");
} finally {rmSync(root,{recursive:true,force:true})}
