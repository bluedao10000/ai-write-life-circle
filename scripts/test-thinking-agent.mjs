import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  startThinkingFixture,
  seedThinkingBook,
} from "./lib/thinking-fixture.mjs";
import { thinkingSessionSchema } from "../packages/contracts/dist/thinking.js";
const f = await startThinkingFixture();
try {
  const book = await seedThinkingBook(f),
    base = `/v1/studio/books/${book.bookId}/thinking`,
    model = await f.call(base + "/capabilities");
  let s = await f.call(base + "/sessions", {
    method: "POST",
    key: "create-session",
    body: { consent: true, model, scopes: ["chapters", "knowledge"] },
    status: 201,
  });
  const id = s.sessionId,
    path = base + "/sessions/" + id;
  await f.call("/internal/v1/agent/tools/execute", {
    method: "POST",
    body: {},
    status: 404,
  });
  await f.call(base + "/sessions", { auth: false, status: 401 });
  await f.call("/v1/studio/books/book-other/thinking/sessions/" + id, {
    status: 404,
  });
  const receipt = await f.call(path + "/messages", {
    method: "POST",
    key: "q-1",
    body: { text: "林舟与父亲的关系变化是否合理？" },
    status: 202,
  });
  const wait = async (target=path) => {
    for (let i = 0; i < 200; i++) {
      s = await f.call(target);
      if (s.status === "idle") return;
      await delay(40);
    }
    throw Error("run timeout");
  };
  await wait();
  thinkingSessionSchema.parse(s);
  assert.equal(
    s.messages.at(-1).status,
    "completed",
    JSON.stringify(s.messages),
  );
  assert.equal(s.messages.at(-1).sources.length, 3);
  assert(f.tools.includes("find_related_chapters"));
  assert.equal(f.tools.filter((t) => t === "read_chapter").length, 3);
  const count = f.calls.length;
  assert.deepEqual(
    await f.call(path + "/messages", {
      method: "POST",
      key: "q-1",
      body: { text: "林舟与父亲的关系变化是否合理？" },
      status: 202,
    }),
    receipt,
  );
  assert.equal(f.calls.length, count);
  const events = await f.call(path + "/events?after=0");
  assert(events.items.some((e) => e.type === "text_delta"));
  assert(events.items.some((e) => e.type === "tool_started"));
  assert.equal(
    (await f.call(path + "/events?after=" + events.cursor)).items.length,
    0,
  );
  const internal = await fetch(
    f.agentOrigin + "/internal/v1/sessions/" + id + "/events?after=0",
    {
      headers: {
        Authorization: "Bearer " + f.token,
        Accept: "text/event-stream",
      },
    },
  );
  assert((await internal.text()).includes("text_delta"));
  await f.stopAgent();
  await f.restartAgent();
  await f.call(path + "/messages", {
    method: "POST",
    key: "q-2",
    body: { text: "结合前面的讨论，还有其他解释吗？" },
    status: 202,
  });
  await wait();
  assert(JSON.stringify(f.calls.at(-1)).includes("关系变化是否合理"));
  // Old evidence remains tied to the original immutable revision after editing.
  const first = book.chapters[0].chapterId,
    h = await f.call(`/v1/projects/${book.bookId}/chapters/${first}`);
  await f.call(`/v1/projects/${book.bookId}/chapters/${first}/revisions`, {
    method: "POST",
    key: "edit-later",
    body: {
      baseRevisionId: h.headRevision.revisionId,
      markdown: "后来作者修订了这次争执。",
    },
    status: 201,
  });
  s = await f.call(path);
  assert(
    s.messages[1].sources.some(
      (src) => src.chapterId === first && src.validity === "stale",
    ),
  );
  f.config.hang = true;
  let callsBefore=f.calls.length;
  await f.call(path + "/messages", {
    method: "POST",
    key: "cancel",
    body: { text: "取消测试" },
    status: 202,
  });
  await f.waitForProviderCall(callsBefore);
  await f.call(path + "/cancel", { method: "POST", body: {} });
  s = await f.call(path);
  assert.equal(s.messages.at(-1).status, "cancelled");
  callsBefore=f.calls.length;
  await f.call(path + "/messages", {
    method: "POST",
    key: "crash",
    body: { text: "崩溃恢复测试" },
    status: 202,
  });
  await f.waitForProviderCall(callsBefore);
  await f.stopAgent("SIGKILL");
  await f.restartAgent();
  s = await f.call(path);
  assert.equal(s.messages.at(-1).status, "interrupted");
  assert.equal(s.status, "idle");
  // Recovery is a real backend operation against the accepted user message.
  const crashedRun = s.run.runId, acceptedUsers = s.messages.filter(m=>m.role==='user').length;
  f.config.hang = false;
  const resumeInput = {runId:crashedRun,confirmAdditionalCost:true};
  await f.call(path+'/resume',{method:'POST',key:'resume-crash',body:resumeInput,status:202});
  await wait();
  assert.equal(s.run.status,'completed');assert.equal(s.run.attempt,2);
  assert.equal(s.messages.filter(m=>m.role==='user').length,acceptedUsers);
  const recoveredCalls=f.calls.length;
  await f.call(path+'/resume',{method:'POST',key:'resume-crash',body:resumeInput,status:202});
  assert.equal(f.calls.length,recoveredCalls);
  await f.restartAPI();
  s=await f.call(path);assert.equal(s.run.status,'completed');
  assert.equal(s.messages.filter(m=>m.role==='user').length,acceptedUsers);
  const cancelledSession=await f.call(base+'/sessions',{method:'POST',key:'offline-cancel-session',body:{consent:true,model,scopes:[]},status:201});
  const cancelledPath=base+'/sessions/'+cancelledSession.sessionId;
  f.config.hang=true;callsBefore=f.calls.length;
  await f.call(cancelledPath+'/messages',{method:'POST',key:'api-restart-active',body:{text:'Synthetic input accepted before API restart'},status:202});
  await f.waitForProviderCall(callsBefore);await f.restartAPI();f.config.hang=false;f.releaseProviders();
  await wait(cancelledPath);
  const interruptedByAPI=s.run.status!=='completed';
  if(interruptedByAPI) {
    assert.equal(s.run.failure.code,'SESSION_INTERRUPTED');
    await f.call(cancelledPath+'/resume',{method:'POST',key:'api-restart-resume',body:{runId:s.run.runId,confirmAdditionalCost:true},status:202});
    await wait(cancelledPath);
  }
  assert.equal(s.run.status,'completed');assert.equal(s.messages.filter(m=>m.role==='user').length,1);
  assert.equal(f.calls.length-callsBefore,1+Number(interruptedByAPI));
  f.config.hang=true;callsBefore=f.calls.length;
  await f.call(cancelledPath+'/messages',{method:'POST',key:'offline-cancel-message',body:{text:'Synthetic offline cancellation'},status:202});
  await f.waitForProviderCall(callsBefore);
  await f.stopAgent('SIGKILL');
  const cancelAck=await f.call(cancelledPath+'/cancel',{method:'POST',body:{},status:202});
  assert.equal(cancelAck.status,'cancelled');assert.equal(cancelAck.syncPending,true);
  await f.restartAgent();
  const cancelled=await f.call(cancelledPath);
  assert.equal(cancelled.run.status,'cancelled');assert.equal(cancelled.messages.at(-1).status,'cancelled');
  const beforeCancelledResume=f.calls.length;
  await f.call(cancelledPath+'/resume',{method:'POST',key:'new-key-after-offline-cancel',body:{runId:cancelled.run.runId,confirmAdditionalCost:true},status:409});
  assert.equal(f.calls.length,beforeCancelledResume);
  f.config.hang=false;
  await f.stopAgent();
  await f.call(path, { method: "DELETE", status: 204 });
  await f.restartAgent();
  for (let i = 0; i < 150; i++) {
    const files = await readdir(join(f.root, "pi-state"));
    const stored = files.includes(id + ".json")
      ? JSON.parse(
          await readFile(join(f.root, "pi-state", id + ".json"), "utf8"),
        )
      : null;
    if (stored?.deleted) {
      assert.equal(stored.entries.length, 0);
      assert.equal(stored.view.messages.length, 0);
      break;
    }
    if (i === 149) throw Error("offline deletion was not delivered");
    await delay(50);
  }
  const doomed = await f.call("/v1/studio/books", {
    method: "POST",
    key: "doomed-book",
    status: 201,
    body: { operation: "create", baseVersion: 0, title: "待删除的合成作品" },
  });
  const doomedBase = `/v1/studio/books/${doomed.bookId}/thinking`,
    doomedModel = await f.call(doomedBase + "/capabilities");
  const doomedSession = await f.call(doomedBase + "/sessions", {
    method: "POST",
    key: "doomed-session",
    status: 201,
    body: { consent: true, model: doomedModel, scopes: ["chapters"] },
  });
  await f.stopAgent();
  await f.call(`/v1/studio/books/${doomed.bookId}`, {
    method: "DELETE",
    key: "delete-book",
    body: { baseVersion: doomed.version },
    status: 204,
  });
  await f.call(doomedBase + "/sessions/" + doomedSession.sessionId, {
    status: 404,
  });
  await f.restartAgent();
  for (let i = 0; i < 150; i++) {
    const stored = JSON.parse(
      await readFile(
        join(f.root, "pi-state", doomedSession.sessionId + ".json"),
        "utf8",
      ),
    );
    if (stored.deleted) {
      assert.deepEqual(stored.entries, []);
      assert.deepEqual(stored.view.messages, []);
      break;
    }
    if (i === 149) throw Error("deleted book left private session");
    await delay(50);
  }
  console.log(
    "PASS: Go + real Pi SDK processes, 3 saved chapter sources, signed grants, short polling/SSE replay, multi-turn restart, stale citations, cancel, SIGKILL + explicit Resume, Go API restart, offline cancellation fence, offline deletion. Fixture model only; semantic quality unvalidated.",
  );
} finally {
  await f.close();
}
