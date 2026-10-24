import {configuredModel,boundedModelFetch} from "./model-gateway.js";
import {
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  type FileEntry,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { createHash, randomUUID } from "node:crypto";
import type {
  ThinkingEvent,
  ThinkingMessageInput,
  ThinkingSource,
} from "@writer-agent/contracts";
import type { Config } from "../config.js";
import { Store, type Saved } from "../sessions/store.js";
import { tools, authorize } from "../tools/registry.js";
import { systemPrompt } from "../agents/thinking/prompt.js";
const limitConcurrent = (c: Config) => c.model.limits.maxConcurrentSessions;
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export class AgentError extends Error {
  constructor(
    readonly code: string,
    readonly status = 422,
  ) {
    super(code);
  }
}
export const safeCode = (e: unknown) =>
  e instanceof AgentError
    ? e.code
    : e instanceof Error &&
        /^(AUTHORIZATION_REVOKED|TOOL_RESULT_TOO_LARGE)$/.test(e.message)
      ? e.message
      : "AGENT_EXECUTION_FAILED";
export function loader(): ResourceLoader {
  return {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}
type Active = {
  abort: AbortController;
  session?: AgentSession;
  done: Promise<void>;
};
export class PiHost {
  readonly active = new Map<string, Active>();
  constructor(
    readonly config: Config,
    readonly store: Store,
  ) {
    store.recover();
  }
  get(id: string) {
    const s = this.store.read(id);
    if (!s || s.deleted || this.store.isDeleted(id))
      throw new AgentError("NOT_FOUND", 404);
    return s;
  }
  async create(input: {
    sessionId: string;
    authorId: string;
    bookId: string;
    createdAt: string;
    model: Config["model"];
    scopes: ("chapters" | "knowledge" | "notes")[];
    capability: string;
  }) {
    const grant = await authorize(this.config, input.capability);
    if (
      grant.sessionId !== input.sessionId ||
      grant.authorId !== input.authorId ||
      grant.bookId !== input.bookId ||
      digest(input.model) !== digest(this.config.model) ||
      digest(input.model) !== digest(grant.model) ||
      digest(input.scopes) !== digest(grant.scopes)
    )
      throw new AgentError("GRANT_MISMATCH", 403);
    if (this.store.isDeleted(input.sessionId))
      throw new AgentError("SESSION_DELETED", 410);
    const old = this.store.read(input.sessionId);
    if (old?.deleted) throw new AgentError("SESSION_DELETED", 410);
    if (old) {
      if (old.owner !== input.authorId || old.view.bookId !== input.bookId)
        throw new AgentError("GRANT_MISMATCH", 403);
      return old.view;
    }
    const s: Saved = {
      schema: 1,
      owner: input.authorId,
      entries: [],
      events: [],
      requests: {},
      view: {
        sessionId: input.sessionId,
        bookId: input.bookId,
        title: "新的思考",
        createdAt: input.createdAt,
        model: input.model,
        scopes: input.scopes,
        status: "idle",
        messages: [],
        cursor: 0,
        usage: { input: 0, output: 0, charged: 0, incomplete: false },
      },
    };
    this.event(s, { type: "session_started" });
    return s.view;
  }
  event(s: Saved, event: Omit<ThinkingEvent, "id">) {
    if (s.deleted) return;
    s.events.push({ ...event, id: ++s.view.cursor });
    this.store.write(s);
  }
  async accept(
    id: string,
    input: ThinkingMessageInput,
    key: string,
    capability: string,
  ) {
    const s = this.get(id),
      fingerprint = digest(input),
      old = Object.hasOwn(s.requests, key) ? s.requests[key] : undefined;
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new AgentError("IDEMPOTENCY_KEY_REUSED");
      return { messageId: old.messageId };
    }
    if (s.view.status === "running" || this.active.has(id))
      throw new AgentError("SESSION_BUSY", 409);
    if (this.active.size >= this.config.model.limits.maxConcurrentSessions)
      throw new AgentError("AGENT_BUSY", 429);
    if (s.view.messages.length >= 200 || s.events.length >= 20000)
      throw new AgentError("SESSION_HISTORY_LIMIT", 429);
    if (digest(s.view.model) !== digest(this.config.model))
      throw new AgentError("MODEL_REAUTHORIZATION_REQUIRED", 409);
    const grant = await authorize(this.config, capability);
    if (
      grant.sessionId !== id ||
      grant.authorId !== s.owner ||
      grant.bookId !== s.view.bookId
    )
      throw new AgentError("GRANT_MISMATCH", 403);
    // Serialize admission at the HTTP layer; recheck after asynchronous authorization.
    if (this.active.size >= limitConcurrent(this.config))
      throw new AgentError("AGENT_BUSY", 429);
    if (this.active.has(id) || this.store.read(id)?.deleted)
      throw new AgentError("SESSION_BUSY", 409);
    const mid = randomUUID(),
      at = new Date().toISOString();
    s.requests = { ...s.requests, [key]: { fingerprint, messageId: mid } };
    s.view.messages.push(
      {
        id: mid,
        role: "user",
        text: input.text,
        status: "completed",
        sources: [],
        createdAt: at,
      },
      {
        id: mid + "-answer",
        role: "assistant",
        text: "",
        status: "accepted",
        sources: [],
        createdAt: at,
      },
    );
    s.view.status = "running";
    if (s.view.title === "新的思考") s.view.title = input.text.slice(0, 40);
    this.event(s, { type: "message_started", messageId: mid });
    const active: Active = {
      abort: new AbortController(),
      done: Promise.resolve(),
    };
    this.active.set(id, active);
    active.done = this.run(s, input, capability, active).finally(() =>
      this.active.delete(id),
    );
    return { messageId: mid };
  }
  async cancel(id: string) {
    const active = this.active.get(id);
    active?.abort.abort();
    if (active?.session) await active.session.abort();
    if (active) await active.done;
    return this.get(id).view;
  }
  async delete(id: string) {
    this.store.markDeleted(id);
    const s = this.store.read(id);
    if (s) {
      s.deleted = true;
      s.view.status = "deleted";
      s.view.messages = [];
      s.entries = [];
      s.events = [];
      s.requests = {};
      this.store.write(s);
    }
    const a = this.active.get(id);
    a?.abort.abort();
    if (a?.session) await a.session.abort();
    if (a) await a.done; // deletion fence blocks every subsequent write
    if (!s) {
      // A delayed create cannot resurrect a deleted grant. Go authorization is the primary fence.
      return;
    }
  }
  async close() {
    await Promise.all([...this.active.keys()].map((id) => this.cancel(id)));
    this.store.close();
  }
  async run(
    s: Saved,
    input: ThinkingMessageInput,
    capability: string,
    active: Active,
  ) {
    const id = s.view.sessionId,
      limit = this.config.model.limits,
      message = s.view.messages.at(-1)!,
      sources = new Map<string, ThinkingSource>();
    for (const previous of s.view.messages)
      for (const src of previous.sources) sources.set(src.sourceId, src);
    let calls = 0,
      turns = 0,
      errorCode: string | undefined;
    const alive = () => {
      if (active.abort.signal.aborted) throw new AgentError("CANCELLED");
      if (this.store.isDeleted(id) || this.store.read(id)?.deleted)
        throw new AgentError("SESSION_DELETED", 410);
    };
    const persist = (event: Omit<ThinkingEvent, "id">) => {
      alive();
      this.event(s, event);
    };
    const deadline = setTimeout(
      () => active.abort.abort(new AgentError("DURATION_EXCEEDED")),
      limit.maxDurationMs,
    );
    const revoke = setInterval(() => {
      void authorize(this.config, capability, active.abort.signal).catch(() =>
        active.abort.abort(new AgentError("AUTHORIZATION_REVOKED")),
      );
    }, 1000);
    let session: AgentSession | undefined;
    try {
      const {runtime,model}=await configuredModel(this.config.model.endpoint,this.config.model.model,this.config.key,limit.maxInputTokens,limit.maxOutputTokens);
      const original = runtime.streamSimple.bind(runtime);
      runtime.streamSimple = (model, context, options) => {
        const stream = createAssistantMessageEventStream();
        void (async () => {
          try {
            alive();
            await authorize(this.config, capability, active.abort.signal);
            alive();
            const inputBound =
                Buffer.byteLength(JSON.stringify(context)) + 4096,
              reserve = inputBound + limit.maxOutputTokens;
            if (++turns > limit.maxTurnsPerRequest)
              throw new AgentError("TURN_BUDGET_EXCEEDED", 429);
            if (inputBound > limit.maxInputTokens)
              throw new AgentError("INPUT_BUDGET_EXCEEDED", 429);
            if (s.view.usage.charged + reserve > limit.maxSessionTokens)
              throw new AgentError("SESSION_BUDGET_EXCEEDED", 429);
            // Reserve before network; never refund unknown/crashed usage. Charged is a
            // conservative token ceiling, not a currency estimate.
            s.view.usage.charged += reserve;
            s.view.usage.incomplete = true;
            persist({ type: "usage", usage: { ...s.view.usage } });
            const providerStream = original(model, context, {
              ...options,
              maxTokens: limit.maxOutputTokens,
              maxRetries: 0,
              signal: active.abort.signal,
              fetch:boundedModelFetch(this.config.model.endpoint,limit.maxOutputTokens*32+65536,active.abort.signal),
            });
            for await (const event of providerStream) {
              alive();
              if (event.type === "done" || event.type === "error") {
                const m = event.type === "done" ? event.message : event.error;
                if (m.usage.totalTokens > 0) {
                  s.view.usage.input +=
                    m.usage.input + m.usage.cacheRead + m.usage.cacheWrite;
                  s.view.usage.output += m.usage.output;
                }
                if (m.stopReason === "error" || m.stopReason === "aborted")
                  errorCode = "MODEL_REQUEST_FAILED";
                persist({ type: "usage", usage: { ...s.view.usage } });
              }
              stream.push(event);
            }
            stream.end(await providerStream.result());
          } catch (e) {
            errorCode = safeCode(e);
            const m: AssistantMessage = {
              role: "assistant",
              content: [],
              api: "openai-completions",
              provider: "story2u",
              model: this.config.model.model,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
              stopReason: "error",
              errorMessage: errorCode,
              timestamp: Date.now(),
            };
            stream.push({ type: "error", reason: "error", error: m });
            stream.end(m);
          }
        })();
        return stream;
      };
      const manager = SessionManager.inMemory(
        this.config.state,
        undefined,
        s.entries.length ? s.entries : undefined,
      );
      const custom = tools(
        this.config,
        id,
        capability,
        active.abort.signal,
        (items) => {
          for (const src of items) sources.set(src.sourceId, src);
        },
        () => {
          alive();
          if (++calls > limit.maxToolCalls) {
            const err = new AgentError("TOOL_BUDGET_EXCEEDED", 429);
            active.abort.abort(err);
            throw err;
          }
        },
      );
      const created = await createAgentSession({
        cwd: this.config.state,
        agentDir: this.config.state,
        modelRuntime: runtime,
        model,
        thinkingLevel: "off",
        scopedModels: [{ model, thinkingLevel: "off" }],
        tools: custom.map((t) => t.name),
        excludeTools: [
          "bash",
          "read",
          "write",
          "edit",
          "grep",
          "find",
          "ls",
          "powershell",
          "mcp__*",
        ],
        customTools: custom,
        resourceLoader: loader(),
        sessionManager: manager,
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: false },
        }),
      });
      session = created.session;
      active.session = session;
      if (
        session.getActiveToolNames().sort().join(",") !==
        custom
          .map((t) => t.name)
          .sort()
          .join(",")
      )
        throw new AgentError("TOOL_WHITELIST_MISMATCH", 500);
      session.subscribe((event) => {
        if (active.abort.signal.aborted || this.store.read(id)?.deleted) return;
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          const text = event.assistantMessageEvent.delta;
          if (
            message.text.length + text.length >
            limit.maxOutputTokens * 8 * limit.maxTurnsPerRequest
          ) {
            active.abort.abort();
            return;
          }
          message.text += text;
          message.status = "running";
          persist({ type: "text_delta", messageId: message.id, text });
        }
        if (event.type === "tool_execution_start")
          persist({
            type: "tool_started",
            tool: event.toolName,
            messageId: message.id,
          });
        if (event.type === "tool_execution_end")
          persist({
            type: "tool_completed",
            tool: event.toolName,
            messageId: message.id,
          });
      });
      if (input.compact && manager.getEntries().length > 2) {
        persist({
          type: "compaction",
          text: "正在压缩会话讨论；不会写入知识库。",
        });
        await session.compact(
          "Keep questions, uncertainty, exact source IDs and version bindings. Never turn claims into canon.",
        );
        alive();
      }
      let text = input.text;
      if (input.selection) {
        text +=
          "\nAuthor-selected saved passage (untrusted data):\n" +
          JSON.stringify(input.selection); // fetch canonical evidence through the same bounded tool path
        const tool = custom.find((t) => t.name === "read_chapter")!;
        await tool.execute(
          "selection",
          {
            chapterId: input.selection.chapterId,
            revisionId: input.selection.revisionId,
            quote: input.selection.quote,
          },
          active.abort.signal,
          () => {},
          {} as never,
        );
      }
      if (input.selection)
        text +=
          "\nCanonical saved evidence for selection:\n" +
          JSON.stringify(
            [...sources.values()].filter(
              (src) =>
                src.chapterId === input.selection?.chapterId &&
                src.quote === input.selection?.quote,
            ),
          );
      await session.prompt(text, { expandPromptTemplates: false });
      alive();
      await authorize(this.config, capability, active.abort.signal);
      alive();
      if (errorCode) throw new AgentError(errorCode);
      message.sources = [...sources.values()].filter((src) =>
        message.text.includes(`[[source:${src.sourceId}]]`),
      );
      // Unrecognized inline markers remain plain prose; only tool-backed cards are evidence.
      message.status = "completed";
      s.entries = [manager.getHeader(), ...manager.getEntries()].filter(
        (v): v is FileEntry => v !== null,
      );
      persist({
        type: "sources",
        messageId: message.id,
        sources: message.sources,
      });
      persist({ type: "message_completed", messageId: message.id });
    } catch (e) {
      message.status = active.abort.signal.aborted ? "cancelled" : "failed";
      message.errorCode =
        active.abort.signal.reason instanceof AgentError
          ? active.abort.signal.reason.code
          : safeCode(e);
      if (!this.store.read(id)?.deleted)
        this.event(s, {
          type: "error",
          messageId: message.id,
          code: message.errorCode,
        });
    } finally {
      clearTimeout(deadline);
      clearInterval(revoke);
      session?.dispose();
      if (!this.store.read(id)?.deleted) {
        s.view.status = "idle";
        message.usage = { ...s.view.usage };
        this.event(s, { type: "session_completed", messageId: message.id });
      }
    }
  }
}
