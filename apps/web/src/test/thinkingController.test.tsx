import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, it, expect, vi } from "vitest";
import type { ThinkingSession } from "@writer-agent/contracts";
import { useThinking } from "../features/thinking/useThinking";
import { thinkingApi as api } from "../services/api/thinkingApi";
const model: ThinkingSession["model"] = {
  modelId: "deepseek",
  provider: "fixture",
  model: "fixture",
  endpoint: "https://model.example",
  protocol: "thinking-v1",
  limits: {
    maxTurnsPerRequest: 2,
    maxToolCalls: 2,
    maxInputTokens: 32000,
    maxOutputTokens: 100,
    maxSessionTokens: 100000,
    maxConcurrentSessions: 2,
    maxDurationMs: 10000,
    maxToolResultBytes: 1000,
  },
};
const session = (id: string): ThinkingSession => ({
  sessionId: id,
  bookId: "book-a",
  title: id,
  createdAt: "now",
  model,
  scopes: ["chapters"],
  status: "idle",
  messages: [],
  cursor: 0,
  usage: { input: 0, output: 0, charged: 0, incomplete: false },
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
});
function setup() {
  vi.spyOn(api, "models").mockResolvedValue([{modelId:"deepseek",displayName:"DeepSeek",provider:"deepseek",hostedBy:"DeepSeek",description:"创作讨论",enabled:true,toolCalling:true,pointMultiplier:1}, {modelId:"oss",displayName:"GPT-OSS",provider:"bedrock",hostedBy:"Amazon Bedrock",description:"创作讨论",enabled:true,toolCalling:true,pointMultiplier:1}]);
  vi.spyOn(api, "preferences").mockResolvedValue({scopes:[]});
  vi.spyOn(api, "capabilities").mockResolvedValue(model);
  vi.spyOn(api, "list").mockResolvedValue([session("A"), session("B")]);
  vi.spyOn(api, "get").mockImplementation(async (_b, id) => session(id));
  vi.spyOn(api, "events").mockResolvedValue({
    items: [],
    cursor: 0,
    status: "idle",
  });
  return renderHook(() => useThinking("book-a", true));
}
it("late cancellation for A cannot overwrite B or clear B pending action", async () => {
  const a = deferred<ThinkingSession>(),
    b = deferred<{ messageId: string }>();
  vi.spyOn(api, "cancel").mockImplementation(() => a.promise);
  vi.spyOn(api, "send").mockImplementation(() => b.promise);
  const { result } = setup();
  act(() => result.current.select("A"));
  await waitFor(() => expect(result.current.session?.sessionId).toBe("A"));
  act(() => result.current.cancel());
  await waitFor(() => expect(result.current.busy).toBe(true));
  act(() => result.current.select("B"));
  await waitFor(() => expect(result.current.session?.sessionId).toBe("B"));
  act(() => result.current.send({ text: "B question" }));
  await waitFor(() => expect(result.current.busy).toBe(true));
  await act(async () => {
    a.resolve(session("A"));
  });
  expect(result.current.session?.sessionId).toBe("B");
  expect(result.current.busy).toBe(true);
  await act(async () => {
    b.resolve({ messageId: "B-message" });
  });
  await waitFor(() => expect(result.current.busy).toBe(false));
  expect(result.current.session?.sessionId).toBe("B");
});
it("transport retry preserves accepted intent key; successful admission clears the draft", async () => {
  const send = vi
    .spyOn(api, "send")
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce({ messageId: "accepted" });
  const { result } = setup();
  act(() => result.current.select("A"));
  await waitFor(() => expect(result.current.session?.sessionId).toBe("A"));
  act(() => {
    result.current.setDraft("same question");
    result.current.send({ text: "same question" });
  });
  await waitFor(() => expect(result.current.error).toContain("对话已保留"));
  expect(result.current.draft).toBe("same question");
  act(() => result.current.send({ text: "same question" }));
  await waitFor(() => expect(result.current.busy).toBe(false));
  expect(send.mock.calls[0][3]).toBe(send.mock.calls[1][3]);
  expect(result.current.draft).toBe("");
});
it("offline capabilities do not hide Go history or block durable deletion", async () => {
  const { result } = setup();
  vi.mocked(api.capabilities).mockRejectedValue(new Error("Agent offline"));
  vi.mocked(api.get).mockRejectedValue(new Error("Agent offline"));
  const remove = vi.spyOn(api, "delete").mockResolvedValue();
  await act(async () => {
    await result.current.reload();
  });
  await waitFor(() => expect(result.current.sessions).toHaveLength(2));
  expect(result.current.model).toBeNull();
  act(() => result.current.select("A"));
  await waitFor(() => expect(result.current.error).toContain("重新连接"));
  act(() => result.current.remove());
  await waitFor(() => expect(remove).toHaveBeenCalledWith("book-a", "A"));
  await waitFor(() => expect(result.current.selected).toBeNull());
  expect(result.current.sessions.map((s) => s.sessionId)).toEqual(["B"]);
});

