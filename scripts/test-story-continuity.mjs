import assert from "node:assert/strict";
import {setTimeout as delay} from "node:timers/promises";
import {startThinkingFixture} from "./lib/thinking-fixture.mjs";
import {storyContextSchema, storyChangeListSchema} from "../packages/contracts/dist/creative.js";

// Synthetic model choices exercise the real Pi SDK, private tool boundary and
// durable Go state. Intent classification quality needs separate model review.
let program = [], failAfterWrite = false, providerError;
const textOf = body => body.messages.map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
const currentID = body => {
  const id = textOf(body).match(/Current author message: ([^.\s]+)\./)?.[1];
  assert(id, "fresh context must identify the actual current author message");
  return id;
};
const lastTool = body => JSON.parse(body.messages.findLast(m => m.role === "tool").content);
let toolSequence = 0;
const tool = (name, args) => ({tool_calls: [{index: 0, id: `story-${++toolSequence}`, type: "function", function: {name, arguments: JSON.stringify(args)}}]});
const record = (quote, changes) => body => tool("record_story_changes", {changes: changes.map(change => ({...change, evidence: [{messageId: currentID(body), quote}]}))});
const done = body => {
  const latest = body.messages.at(-1);
  if (latest.role === "tool") assert.notEqual(lastTool(body).ok, false, latest.content);
  return {content: "这轮讨论已经整理，我们继续推进人物的选择与代价。"};
};
const f = await startThinkingFixture({
  chatModels: true, chatDelayMs: 0,
  chatStatus: body => failAfterWrite && body.messages.at(-1).role === "tool" ? 400 : undefined,
  chatDelta: body => {
    try { return (program.shift() ?? done)(body); }
    catch (error) { providerError = error; return {content: "Synthetic assertion failed."}; }
  },
});
try {
  const book = await f.call("/v1/studio/books", {method:"POST",key:"story-book",status:201,body:{operation:"create",baseVersion:0,title:"对话创作合成作品"}});
  const base = `/v1/studio/books/${book.bookId}`, creative = base + "/creative", thinking = base + "/thinking";
  const modelId = (await f.call(thinking + "/models")).items[0].modelId;
  await f.call(thinking + "/preferences", {method:"POST",body:{scopes:["creative"]}});
  const createSession = key => f.call(thinking + "/sessions", {method:"POST",key,status:201,body:{consent:true,modelId,scopes:["creative"]}});
  const first = await createSession("first-discussion");
  const path = session => thinking + "/sessions/" + session.sessionId;
  const context = async session => storyContextSchema.parse(await f.call(creative + "/story-context?sessionId=" + session.sessionId));
  const changes = async session => storyChangeListSchema.parse(await f.call(creative + "/changes?sessionId=" + session.sessionId)).items;
  const wait = async session => {
    for (let i = 0; i < 250; i++) {
      const view = await f.call(path(session));
      if (view.status === "idle") {
        if (providerError) throw providerError;
        return view;
      }
      await delay(40);
    }
    throw Error("Story continuity run timed out");
  };
  let turn = 0;
  const send = async (session, text, steps, expected = "completed") => {
    program = steps;
    const receipt = await f.call(path(session) + "/messages", {method:"POST",key:`story-turn-${++turn}`,status:202,body:{text}});
    const view = await wait(session);
    assert.equal(view.messages.at(-1).status, expected, JSON.stringify(view.messages.at(-1)));
    assert.equal(program.length, 0, "provider did not execute the planned tool sequence");
    return {receipt, view};
  };
  assert.equal((await context(first)).dialogueRecording, false);
  await f.call(creative + "/settings/recording", {method:"POST",key:"enable-recording",body:{dialogueRecording:true}});
  const initial = "我要写一部关于信任的悬疑小说。主角叫林舟，小名阿舟，是一名法医。";
  await send(first, initial, [
    record(initial, [
      {intent:"decide",kind:"story_intent",patch:{name:"作品方向",summary:"关于信任的悬疑小说"}},
      {intent:"decide",kind:"character",patch:{name:"林舟",addAliases:["阿舟"],setFields:[{key:"职业",value:"法医"}]}},
    ]),
    body => {
      const saved = lastTool(body);
      assert.equal(saved.status, "applied", JSON.stringify(saved));
      const assetId = saved.changes.find(c => c.name === "林舟").assetId;
      return tool("update_discussion_focus", {goal:"确定林舟的动机",assetIds:[assetId],questionIds:[],suggestedNextStep:"讨论他为何追查旧案"});
    }, done,
  ]);
  let story = await context(first), hero = story.confirmed.find(a => a.name === "林舟");
  assert.equal(story.intent[0].summary, "关于信任的悬疑小说");
  assert.equal(story.focus.goal, "确定林舟的动机");
  const supplement = "阿舟追查旧案，是为了替父亲洗清冤屈。";
  await send(first, supplement, [body => {
    assert(textOf(body).includes(hero.assetId), "alias lookup should inject the existing character");
    return record(supplement, [{intent:"decide",targetAssetId:hero.assetId,baseVersion:hero.version,patch:{setFields:[{key:"动机",value:"替父亲洗清冤屈"}]}}])(body);
  },done]);
  hero = (await context(first)).confirmed.find(a => a.assetId === hero.assetId);
  assert.equal(hero.fields.find(v => v.key === "职业").value, "法医");
  assert.equal(hero.version, 2);
  const modification = "把林舟的职业改为记者，查案动机保持不变。";
  await send(first, modification, [record(modification,[{intent:"decide",targetAssetId:hero.assetId,baseVersion:hero.version,patch:{setFields:[{key:"职业",value:"记者"}]}}]),done]);
  hero = (await context(first)).confirmed.find(a => a.assetId === hero.assetId);
  assert.equal(hero.version, 3);
  assert.equal(hero.fields.find(v => v.key === "动机").value, "替父亲洗清冤屈");
  const hypothetical = "也许父亲其实是叛徒，先作为备选，不要定下来。";
  await send(first, hypothetical, [record(hypothetical,[{intent:"explore",kind:"plot_line",patch:{name:"父亲是叛徒",summary:"父亲可能背叛了同伴"}}]),done]);
  story = await context(first);
  const alternative = story.alternatives.find(p => p.draft?.name === "父亲是叛徒");
  assert(alternative);
  assert(!story.confirmed.some(a => a.name === "父亲是叛徒"));
  const rejection = "不要父亲是叛徒这条线。";
  await send(first,rejection,[record(rejection,[{intent:"reject",targetProposalId:alternative.proposalId,patch:{}}]),done]);
  story = await context(first);
  assert.equal(story.alternatives.length, 0);
  assert.equal(story.rejected[0].proposalId, alternative.proposalId);
  const defer = "母亲为什么失踪先放着，以后再讨论。";
  await send(first,defer,[record(defer,[{intent:"defer",kind:"open_question",patch:{name:"母亲失踪的原因",summary:"暂缓讨论母亲为何失踪"}}]),done]);
  assert.equal((await context(first)).questions[0].questionStatus, "deferred");

  const second = await createSession("second-discussion");
  assert.equal((await context(second)).focus, null, "discussion focus must not leak into another session");
  await send(second,"继续聊阿舟的故事。",[body => {
    const input = textOf(body);
    for (const value of [hero.assetId,"记者","替父亲洗清冤屈","父亲是叛徒","deferred","母亲失踪的原因"])
      assert(input.includes(value), `fresh context missing ${value}`);
    return done(body);
  }]);
  assert.equal((await context(first)).focus.goal, "确定林舟的动机");

  const interruption = "故事发生在北城。";
  const recordCity = record(interruption,[{intent:"decide",kind:"place",patch:{name:"北城",summary:"故事发生地"}}]);
  failAfterWrite = true;
  const failed = await send(second, interruption, [recordCity], "failed");
  const durable = (await changes(second)).find(r => r.messageId === failed.receipt.messageId);
  assert(durable, "a failed answer must still expose its committed changes");
  const city = (await context(second)).confirmed.find(a => a.name === "北城");
  assert.equal(city.version, 1);
  failAfterWrite = false;
  program = [recordCity,done];
  await f.call(path(second) + "/resume",{method:"POST",key:"resume-saved-change",status:202,body:{runId:failed.view.run.runId,confirmAdditionalCost:true}});
  const resumed = await wait(second);
  assert.equal(resumed.messages.at(-1).status,"completed",JSON.stringify(resumed.messages.at(-1)));
  assert.equal((await changes(second)).filter(r => r.messageId === failed.receipt.messageId).length,1);
  assert.equal((await context(second)).confirmed.find(a => a.name === "北城").version,1);
  const undone = await f.call(creative + "/changes/" + durable.changeId + "/undo",{method:"POST",key:"undo-city",body:{}});
  assert.equal(undone.status,"undone");
  assert(!((await context(second)).confirmed.some(a => a.name === "北城")));
  assert.deepEqual(await f.call(creative + "/changes/" + durable.changeId + "/undo",{method:"POST",key:"undo-city",body:{}}),undone);

  const firstReceipts = await changes(first);
  const modified = firstReceipts.find(r => r.changes.some(c => c.after?.assetId === hero.assetId && c.after.version === 3));
  const supplemented = firstReceipts.find(r => r.changes.some(c => c.after?.assetId === hero.assetId && c.after.version === 2));
  await f.call(creative + "/changes/" + supplemented.changeId + "/undo",{method:"POST",key:"old-update-conflict",body:{},status:409});
  await f.call(creative + "/changes/" + modified.changeId + "/undo",{method:"POST",key:"undo-latest-update",body:{}});
  hero = (await context(first)).confirmed.find(a => a.assetId === hero.assetId);
  assert.equal(hero.version,4);
  assert.equal(hero.fields.find(v => v.key === "职业").value,"法医");
  assert.equal(hero.fields.find(v => v.key === "动机").value,"替父亲洗清冤屈");
  await f.call(creative + "/settings/recording", {method:"POST",key:"disable-recording",body:{dialogueRecording:false}});
  await send(second,"总结一下当前设定。",[body => {
    assert(!(body.tools ?? []).some(t => ["record_story_changes","update_discussion_focus"].includes(t.function?.name)));
    assert(textOf(body).includes("法医"),"read context remains fresh while recording is disabled");
    return done(body);
  }]);
  console.log("Story continuity: real Go + Pi context, decisions, candidates, focus, resume and undo passed (synthetic model).");
} finally {
  await f.close();
}
