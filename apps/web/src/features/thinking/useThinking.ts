import { useCallback, useEffect, useRef, useState } from "react";
import type { ThinkingCreate, ThinkingMessageInput, ThinkingModel, ThinkingModelOption, ThinkingSession } from "@writer-agent/contracts";
import { thinkingApi as api } from "../../services/api/thinkingApi";
import { thinkingError } from "./errors";
import { scopedKey } from "../../services/storageScope";
import { applyToolEvents, type ToolStep } from "./toolActivity";
import { emptyOutbox, readChoices, readOutbox, saveBrowserState } from "./conversationState";
type Summary = Pick<ThinkingSession, "sessionId" | "bookId" | "title" | "createdAt" | "model" | "scopes" | "status">;
const errorText = (e: unknown) => e instanceof Error
  ? ((e as Error & {code?: string}).code ? thinkingError((e as Error & {code?: string}).code) : e.message)
  : "思考服务暂不可用，请保留输入后重试。";
const readText = (key: string) => {try {return sessionStorage.getItem(key) ?? ""} catch {return ""}};
const modelID = (s: ThinkingSession) => s.model.modelId ?? "default";
const sameInput = (a: ThinkingMessageInput, b: ThinkingMessageInput) => JSON.stringify(a) === JSON.stringify(b);
export function useThinking(book: string, enabled: boolean) {
  const partition = scopedKey(book), outboxKey = "thinking-outbox:" + partition,
    choicesKey = "thinking-models:" + partition, draftKey = "thinking-draft:" + partition;
  const [outgoing, setOutgoing] = useState("");
  const [models, setModels] = useState<ThinkingModelOption[]>([]);
  const [modelChoice, setModelChoice] = useState("");
  const [scopes, setScopes] = useState<("chapters" | "knowledge" | "creative" | "notes")[]>([]);
  const [sessions, setSessions] = useState<Summary[]>([]), [model, setModel] = useState<ThinkingModel | null>(null),
    [selected, setSelected] = useState<string | null>(() => readText("thinking-v1:" + partition) || null),
    [session, setSession] = useState<ThinkingSession | null>(null), [error, setError] = useState(""),
    [busy, setBusy] = useState(false), [tool, setTool] = useState(""),
    [steps, setSteps] = useState<ToolStep[]>([]), [draft, setDraftRaw] = useState(() => readText(draftKey));
  const stepId = useRef(0), epoch = useRef(0), request = useRef(0), operation = useRef(0),
    outbox = useRef(emptyOutbox()), choices = useRef<Record<string, string>>({}),
    sending = useRef(new Set<string>()), selectedRef = useRef(selected), catalogue = useRef(models);
  catalogue.current = models;
  const setDraft = (value: string) => {
    setDraftRaw(value);
    try {sessionStorage.setItem(draftKey, value)} catch { /* optional */ }
  };
  useEffect(() => {
    const generation = ++epoch.current;
    outbox.current = readOutbox(outboxKey); choices.current = readChoices(choicesKey);
    // The former work-wide choice is only a preference for a NEW topic.
    if (!choices.current.new) choices.current.new = readText("thinking-model:" + partition);
    const id = readText("thinking-v1:" + partition) || null;
    selectedRef.current = id; setSelected(id); setSession(null); setSessions([]); setModels([]);
    setModelChoice(id ? choices.current[id] ?? "" : choices.current.new ?? "");
    setDraftRaw(readText(draftKey)); setScopes([]); setOutgoing(""); setBusy(false); setError("");
    sending.current = new Set();
    return () => {epoch.current = generation + 1};
  }, [partition, outboxKey, choicesKey, draftKey]);
  const select = useCallback((id: string | null) => {
    request.current++; operation.current++; selectedRef.current = id;
    setBusy(false); setSelected(id); setSession(null); setOutgoing(""); setTool(""); setSteps([]); setError("");
    if (id) setModelChoice(choices.current[id] ?? "");
    else {
      const preferred = choices.current.new;
      setModelChoice(catalogue.current.some(m => m.modelId === preferred && m.enabled) ? preferred : catalogue.current.find(m => m.enabled)?.modelId ?? "");
    }
    try {if(id) sessionStorage.setItem("thinking-v1:" + partition, id);else sessionStorage.removeItem("thinking-v1:" + partition)} catch { /* optional */ }
  }, [partition]);
  // A server-confirmed receipt, not matching prose, proves delivery. An old server
  // without requestKey is safely reconciled by replaying the SAME key on retry.
  const acceptSnapshot = useCallback((value: ThinkingSession) => {
    const pending = outbox.current.pending[value.sessionId];
    if (pending && value.messages.some(m => m.role === "user" && (m.requestKey === pending.key || (pending.messageId && m.id === pending.messageId)))) {
      delete outbox.current.pending[value.sessionId]; saveBrowserState(outboxKey, outbox.current);
      setDraftRaw(old => {
        if (old.trim() !== pending.input.text.trim()) return old;
        try {sessionStorage.removeItem(draftKey)} catch { /* optional */ }
        return "";
      });
    }
    setSession(value);
    setSessions(old => old.some(s => s.sessionId === value.sessionId) ? old.map(s => s.sessionId === value.sessionId ? {...s,title:value.title,model:value.model,status:value.status} : s) : [value,...old]);
    setModelChoice(choices.current[value.sessionId] ?? modelID(value));
  }, [outboxKey, draftKey]);
  const reload = useCallback(async (signal?: AbortSignal) => {
    const e = epoch.current, current = () => e === epoch.current && !signal?.aborted;
    const results = await Promise.allSettled([
      api.models(book, signal).then(items => {
        if (!current()) return;
        setModels(items); catalogue.current = items;
        // Historical conversations retain their own choice, including a missing model.
        if (!selectedRef.current) setModelChoice(old => items.some(m => m.modelId === old && m.enabled) ? old : items.find(m => m.enabled)?.modelId ?? "");
      }),
      api.preferences(book, signal).then(value => {if(current()) setScopes(value.scopes)}),
      api.list(book, signal).then(items => {if(current()) setSessions(items)}),
      api.capabilities(book, signal).then(cap => {if(current()) setModel(cap)}).catch(err => {if(current()) setModel(null);throw err}),
    ]);
    if(current()) {const failure = results.find(r => r.status === "rejected");setError(failure?.status === "rejected" ? errorText(failure.reason) : "")}
  }, [book]);
  useEffect(() => {
    if (!enabled) return;
    const c = new AbortController(); void reload(c.signal); return () => c.abort();
  }, [enabled, reload, partition]);
  useEffect(() => {
    if (!enabled || !selected || busy) return;
    const c = new AbortController(), e = epoch.current, r = request.current;
    let timer: ReturnType<typeof setTimeout> | undefined, cursor = 0;
    const current = () => !c.signal.aborted && e === epoch.current && r === request.current;
    const poll = async () => {
      try {
        const events = await api.events(book, selected, cursor, c.signal); if(!current()) return;
        cursor = events.cursor;
        for(const event of events.items) {if(event.type === "tool_started") setTool(event.tool ?? "");if(event.type === "tool_completed") setTool("")}
        if(events.items.some(e => e.type === "tool_started" || e.type === "tool_completed")) setSteps(prev => applyToolEvents(prev, events.items, () => ++stepId.current));
        const value = await api.get(book, selected, c.signal); if(!current()) return;
        acceptSnapshot(value); setError("");
        if(value.status === "running" || events.cursor < value.cursor) timer = setTimeout(() => void poll(), 500);
      } catch(err) {if(current()) {setError(errorText(err));timer = setTimeout(() => void poll(), 3000)}}
    };
    void (async () => {
      try {
        const value = await api.get(book, selected, c.signal); if(!current()) return;
        acceptSnapshot(value); cursor = value.cursor; if(value.status === "running") void poll();
      } catch(err) {if(current()) setError(errorText(err))}
    })();
    return () => {c.abort();clearTimeout(timer)};
  }, [book, selected, enabled, busy, acceptSnapshot, partition]);
  const action = async <T>(fn: () => Promise<T>, apply: (v: T) => void) => {
    const e = epoch.current, r = request.current, op = ++operation.current;
    setBusy(true); setError("");
    try {const v = await fn();if(e === epoch.current && r === request.current) apply(v)}
    catch(err) {if(e === epoch.current && r === request.current) setError(errorText(err))}
    finally {if(e === epoch.current && op === operation.current) setBusy(false)}
  };
  const create = (scopes: ThinkingCreate["scopes"]) => {
    if (!model) return;
    const input: ThinkingCreate = {consent:true, model, scopes};
    if(!outbox.current.creating || JSON.stringify(outbox.current.creating.input) !== JSON.stringify(input)) outbox.current.creating = {key:crypto.randomUUID(), input};
    const p = outbox.current.creating; saveBrowserState(outboxKey, outbox.current);
    void action(() => api.create(book, p.input, p.key), value => {
      outbox.current.creating = null; saveBrowserState(outboxKey, outbox.current);
      setSessions(old => [value, ...old.filter(s => s.sessionId !== value.sessionId)]); select(value.sessionId); acceptSnapshot(value);
    });
  };
  const modelAvailable = models.some(m => m.modelId === modelChoice && m.enabled);
  const modelNotice = selected && session && !modelAvailable ? "这次讨论原来使用的模型暂不可用，请主动选择其他模型后再发送。历史记录仍保留。" : "";
  const send = (input: ThinkingMessageInput) => {
    const slot = selected ?? "new";
    if (sending.current.has(slot) || session?.status === "running") return;
    if (models.length && !modelAvailable) {setError(modelNotice || "请选择一个当前可用的模型。");return}
    if (selected && (!session || session.sessionId !== selected)) {setError("正在读取这次讨论，请稍候再发送。");return}
    const e = epoch.current, r = request.current;
    const value = {...input, ...(modelChoice ? {modelId: modelChoice} : {})};
    sending.current.add(slot); setOutgoing(input.text);
    void action(async () => {
      let id = selected;
      if (!id) {
        if (!outbox.current.creating) outbox.current.creating = {key:crypto.randomUUID(),input:{modelId:modelChoice || undefined}};
        saveBrowserState(outboxKey, outbox.current);
        const c = outbox.current.creating;
        const created = await api.create(book,c.input,c.key);
        if(e !== epoch.current || r !== request.current) return null;
        id = created.sessionId; selectedRef.current = id; setSelected(id); setSession(created);
        choices.current[id] = modelChoice; saveBrowserState(choicesKey, choices.current);
        setSessions(old => [created, ...old.filter(s => s.sessionId !== id)]);
        try {sessionStorage.setItem("thinking-v1:" + partition,id)} catch { /* optional */ }
        outbox.current.creating = null;
      }
      const old = outbox.current.pending[id];
      // Always inspect the authoritative snapshot before replaying an uncertain send.
      if(old) {
        const snapshot = await api.get(book,id);
        if(e !== epoch.current) return null;
        const delivered = snapshot.messages.some(m => m.role === "user" && (m.requestKey === old.key || (old.messageId && m.id === old.messageId)));
        if(delivered) {
          delete outbox.current.pending[id];saveBrowserState(outboxKey,outbox.current);
          if(sameInput(old.input,value)) return snapshot;
        } else if(!sameInput(old.input,value)) throw Error("上一条消息是否送达尚未确认，请先使用原问题重试。原始重试记录仍然保留。");
      }
      if(!outbox.current.pending[id]) outbox.current.pending[id] = {key:crypto.randomUUID(),id,input:value};
      const p = outbox.current.pending[id];saveBrowserState(outboxKey,outbox.current);
      try {
        const receipt = await api.send(book,id,p.input,p.key);
        if(e !== epoch.current) return null;
        p.messageId = receipt.messageId;saveBrowserState(outboxKey,outbox.current);
      } catch(err) {
        if((err as {code?:string})?.code === "MODEL_UNAVAILABLE" && e === epoch.current && r === request.current && session) {
          // This explicit rejection is not an ambiguous network failure. Pi did not
          // accept this new intent; keep the draft but allow a different model.
          if(outbox.current.pending[id] === p) delete outbox.current.pending[id];
          saveBrowserState(outboxKey,outbox.current);
          delete choices.current[id];saveBrowserState(choicesKey,choices.current);setModelChoice(modelID(session));
        }
        throw err;
      }
      const result = await api.get(book,id);
      if(e === epoch.current) {
        // POST acknowledged this exact intent even with a pre-requestKey backend.
        if(outbox.current.pending[id] === p) delete outbox.current.pending[id];
        saveBrowserState(outboxKey,outbox.current);
      }
      return result;
    }, result => {
      if(!result) return;
      acceptSnapshot(result);
      setDraftRaw(old => {if(old.trim() !== input.text.trim()) return old;try {sessionStorage.removeItem(draftKey)} catch { /* optional */ }return ""});
      setSteps([]);
    }).finally(() => {if(e === epoch.current) {sending.current.delete(slot);if(r === request.current) setOutgoing("")}});
  };
  const chooseModel = (id: string) => {
    if(!busy && !sending.current.has(selected ?? "new") && session?.status !== "running" && models.some(m => m.modelId === id && m.enabled)) {
      if(!selected && outbox.current.creating?.input.modelId !== id) {
        // Creating an empty topic sends no text and incurs no model charge. An
        // explicit new model choice may abandon an unconfirmed empty creation.
        outbox.current.creating = null;saveBrowserState(outboxKey,outbox.current);
      }
      choices.current[selected ?? "new"] = id; saveBrowserState(choicesKey,choices.current);setModelChoice(id);
    }
  };
  const saveScopes = async (value: typeof scopes) => {
    const e = epoch.current;
    try {const result = await api.setPreferences(book,value);if(e === epoch.current) {setScopes(result.scopes);setError("")};return true}
    catch(err) {if(e === epoch.current) setError(errorText(err));return false}
  };
  const cancel = () => {if(selected) void action(() => api.cancel(book,selected),acceptSnapshot)};
  const remove = () => {if(selected) void action(() => api.delete(book,selected),() => {
    delete outbox.current.pending[selected];delete choices.current[selected];saveBrowserState(outboxKey,outbox.current);saveBrowserState(choicesKey,choices.current);
    setSessions(old => old.filter(s => s.sessionId !== selected));select(null);
  })};
  const pendingDelivery = selected ? outbox.current.pending[selected] : undefined;
  const retryPending = () => {
    if(pendingDelivery && selected) {
      setDraft(pendingDelivery.input.text);
      const choice = pendingDelivery.input.modelId ?? modelChoice;
      choices.current[selected] = choice;saveBrowserState(choicesKey,choices.current);setModelChoice(choice);
    }
  };
  return {pendingDelivery,outgoing,models,modelChoice,chooseModel,modelAvailable,modelNotice,retryPending,scopes,saveScopes,sessions,model,selected,session,error,busy,tool,steps,draft,setDraft,select,reload,create,send,cancel,remove};
}