it("first send creates automatically, preserves draft after a lost response, and replays the same message key", async () => {
  const create=vi.spyOn(api,"create").mockResolvedValue(session("new"));
  const send=vi.spyOn(api,"send").mockRejectedValueOnce(Error("network interrupted")).mockResolvedValue({messageId:"m"});
  const {result}=setup();
  await waitFor(()=>expect(result.current.modelChoice).toBe("deepseek"));
  act(()=>{result.current.setDraft("张居正与平行宇宙");result.current.send({text:"张居正与平行宇宙"})});
  await waitFor(()=>expect(result.current.error).toContain("对话已保留"));
  expect(result.current.draft).toContain("张居正");
  expect(create.mock.calls[0][1]).toEqual({modelId:"deepseek"});
  act(()=>result.current.send({text:"张居正与平行宇宙"}));
  await waitFor(()=>expect(result.current.busy).toBe(false));
  expect(create).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][3]).toBe(send.mock.calls[1][3]);
  expect(result.current.draft).toBe("");
});
it("model selection changes only next message; persisted draft survives remount", async () => {
  const send=vi.spyOn(api,"send").mockResolvedValue({messageId:"m"});
  const one=setup();await waitFor(()=>expect(one.result.current.models).toHaveLength(2));
  act(()=>{one.result.current.select("A");one.result.current.setDraft("没有发送的想法")});
  one.unmount();
  const two=renderHook(()=>useThinking("book-a",true));
  await waitFor(()=>expect(two.result.current.session?.sessionId).toBe("A"));
  expect(two.result.current.draft).toBe("没有发送的想法");
  act(()=>two.result.current.chooseModel("oss"));
  act(()=>two.result.current.send({text:"继续"}));
  await waitFor(()=>expect(send).toHaveBeenCalled());
  expect(send.mock.calls[0][2].modelId).toBe("oss");
});

it("reload after ambiguous delivery preserves the outbox key instead of charging a second intent", async () => {
  const send=vi.spyOn(api,"send").mockRejectedValueOnce(Error("lost response")).mockResolvedValue({messageId:"accepted"});
  const first=setup();await waitFor(()=>expect(first.result.current.modelChoice).toBe("deepseek"));
  act(()=>first.result.current.select("A"));await waitFor(()=>expect(first.result.current.session?.sessionId).toBe("A"));
  act(()=>{first.result.current.setDraft("same intent");first.result.current.send({text:"same intent"})});
  await waitFor(()=>expect(first.result.current.error).toContain("对话已保留"));
  const key=send.mock.calls[0][3];first.unmount();
  const next=renderHook(()=>useThinking("book-a",true));
  await waitFor(()=>expect(next.result.current.modelChoice).toBe("deepseek"));
  await waitFor(()=>expect(next.result.current.session?.sessionId).toBe("A"));
  act(()=>next.result.current.send({text:"same intent"}));
  await waitFor(()=>expect(send).toHaveBeenCalledTimes(2));
  expect(send.mock.calls[1][3]).toBe(key);
});

it("a rejected model switch restores the previous model and keeps the draft", async () => {
 vi.spyOn(api,"send").mockRejectedValue(Object.assign(Error("unavailable"),{code:"MODEL_UNAVAILABLE"}));
 const {result}=setup();await waitFor(()=>expect(result.current.modelChoice).toBe("deepseek"));
 act(()=>result.current.select("A"));await waitFor(()=>expect(result.current.session?.sessionId).toBe("A"));
 act(()=>result.current.chooseModel("oss"));
 act(()=>{result.current.setDraft("保留的想法");result.current.send({text:"保留的想法"})});
 await waitFor(()=>expect(result.current.modelChoice).toBe("deepseek"));expect(result.current.draft).toBe("保留的想法");
});

