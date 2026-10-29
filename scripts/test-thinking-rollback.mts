import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { rollbackPiDirectory, rollbackPiSession } from "./lib/thinking-rollback.mts";

const root = mkdtempSync(join(tmpdir(),"thinking-rollback-"));
const source = join(root,"source");
const output = join(root,"converted");
const legacyStore = process.env.WRITER_AGENT_LEGACY_STORE;
const id = `th-${randomUUID()}`;
const model = {provider:"synthetic",model:"fixture",endpoint:"https://example.invalid",protocol:"thinking-v1",limits:{maxTurnsPerRequest:2,maxToolCalls:2,maxInputTokens:1000,maxOutputTokens:100,maxSessionTokens:2000,maxConcurrentSessions:1,maxDurationMs:10000,maxToolResultBytes:1000}};
const message = (suffix:string,status:string,text="Synthetic author discussion") => ({id:`user${suffix}`,role:"user",text,status:"completed",sources:[],createdAt:"2026-10-29T00:00:00Z"});
const answer = (suffix:string,status:string) => ({id:`user${suffix}-answer`,role:"assistant",text:status === "completed" ? "Synthetic answer" : "Partial answer",status,sources:[],createdAt:"2026-10-29T00:00:00Z"});
function saved(status:string,runStatus:string,deleted=false) {
  return {schema:1,accountingVersion:2,owner:"synthetic-author",epoch:3,executionLease:{owner:"dead-pi",epoch:3,expiresAt:1},checkpoint:{input:{text:"synthetic"},entries:[],messageId:"user"},runs:[],deleted:deleted || undefined,view:{sessionId:id,bookId:"synthetic-book",title:"Synthetic discussion",createdAt:"2026-10-29T00:00:00Z",model,scopes:[],status,messages:[message("", "completed"),answer("",status === "cancelled" ? "cancelled" : status === "completed" ? "completed" : "running")],cursor:1,usage:{input:100,output:20,charged:120,incomplete:false},run:{runId:randomUUID(),traceId:randomUUID(),messageId:"user",status:runStatus,stepType:"provider",checkpointId:randomUUID(),epoch:3,attempt:1,retryCount:0,modelCalls:1,resumable:true,provider:"synthetic",model:"fixture",startedAt:"2026-10-29T00:00:00Z",updatedAt:"2026-10-29T00:00:00Z",durationMs:1}},entries:[],events:[{id:1,type:"message_started",messageId:"user"}],requests:{"request-key":{fingerprint:"synthetic-fingerprint",messageId:"user"}}};
}

try {
  const interrupted = saved("running","accepted");
  const converted = rollbackPiSession(interrupted,id);
  assert.equal((converted.value as any).view.status,"idle");
  assert.equal((converted.value as any).view.messages[1].status,"interrupted");
  assert.equal((converted.value as any).view.run,undefined);
  assert.equal((converted.value as any).view.usage.charged,120);
  assert.equal((converted.value as any).requests["request-key"].messageId,"user");
  assert.equal(converted.result.terminalized,true);
  assert.deepEqual(rollbackPiSession(interrupted,id).value,converted.value);
  assert.equal((rollbackPiSession(saved("idle","completed"),id).value as any).view.messages[1].status,"completed");
  assert.equal((rollbackPiSession(saved("idle","cancelled"),id).value as any).view.messages[1].status,"cancelled");
  const deleted = saved("deleted","cancelled",true);
  deleted.view.messages = [];deleted.events = [];deleted.entries = [];deleted.requests = {};delete deleted.view.run;
  assert.equal((rollbackPiSession(deleted,id).value as any).deleted,true);
  assert.throws(() => rollbackPiSession({...interrupted,futureField:true},id),/futureField/);
  assert.throws(() => rollbackPiSession({...interrupted,view:{...interrupted.view,sessionId:`th-${randomUUID()}`}},id),/MISMATCH/);

  // The actual Store constructor enforces private directory permissions and a stopped process.
  const {mkdirSync} = await import("node:fs");
  mkdirSync(source,{mode:0o700});
  writeFileSync(join(source,`${id}.json`),JSON.stringify(interrupted),{mode:0o600});
  chmodSync(source,0o700);
  const original = readFileSync(join(source,`${id}.json`),"utf8");
  rollbackPiDirectory(source,output);
  assert.equal(readFileSync(join(source,`${id}.json`),"utf8"),original);
  assert.equal(statSync(join(output,`${id}.json`)).mode & 0o777,0o600);
  assert.throws(() => rollbackPiDirectory(source,output),/ALREADY_EXISTS/);
  if (legacyStore) {
    const rows = execFileSync(process.execPath,["--import","tsx","scripts/lib/thinking-rollback-legacy-store.mts",legacyStore,output,id],{encoding:"utf8"}).trim().split("\n").map(line=>JSON.parse(line));
    assert.equal(rows.length,1);assert.equal(rows[0].status,"idle");assert.equal(rows[0].messages,2);assert.equal(rows[0].receipts,1);assert.equal(rows[0].usage.charged,120);
  }
  const deletedId = `th-${randomUUID()}`;
  const tombstoneState = saved("deleted","cancelled",true);
  tombstoneState.view.sessionId = deletedId;tombstoneState.view.messages = [];tombstoneState.events = [];tombstoneState.entries = [];tombstoneState.requests = {};delete tombstoneState.view.run;
  writeFileSync(join(source,`${deletedId}.json`),JSON.stringify(tombstoneState),{mode:0o600});
  writeFileSync(join(source,`${deletedId}.json.deleted`),"",{mode:0o600});
  rollbackPiDirectory(source,join(root,"with-tombstone"));
  assert(readdirSync(join(root,"with-tombstone")).includes(`${deletedId}.json.deleted`));
  if (legacyStore) {
    const rows = execFileSync(process.execPath,["--import","tsx","scripts/lib/thinking-rollback-legacy-store.mts",legacyStore,join(root,"with-tombstone"),deletedId],{encoding:"utf8"}).trim().split("\n").map(line=>JSON.parse(line));
    assert.equal(rows[0].deleted,true);assert.equal(rows[0].messages,0);assert.equal(rows[0].receipts,0);
  }
  console.log(JSON.stringify({event:"rollback_projection_verified",sessions:1,legacyLoader:"scripts/lib/thinking-rollback-legacy-store.mts",output}));
} finally {
  rmSync(root,{recursive:true,force:true});
}
