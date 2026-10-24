import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ThinkingCreate,
  ThinkingMessageInput,
  ThinkingModel,
  ThinkingSession,
} from "@writer-agent/contracts";
import { thinkingApi as api } from "../../services/api/thinkingApi";
import { applyToolEvents, type ToolStep } from "./toolActivity";
type Summary = Pick<
  ThinkingSession,
  "sessionId" | "bookId" | "title" | "createdAt" | "model" | "scopes" | "status"
>;
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "思考服务暂不可用，请保留输入后重试。";
export function useThinking(book: string, enabled: boolean) {
  const [sessions, setSessions] = useState<Summary[]>([]),
    [model, setModel] = useState<ThinkingModel | null>(null),
    [selected, setSelected] = useState<string | null>(() => {
      try {
        return sessionStorage.getItem("thinking-v1:" + book);
      } catch {
        return null;
      }
    }),
    [session, setSession] = useState<ThinkingSession | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [tool, setTool] = useState(""),
    [steps, setSteps] = useState<ToolStep[]>([]),
    [draft, setDraft] = useState("");
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
  useEffect(() => {
    const generation = ++epoch.current;
    return () => {
      epoch.current = generation + 1;
    };
  }, [book]);
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
        if (id) sessionStorage.setItem("thinking-v1:" + book, id);
        else sessionStorage.removeItem("thinking-v1:" + book);
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
    if (!enabled || !selected) return;
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
    if (!selected) return;
    const id = selected;
    if (
      !pending.current ||
      pending.current.id !== id ||
      JSON.stringify(pending.current.input) !== JSON.stringify(input)
    )
      pending.current = { key: crypto.randomUUID(), id, input };
    const p = pending.current;
    void action(
      () => api.send(book, id, p.input, p.key),
      () => {
        pending.current = null;
        setDraft("");
        // A new turn starts from an empty timeline; steps from the last turn are history.
        setSteps([]);
      },
    );
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