it("A → B → A preserves each session model and the actual modelId sent", async () => {
 const send=vi.spyOn(api,"send").mockResolvedValue({messageId:"m"});
 const {result}=setup();
 vi.mocked(api.get).mockImplementation(async(_book,id)=>({...session(id),model:{...model,modelId:id==='B'?'oss':'deepseek'}}));
 act(()=>result.current.select("A"));await waitFor(()=>expect(result.current.session?.sessionId).toBe("A"));
 expect(result.current.modelChoice).toBe("deepseek");
 act(()=>result.current.select("B"));await waitFor(()=>expect(result.current.modelChoice).toBe("oss"));
 act(()=>result.current.send({text:"B first"}));await waitFor(()=>expect(result.current.busy).toBe(false));
 act(()=>result.current.select("A"));await waitFor(()=>expect(result.current.modelChoice).toBe("deepseek"));
 act(()=>result.current.send({text:"A again"}));await waitFor(()=>expect(send).toHaveBeenCalledTimes(2));
 expect(send.mock.calls.map(c=>[c[1],c[2].modelId])).toEqual([["B","oss"],["A","deepseek"]]);
});
it("uncertain A delivery survives a successful B send, reload, and A retry", async () => {
 const send=vi.spyOn(api,"send").mockRejectedValueOnce(Error("A lost acknowledgement")).mockResolvedValue({messageId:"m"});
 const first=setup();
 act(()=>first.result.current.select("A"));await waitFor(()=>expect(first.result.current.session?.sessionId).toBe("A"));
 act(()=>{first.result.current.setDraft("A original");first.result.current.send({text:"A original"})});
 await waitFor(()=>expect(first.result.current.error).toContain("对话已保留"));
 const key=send.mock.calls[0][3];
 act(()=>first.result.current.select("B"));await waitFor(()=>expect(first.result.current.session?.sessionId).toBe("B"));
 act(()=>first.result.current.send({text:"B independent"}));await waitFor(()=>expect(first.result.current.busy).toBe(false));
 first.unmount();const next=renderHook(()=>useThinking("book-a",true));
 act(()=>next.result.current.select("A"));await waitFor(()=>expect(next.result.current.session?.sessionId).toBe("A"));
 act(()=>next.result.current.send({text:"A original"}));await waitFor(()=>expect(send).toHaveBeenCalledTimes(3));
 expect(send.mock.calls[2][3]).toBe(key);
});
it("an exact receipt in server history confirms A without resending or matching prose", async () => {
 const send=vi.spyOn(api,"send").mockRejectedValueOnce(Error("lost acknowledgement"));
 const {result}=setup();act(()=>result.current.select("A"));await waitFor(()=>expect(result.current.session?.sessionId).toBe("A"));
 act(()=>result.current.send({text:"duplicate-looking text"}));await waitFor(()=>expect(result.current.error).toContain("对话已保留"));
 const key=send.mock.calls[0][3];
 vi.mocked(api.get).mockResolvedValue({...session("A"),messages:[{id:"accepted",role:"user",requestKey:key,text:"duplicate-looking text",status:"completed",createdAt:"now",sources:[]}]});
 act(()=>result.current.send({text:"duplicate-looking text"}));await waitFor(()=>expect(result.current.busy).toBe(false));
 expect(send).toHaveBeenCalledTimes(1);
});
it("obsolete defaults migrate for new topics, but missing historical models require explicit selection", async () => {
 sessionStorage.setItem("thinking-model:book-a","default");
 const send=vi.spyOn(api,"send").mockResolvedValue({messageId:"m"});
 const {result}=setup();await waitFor(()=>expect(result.current.modelChoice).toBe("deepseek"));
 vi.mocked(api.get).mockResolvedValue({...session("retired"),model:{...model,modelId:"removed-provider"}});
 act(()=>result.current.select("retired"));await waitFor(()=>expect(result.current.modelChoice).toBe("removed-provider"));
 expect(result.current.modelAvailable).toBe(false);expect(result.current.modelNotice).toContain("主动选择");
 act(()=>result.current.send({text:"must not switch silently"}));expect(send).not.toHaveBeenCalled();
 act(()=>result.current.chooseModel("oss"));expect(result.current.modelAvailable).toBe(true);
 act(()=>result.current.send({text:"explicitly switched"}));await waitFor(()=>expect(send).toHaveBeenCalledTimes(1));
 expect(send.mock.calls[0][2].modelId).toBe("oss");
});

it("reconnects after the initial snapshot fails without requiring page refresh", async () => {
 const {result}=setup();
 await waitFor(()=>expect(result.current.models).toHaveLength(2));
 vi.mocked(api.get).mockRejectedValueOnce(Error("offline"));
 act(()=>result.current.select("A"));
 await waitFor(()=>expect(result.current.error).toBeTruthy());
 // Trigger the same wakeup a browser emits when its network returns.
 act(()=>window.dispatchEvent(new Event("online")));
 await waitFor(()=>expect(result.current.session?.sessionId).toBe("A"));
});

it("online recovery reloads model capabilities as well as the session snapshot",async()=>{
 const {result}=setup();await waitFor(()=>expect(result.current.model).not.toBeNull());
 vi.mocked(api.capabilities).mockRejectedValueOnce(Error("private stack must not leak"));
 await act(async()=>{await result.current.reload()});expect(result.current.model).toBeNull();
 expect(result.current.error).not.toContain("private stack");
 act(()=>window.dispatchEvent(new Event("online")));
 await waitFor(()=>expect(result.current.model).not.toBeNull());
});

it("a definitive cancelled-request fence releases the outbox without losing the author's draft",async()=>{
 const send=vi.spyOn(api,"send").mockRejectedValueOnce(Object.assign(Error("fenced"),{code:"SESSION_INTERRUPTED"})).mockResolvedValue({messageId:"next"});
 const {result}=setup();act(()=>result.current.select("A"));await waitFor(()=>expect(result.current.session?.sessionId).toBe("A"));
 act(()=>{result.current.setDraft("cancelled original");result.current.send({text:"cancelled original"})});
 await waitFor(()=>expect(result.current.error).toContain("已中断"));
 expect(result.current.pendingDelivery).toBeUndefined();expect(result.current.draft).toBe("cancelled original");
 act(()=>result.current.send({text:"new author question"}));await waitFor(()=>expect(send).toHaveBeenCalledTimes(2));
 expect(send.mock.calls[1][3]).not.toBe(send.mock.calls[0][3]);
});
