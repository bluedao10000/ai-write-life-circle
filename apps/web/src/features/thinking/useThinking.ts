import { useCallback, useEffect, useRef, useState } from "react";
import { thinkingCreateSchema, thinkingMessageInputSchema } from "@writer-agent/contracts";
import type {
  ThinkingCreate,
  ThinkingMessageInput,
  ThinkingModel,
  ThinkingModelOption,
  ThinkingSession,
} from "@writer-agent/contracts";
import { thinkingApi as api } from "../../services/api/thinkingApi";
import { thinkingError } from "./errors";
import { scopedKey } from "../../services/storageScope";
import { applyToolEvents, type ToolStep } from "./toolActivity";
type Summary = Pick<
  ThinkingSession,
  "sessionId" | "bookId" | "title" | "createdAt" | "model" | "scopes" | "status"
>;
const errorText = (e: unknown) =>
  e instanceof Error ? ((e as Error & {code?: string}).code ? thinkingError((e as Error & {code?: string}).code) : e.message) : "思考服务暂不可用，请保留输入后重试。";
export function useThinking(book: string, enabled: boolean) {
  const storagePartition = scopedKey(book);
  const readChoice = useCallback(() => {try {return sessionStorage.getItem("thinking-model:" + storagePartition) ?? ""} catch {return ""}}, [storagePartition]);
  const [outgoing, setOutgoing] = useState("");
  const [models, setModels] = useState<ThinkingModelOption[]>([]);
  const [modelChoice, setModelChoice] = useState<string>(readChoice);
  const [scopes, setScopes] = useState<("chapters" | "knowledge" | "creative" | "notes")[]>([]);
  const sending = useRef(false);
  const priorModelChoice = useRef("");
  const readDraft = useCallback(() => { try {return sessionStorage.getItem("thinking-draft:" + storagePartition) ?? ""} catch {return ""} }, [storagePartition]);
  const [sessions, setSessions] = useState<Summary[]>([]),
    [model, setModel] = useState<ThinkingModel | null>(null),
    [selected, setSelected] = useState<string | null>(() => {
      try {
        return sessionStorage.getItem(scopedKey("thinking-v1:" + book));
      } catch {
        return null;
      }
    }),
    [session, setSession] = useState<ThinkingSession | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [tool, setTool] = useState(""),
    [steps, setSteps] = useState<ToolStep[]>([]),
    [draft, setDraftRaw] = useState(readDraft);
  const setDraft = (value: string) => {
    setDraftRaw(value);
    try {sessionStorage.setItem(scopedKey("thinking-draft:" + book), value)} catch { /* optional */ }
  };
  const stepId = useRef(0),
    epoch = useRef(0),
    request = useRef(0),
    operation = useRef(0),
    pending = useRef<{
      key: string;
      id: string;
      input: ThinkingMessageInput;
    } | null>(null),
    creating = useRef<{ key: string; input: ThinkingCreate } | null>(null);
  const persistOutbox = () => {
    try {sessionStorage.setItem(scopedKey("thinking-outbox:" + book), JSON.stringify({pending: pending.current, creating: creating.current}))} catch { /* optional */ }
  };
  useEffect(() => {
    const generation = ++epoch.current;
    setSession(null); setSessions([]); setModels([]); setModelChoice(readChoice()); setScopes([]); setOutgoing("");
    setDraftRaw(readDraft());
    try {setSelected(sessionStorage.getItem(scopedKey("thinking-v1:" + book)))} catch {setSelected(null)}
    pending.current = null; creating.current = null; sending.current = false; priorModelChoice.current = "";
    try {
      const raw = JSON.parse(sessionStorage.getItem(scopedKey("thinking-outbox:" + book)) ?? "null");
      if (raw?.pending && typeof raw.pending.key === "string" && typeof raw.pending.id === "string") pending.current = {...raw.pending, input: thinkingMessageInputSchema.parse(raw.pending.input)};
      if (raw?.creating && typeof raw.creating.key === "string") creating.current = {...raw.creating, input: thinkingCreateSchema.parse(raw.creating.input)};
    } catch { /* malformed optional browser state must not block the author */ }
    // Storage is partitioned by the authenticated account and book.
    return () => {
      epoch.current = generation + 1;
    };
  }, [book, storagePartition, readDraft, readChoice]);
  const select = useCallback(
    (id: string | null) => {
      request.current++;
      operation.current++;
      setBusy(false);
      setSelected(id);
      setSession(null);
      setTool("");
      setSteps([]);
      setError("");
      try {
        if (id) sessionStorage.setItem(scopedKey("thinking-v1:" + book), id);
        else sessionStorage.removeItem(scopedKey("thinking-v1:" + book));
      } catch {
        /* selection persistence is optional */
      }
    },
    [book],
  );
  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const e = epoch.current;
      const current = () => e === epoch.current && !signal?.aborted;
      const results = await Promise.allSettled([
        api.models(book, signal).then(items => {if(current()) {setModels(items);setModelChoice(old => old || items.find(m => m.enabled)?.modelId || "")}}),
        api.preferences(book, signal).then(value => {if(current()) setScopes(value.scopes)}),
        api.list(book, signal).then((items) => {
          if (current()) setSessions(items);
        }),
        api
          .capabilities(book, signal)
          .then((cap) => {
            if (current()) setModel(cap);
          })
          .catch((err) => {
            if (current()) setModel(null);
            throw err;
          }),
      ]);
      if (current()) {
        const failure = results.find((result) => result.status === "rejected");
        setError(
          failure?.status === "rejected" ? errorText(failure.reason) : "",
        );
      }
    },
    [book],
  );
  useEffect(() => {
    if (!enabled) return;
    const c = new AbortController();
    void reload(c.signal);
    return () => c.abort();
  }, [enabled, reload]);
  useEffect(() => {
    if (!enabled || !selected || busy) return;
    const c = new AbortController(),
      e = epoch.current,
      r = request.current;
    let timer: ReturnType<typeof setTimeout> | undefined,
      cursor = 0;
    const current = () =>
      !c.signal.aborted && e === epoch.current && r === request.current;
    const poll = async () => {
      try {
        const events = await api.events(book, selected, cursor, c.signal);
        if (!current()) return;
        cursor = events.cursor;
        for (const event of events.items) {
          if (event.type === "tool_started") setTool(event.tool ?? "");
          if (event.type === "tool_completed") setTool("");
        }
        if (events.items.some((e) => e.type === "tool_started" || e.type === "tool_completed"))
          setSteps((prev) => applyToolEvents(prev, events.items, () => ++stepId.current));
        // Reload authoritative messages, including partial text. Cursor events remain
        // the ordered progress channel and never append duplicate accepted messages.
        const value = await api.get(book, selected, c.signal);
        if (!current()) return;
        setSession(value);
        setError("");
        if (value.status === "running" || events.cursor < value.cursor)
          timer = setTimeout(() => void poll(), 500);
      } catch (err) {
        if (current()) {
          setError(errorText(err));
          timer = setTimeout(() => void poll(), 3000);
        }
      }
    };
    void (async () => {
      try {
        const value = await api.get(book, selected, c.signal);
        if (!current()) return;
        setSession(value);
        cursor = value.cursor;
        if (value.status === "running") void poll();
      } catch (err) {
        if (current()) setError(errorText(err));
      }
    })();
    return () => {
      c.abort();
      clearTimeout(timer);
    };
  }, [book, selected, enabled, busy]);
  const action = async <T>(fn: () => Promise<T>, apply: (v: T) => void) => {
    const e = epoch.current,
      r = request.current,
      op = ++operation.current;
    setBusy(true);
    setError("");
    try {
      const v = await fn();
      if (e === epoch.current && r === request.current) apply(v);
    } catch (err) {
      if (e === epoch.current && r === request.current)
        setError(errorText(err));
    } finally {
      if (e === epoch.current && op === operation.current) setBusy(false);
    }
  };
  const create = (scopes: ThinkingCreate["scopes"]) => {
    if (!model) return;
    const input: ThinkingCreate = { consent: true, model, scopes };
    if (
      !creating.current ||
      JSON.stringify(creating.current.input) !== JSON.stringify(input)
    )
      creating.current = { key: crypto.randomUUID(), input };
    const p = creating.current;
    void action(
      () => api.create(book, p.input, p.key),
      (value) => {
        creating.current = null;
        setSessions((old) => [
          value,
          ...old.filter((s) => s.sessionId !== value.sessionId),
        ]);
        select(value.sessionId);
        setSession(value);
      },
    );
  };
  const send = (input: ThinkingMessageInput) => {
    if (sending.current || session?.status === "running") return;
    sending.current = true;
    setOutgoing(input.text);
    const e = epoch.current, r = request.current;
    const value = {...input, ...(modelChoice ? {modelId: modelChoice} : {})};
    void action(async () => {
      let id = selected;
      if (!id) {
        if (!creating.current) creating.current = {key: crypto.randomUUID(), input: {modelId: modelChoice || undefined}};
        persistOutbox();
        const created = await api.create(book, creating.current.input, creating.current.key);
        if (e !== epoch.current || r !== request.current) return null;
        id = created.sessionId;
        setSelected(id); setSession(created);
        setSessions(old => [created, ...old.filter(s => s.sessionId !== id)]);
        try {sessionStorage.setItem(scopedKey("thinking-v1:" + book), id)} catch { /* optional */ }
        creating.current = null;
      }
      if (!pending.current || pending.current.id !== id || JSON.stringify(pending.current.input) !== JSON.stringify(value))
        pending.current = {key: crypto.randomUUID(), id, input: value};
      const p = pending.current;
      persistOutbox();
      try {await api.send(book, id, p.input, p.key)} catch (err) {
        if ((err as {code?: string})?.code === "MODEL_UNAVAILABLE" && session && e === epoch.current) {
          const previous = priorModelChoice.current || session.model.modelId || "default";
          setModelChoice(previous);
          try {sessionStorage.setItem(scopedKey("thinking-model:" + book),previous)} catch { /* optional */ }
        }
        throw err;
      }
      return api.get(book, id);
    }, result => {
      if (!result) return;
      pending.current = null;
      persistOutbox();
      setSession(result);
      // Do not erase text the author typed while the request was in flight.
      setDraftRaw(old => {if(old.trim() !== input.text.trim()) return old; try {sessionStorage.removeItem(scopedKey("thinking-draft:" + book))} catch { /* optional */ } return ""});
      setSteps([]);
    }).finally(() => {if (e === epoch.current) {sending.current = false;setOutgoing("")}});
  };
  const chooseModel = (id: string) => {
    if (!busy && !sending.current && session?.status !== "running" && models.some(m => m.modelId === id && m.enabled)) {
      priorModelChoice.current = modelChoice;
      setModelChoice(id);
      try {sessionStorage.setItem(scopedKey("thinking-model:" + book),id)} catch { /* optional */ }
    }
  };
  const saveScopes = async (value: typeof scopes) => {
    const e = epoch.current;
    try {const result = await api.setPreferences(book, value);if(e === epoch.current) {setScopes(result.scopes);setError("")};return true}
    catch(err) {if(e === epoch.current) setError(errorText(err));return false}
  };
  const cancel = () => {
    if (selected) void action(() => api.cancel(book, selected), setSession);
  };
  const remove = () => {
    if (selected)
      void action(
        () => api.delete(book, selected),
        () => {
          setSessions((old) => old.filter((s) => s.sessionId !== selected));
          select(null);
        },
      );
  };
  return {
    outgoing, models, modelChoice, chooseModel, scopes, saveScopes,
    sessions,
    model,
    selected,
    session,
    error,
    busy,
    tool,
    steps,
    draft,
    setDraft,
    select,
    reload,
    create,
    send,
    cancel,
    remove,
  };
}
