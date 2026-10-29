import { failureFor, traceRun } from "./reliability.js";
import { canonicalJSON } from "./fingerprint.js";
import {configuredModel,boundedModelFetch,completionUsage} from "./model-gateway.js";
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
  ThinkingExecutionInput,
  ThinkingSource,
} from "@writer-agent/contracts";
import { modelEntries, modelId, type Config } from "../config.js";
import { Store, type Saved } from "../sessions/store.js";
import { tools, authorize } from "../tools/registry.js";
import { systemPrompt } from "../agents/thinking/prompt.js";
const limitConcurrent = (c: Config) => c.maxConcurrentSessions ?? Math.min(8, modelEntries(c).filter(v => v.enabled).reduce((n,v) => n + v.model.limits.maxConcurrentSessions, 0));
const digest = (v: unknown) => createHash("sha256").update(canonicalJSON(v)).digest("hex");
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
        /^(AUTHORIZATION_REVOKED|SESSION_INTERRUPTED|TOOL_RESULT_TOO_LARGE|TOOL_TIMEOUT|TOOL_EXECUTION_FAILED|PROVIDER_UNAVAILABLE)$/.test(e.message)
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
  readonly instance = randomUUID();
  readonly active = new Map<string, Active>();
  constructor(
    readonly config: Config,
    readonly store: Store,
  ) {
    store.recover();
  }
  get(id: string) {
    return this.view(id,true);
  }
  getRecent(id:string) {
    return this.view(id,false);
  }
  private view(id:string,withEvents:boolean) {
    const s = this.store.read(id,withEvents);
    if (!s || s.deleted || this.store.isDeleted(id))
      throw new AgentError("NOT_FOUND", 404);
    // Older accepted messages predate the public correlation field. The durable
    // request receipt proves their identity without comparing or resending prose.
    const keys = new Map(Object.entries(s.requests).map(([key, value]) => [value.messageId,key]));
    for (const message of s.view.messages) if (message.role === "user" && !message.requestKey) message.requestKey = keys.get(message.id);
    return s;
  }
  async create(input: {
    sessionId: string;
    authorId: string;
    bookId: string;
    createdAt: string;
    model: Config["model"];
    scopes: ("chapters" | "knowledge" | "notes" | "creative")[];
    capability: string;
  }) {
    const grant = await authorize(this.config, input.capability);
    if (
      grant.sessionId !== input.sessionId ||
      grant.authorId !== input.authorId ||
      grant.bookId !== input.bookId ||
      !modelEntries(this.config).some(v => v.enabled && digest(input.model) === digest(v.model)) ||
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
      accountingVersion:2,
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
  event(s: Saved, event: Omit<ThinkingEvent, "id">, commit = true) {
    if (s.deleted) return;
    s.events.push({ ...event, id: ++s.view.cursor });
    if (commit) this.store.write(s);
  }
  async accept(
    id: string,
    input: ThinkingExecutionInput,
    key: string,
    capability: string,
  ) {
    let s = this.get(id);
    const admittedEpoch = s.epoch ?? 0;
    const fingerprint = digest(input),
      old = Object.hasOwn(s.requests, key) ? s.requests[key] : undefined;
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new AgentError("IDEMPOTENCY_KEY_REUSED");
      return { messageId: old.messageId };
    }
    if (s.view.status === "running" || this.active.has(id))
      throw new AgentError("SESSION_BUSY", 409);
    if (this.active.size >= limitConcurrent(this.config))
      throw new AgentError("AGENT_BUSY", 429);
    if (s.view.messages.length >= 200 || s.events.length >= 20000)
      throw new AgentError("SESSION_HISTORY_LIMIT", 429);
    const grant = await authorize(this.config, capability);
    if (
      grant.sessionId !== id ||
      grant.authorId !== s.owner ||
      grant.bookId !== s.view.bookId
    )
      throw new AgentError("GRANT_MISMATCH", 403);
    const selected = modelEntries(this.config).find(v => v.enabled && modelId(v.model) === (input.modelId ?? modelId(grant.model)) && digest(v.model) === digest(grant.model));
    if (!selected) throw new AgentError("MODEL_UNAVAILABLE", 409);
    // Authorization awaits network. Cancel/delete/another admission must fence this snapshot.
    const latest = this.get(id);
    const replay = Object.hasOwn(latest.requests, key) ? latest.requests[key] : undefined;
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw new AgentError("IDEMPOTENCY_KEY_REUSED");
      return {messageId: replay.messageId};
    }
    if ((latest.epoch ?? 0) !== admittedEpoch) throw new AgentError("SESSION_INTERRUPTED",409);
    s = latest;
    const sameModelActive = [...this.active.keys()].filter(sessionID => {
      const current = this.store.read(sessionID);
      return current && modelId(current.view.model) === modelId(selected.model);
    }).length;
    if (sameModelActive >= selected.model.limits.maxConcurrentSessions) throw new AgentError("AGENT_BUSY",429);
    // Serialize admission at the HTTP layer; recheck after asynchronous authorization.
    if (this.active.size >= limitConcurrent(this.config))
      throw new AgentError("AGENT_BUSY", 429);
    if (this.active.has(id) || this.store.read(id)?.deleted)
      throw new AgentError("SESSION_BUSY", 409);
    let previousAttempt = 0;
    if (input.recovery) {
      if (input.recovery.confirmAdditionalCost !== true) throw new AgentError("COST_CONFIRMATION_REQUIRED",422);
      const run = s.view.run;
      if (!run || run.runId !== input.recovery.runId || !s.checkpoint ||
          !["failed","interrupted"].includes(run.status) || !run.resumable ||
          !run.failure?.retryable) throw new AgentError("RESUME_NOT_SAFE",409);
      if (digest(s.view.model) !== digest(selected.model) || digest(s.view.scopes) !== digest(grant.scopes) || (run.authorizationVersion ?? 0) !== (grant.authorizationVersion ?? 0))
        throw new AgentError("AUTHORIZATION_REQUIRED",403);
      if (run.failure.code === "CONTEXT_OVERFLOW" && !input.recovery.continuationContext)
        throw new AgentError("CONTINUATION_CONTEXT_REQUIRED",422);
      previousAttempt = run.attempt;
      s.entries = input.recovery.continuationContext ? [] : structuredClone(s.checkpoint.entries);
      const recovery = {...s.checkpoint.input.recovery,...input.recovery};
      input = {...s.checkpoint.input, recovery};
    }
    if (input.compact) throw new AgentError("CONTINUATION_CONTEXT_REQUIRED",422);
    if (input.recovery?.continuationContext && s.checkpoint) s.checkpoint.input = {...s.checkpoint.input, recovery:input.recovery};
    // Tool results were authorized for the old scope/model. Keep visible discussion,
    // but never replay raw private retrieval into a reduced scope or a new host.
    if (digest(s.view.model) !== digest(selected.model) || s.view.scopes.some(scope => !grant.scopes.includes(scope))) s.entries = [];
    s.view.model = selected.model;
    s.view.scopes = grant.scopes;
    const mid = input.recovery ? s.checkpoint!.messageId : randomUUID(),
      at = new Date().toISOString();
    s.requests = { ...s.requests, [key]: { fingerprint, messageId: mid } };
    if (!input.recovery) s.view.messages.push(
      {
        id: mid,
        role: "user",
        requestKey: key,
        modelId: modelId(selected.model),
        modelLabel: selected.model.displayName ?? selected.model.model,
        text: input.text,
        status: "completed",
        sources: [],
        createdAt: at,
      },
    );
    s.view.messages.push(
      {
        id: mid + "-answer" + (previousAttempt ? "-" + (previousAttempt + 1) : ""),
        role: "assistant",
        modelId: modelId(selected.model),
        modelLabel: selected.model.displayName ?? selected.model.model,
        text: "",
        status: "accepted",
        sources: [],
        createdAt: at,
      },
    );
    if (s.view.run) {s.runs ??= [];s.runs.push(s.view.run)}
    s.epoch = (s.epoch ?? 0) + 1;
    s.view.run = {authorizationVersion:grant.authorizationVersion ?? 0,runId:randomUUID(),traceId:randomUUID(),messageId:mid,status:"accepted",stepType:"accepted",checkpointId:randomUUID(),epoch:s.epoch,attempt:previousAttempt+1,retryCount:previousAttempt,modelCalls:0,resumable:true,provider:selected.model.provider,model:selected.model.model,startedAt:at,updatedAt:at,durationMs:0};
    if (!input.recovery) s.checkpoint = {input,entries:structuredClone(s.entries),messageId:mid};
    s.executionLease = {owner:this.instance,epoch:s.epoch,expiresAt:Date.now()+selected.model.limits.maxDurationMs};
    s.view.status = "running";
    if (s.view.title === "新的思考") s.view.title = input.text.slice(0, 40);
    this.event(s, { type: "message_started", messageId: mid });
    traceRun(id,s.view.run,{input:0,output:0,charged:0,incomplete:false});
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
  async cancel(id: string, capability?: string) {
    if (capability) {
      const before=this.get(id),epoch=before.epoch??0;
      const grant=await authorize(this.config,capability);
      if(grant.sessionId!==id || grant.authorId!==before.owner || grant.bookId!==before.view.bookId) throw new AgentError("GRANT_MISMATCH",403);
      if((this.get(id).epoch??0)!==epoch) throw new AgentError("SESSION_INTERRUPTED",409);
    }
    const active = this.active.get(id);
    const s = this.get(id);
    s.epoch = (s.epoch ?? 0) + 1;
    if (!active && s.view.run && ["failed","interrupted"].includes(s.view.run.status)) {
      s.view.run.status = "cancelled"; s.view.run.resumable = false;
      const last = s.view.messages.at(-1);
      if (last?.role === "assistant") { last.status = "cancelled"; last.errorCode = "CANCELLED"; }
    }
    delete s.executionLease;
    this.store.write(s);
    active?.abort.abort(new AgentError("CANCELLED"));
    if (active?.session) await active.session.abort();
    if (active) await active.done;
    return this.get(id).view;
  }
  async delete(id: string) {
    this.store.markDeleted(id);
    const s = this.store.read(id,false);
    if (s) {
      s.deleted = true;
      s.view.status = "deleted";
      s.view.messages = [];
      s.entries = [];
      s.events = [];
      s.requests = {};
      delete s.archive;
      delete s.executionLease;
      delete s.runs;
      delete s.checkpoint;
      delete s.view.run;
      this.store.write(s);
    }
    const a = this.active.get(id);
    a?.abort.abort();
    if (a?.session) await a.session.abort();
    if (a) await a.done; // deletion fence blocks every subsequent write
    this.store.clearArchive(id);
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
    input: ThinkingExecutionInput,
    capability: string,
    active: Active,
  ) {
    const id = s.view.sessionId,
      limit = {...s.view.model.limits},
      message = s.view.messages.at(-1)!,
      sources = new Map<string, ThinkingSource>(),
      run = s.view.run!,
      usageBefore = {...s.view.usage};
    const started = performance.now();
    const runUsage = () => ({input:s.view.usage.input-usageBefore.input,output:s.view.usage.output-usageBefore.output,charged:s.view.usage.charged-usageBefore.charged,incomplete:s.view.usage.incomplete});
    // A chat with no allowed tools is a single completion, not a six-turn agent reservation.
    if ((!s.view.scopes.length || s.view.model.toolCalling === false) && !input.compact) limit.maxTurnsPerRequest = 1;
    // Historical cards remain on their original messages. A new answer can only
    // attach sources fetched through this turn's currently authorized Story Tools.
    let calls = 0,
      turns = 0,
      errorCode: string | undefined;
    const alive = () => {
      if (active.abort.signal.aborted) throw active.abort.signal.reason instanceof AgentError ? active.abort.signal.reason : new AgentError("CANCELLED");
      const status=this.store.executionStatus(id,{runId:run.runId,owner:this.instance,epoch:run.epoch});
      if(status === "deleted")throw new AgentError("SESSION_DELETED",410);
      if(status === "stale")throw new AgentError("SESSION_INTERRUPTED",409);
      if(status === "expired")throw new AgentError(run.stepType === "tool" ? "TOOL_TIMEOUT" : "DURATION_EXCEEDED");
    };
    const persist = (event: Omit<ThinkingEvent, "id">) => {
      alive();
      this.event(s, event);
    };
    const checkpoint = (step: typeof run.stepType) => {
      run.status = "checkpointed"; run.stepType = step;
      run.checkpointId = randomUUID(); run.updatedAt = new Date().toISOString();
      if (session) s.entries = [session.sessionManager.getHeader(), ...session.sessionManager.getEntries()].filter((v): v is FileEntry => v !== null);
      run.durationMs = Math.max(0,performance.now()-started);
      persist({type:"usage",usage:{...s.view.usage}});
      traceRun(id,run,runUsage());
    };
    const deadline = setTimeout(
      () => active.abort.abort(new AgentError(run.stepType === "tool" ? "TOOL_TIMEOUT" : "DURATION_EXCEEDED")),
      limit.maxDurationMs,
    );
    const revoke = setInterval(() => {
      void authorize(this.config, capability, active.abort.signal).catch((e) =>
        active.abort.abort(new AgentError(safeCode(e))),
      );
    }, 1000);
    let session: AgentSession | undefined;
    try {
      const configured = modelEntries(this.config).find(v => v.enabled && digest(v.model) === digest(s.view.model));
      if (!configured) throw new AgentError("MODEL_UNAVAILABLE");
      const cfg = {...this.config, model: configured.model, key: configured.key};
      const {runtime,model}=await configuredModel(cfg.model.endpoint,cfg.model.model,cfg.key,cfg.model.contextWindow ?? limit.maxInputTokens + limit.maxOutputTokens,limit.maxOutputTokens);
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
            const hadIncomplete = s.view.usage.incomplete;
            s.view.usage.incomplete = true;
            persist({ type: "usage", usage: { ...s.view.usage } });
            const providerUsage: {reported:ReturnType<typeof completionUsage>;seen:boolean} = {reported:null,seen:false};
            run.status = "running"; run.stepType = "provider"; run.modelCalls++;
            run.updatedAt = new Date().toISOString();run.durationMs=Math.max(0,performance.now()-started);
            persist({type:"usage",usage:{...s.view.usage}});
            traceRun(id,run,runUsage());
            let transportCode = "";
            const providerStream = original(model, context, {
              ...options,
              headers:{...options?.headers,"X-Client-Request-Id":run.runId+":"+turns},
              maxTokens: limit.maxOutputTokens,
              maxRetries: 0,
              signal: active.abort.signal,
              fetch:boundedModelFetch(cfg.model.endpoint,limit.maxOutputTokens*32+65536,active.abort.signal,(code,status) => {
                transportCode = code === "LLM_CONTEXT_OVERFLOW" ? "CONTEXT_OVERFLOW" : status === 429 ? "RATE_LIMITED" : status === 401 || status === 403 || status === 404 ? "MODEL_CONFIGURATION_ERROR" : code === "LLM_RESPONSE_TOO_LARGE" ? "MODEL_OUTPUT_INCOMPLETE" : "PROVIDER_UNAVAILABLE";
              }),
              onPayload(value) {
                const payload = value as Record<string, unknown>;
                delete payload.max_tokens; delete payload.max_completion_tokens;
                payload[cfg.model.tokenParameter ?? "max_tokens"] = limit.maxOutputTokens;
                if (cfg.model.providerOptions === "deepseek") payload.thinking = {type: "disabled"};
                const finish = s.view.scopes.length > 0 && (turns >= limit.maxTurnsPerRequest || calls >= limit.maxToolCalls);
                if (finish) {
                  delete payload.tools;
                  payload.tool_choice = "none";
                  if (Array.isArray(payload.messages)) payload.messages.push({role: "system", content: "Stop retrieving. Answer the author's question now from available information, clearly state gaps, and offer a concise useful conclusion. Do not call tools."});
                }
                return payload;
              },
              onProviderStreamEvent(value, eventModel) {
                const raw=(value as {usage?:Record<string,unknown>})?.usage;
                if(raw && 'prompt_tokens' in raw) {
                  providerUsage.seen=true;
                  providerUsage.reported=completionUsage(value,limit.maxOutputTokens);
                }
                return options?.onProviderStreamEvent?.(value, eventModel);
              },
            });
            for await (const event of providerStream) {
              alive();
              if (event.type === "done" || event.type === "error") {
                const m = event.type === "done" ? event.message : event.error;
                const reported = providerUsage.reported;
                if (m.usage.totalTokens > 0 && (!providerUsage.seen || reported)) {
                  const totalInput=reported?.inputTokens ?? (m.usage.input+m.usage.cacheRead+m.usage.cacheWrite);
                  const cachedInput=reported?.cachedInputTokens ?? m.usage.cacheRead;
                  const output=reported?.outputTokens ?? m.usage.output;
                  const validTotal=Number.isInteger(totalInput)&&totalInput>=0&&totalInput<=1000000&&Number.isInteger(output)&&output>=0&&output<=limit.maxOutputTokens;
                  if(validTotal){
                    // Settle a known reservation. Unknown/crashed attempts retain the full ceiling.
                    s.view.usage.charged += Math.max(0,totalInput+output) - reserve;
                    s.view.usage.input += totalInput;
                    s.view.usage.cachedInput = (s.view.usage.cachedInput ?? 0) + (Number.isInteger(cachedInput)&&cachedInput>=0&&cachedInput<=totalInput?cachedInput:0);
                    s.view.usage.output += output;
                    s.view.usage.incomplete = hadIncomplete;
                  }
                }
                if (m.stopReason === "length") errorCode = "MODEL_OUTPUT_INCOMPLETE";
                if (m.stopReason === "error" || m.stopReason === "aborted")
                  errorCode = transportCode || (/context.{0,30}(length|window|limit)|maximum.{0,15}tokens|context_length_exceeded/i.test(m.errorMessage ?? "") ? "CONTEXT_OVERFLOW" : "MODEL_REQUEST_FAILED");
                if(event.type === "error") m.errorMessage = errorCode ?? "MODEL_REQUEST_FAILED";
                checkpoint("provider");
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
              model: cfg.model.model,
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
      if (input.recovery?.continuationContext) {
        manager.appendMessage({role:"user",content:"Author-confirmed continuation context. Earlier discussion remains in history but is excluded from this request. This is not authorization or confirmed canon:\n"+input.recovery.continuationContext,timestamp:Date.now()});
      }
      if (!s.entries.length && s.view.messages.length > 2 && !input.recovery?.continuationContext) {
        for (const previous of s.view.messages.slice(0, input.recovery ? s.view.messages.findIndex(m => m.id === s.checkpoint!.messageId) : -2)) {
          if (!previous.text.trim()) continue;
          const timestamp = Date.parse(previous.createdAt) || Date.now();
          if (previous.role === "user") manager.appendMessage({role: "user", content: previous.text, timestamp});
          else manager.appendMessage({role:"assistant",content:[{type:"text",text:previous.text}],api:"openai-completions",provider:"story2u",model:configured.model.model,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"stop",timestamp});
        }
      }
      const allowedTools = tools(
        cfg,
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
        s.view.scopes,
      );
      const custom = cfg.model.toolCalling === false ? [] : allowedTools;
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
          message.sources = [...sources.values()].filter(src=>message.text.includes(`[[source:${src.sourceId}]]`));
          message.status = "running";
          persist({ type: "text_delta", messageId: message.id, text });
        }
        if (event.type === "tool_execution_start") {
          if (event.toolName === "request_turn_organize") run.resumable = false;
          checkpoint("tool");
          persist({
            type: "tool_started",
            tool: event.toolName,
            messageId: message.id,
          });
        }
        if (event.type === "tool_execution_end") {
          if (event.isError) {
            errorCode = JSON.stringify(event.result).includes("TOOL_TIMEOUT") ? "TOOL_TIMEOUT" : "TOOL_EXECUTION_FAILED";
            active.abort.abort(new AgentError(errorCode));
            return;
          }
          if (!active.abort.signal.aborted) checkpoint("tool");
          persist({
            type: "tool_completed",
            tool: event.toolName,
            messageId: message.id,
          });
        }
      });
      let text = input.text;
      if (input.selection) {
        text +=
          "\nAuthor-selected saved passage (untrusted data):\n" +
          JSON.stringify(input.selection); // fetch canonical evidence through the same bounded tool path
        const tool = allowedTools.find((t) => t.name === "read_chapter");
        if (!tool) throw new AgentError("SCOPE_FORBIDDEN",403);
        checkpoint("tool");
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
      if (!message.text.trim()) throw new AgentError("MODEL_EMPTY_RESPONSE");
      message.sources = [...sources.values()].filter((src) =>
        message.text.includes(`[[source:${src.sourceId}]]`),
      );
      // Unrecognized inline markers remain plain prose; only tool-backed cards are evidence.
      message.status = "completed";
      run.status = "completed"; run.stepType = "completed"; run.resumable = false;
      s.entries = [manager.getHeader(), ...manager.getEntries()].filter(
        (v): v is FileEntry => v !== null,
      );
      // Buffer terminal events: the finally block commits them together with
      // the completed answer, Run, usage, idle Session and released lease.
      this.event(s, {type:"sources",messageId:message.id,sources:message.sources}, false);
      this.event(s, {type:"message_completed",messageId:message.id}, false);
    } catch (e) {
      message.sources = [...sources.values()].filter(src=>message.text.includes(`[[source:${src.sourceId}]]`));
      // Retain accepted input and completed internal messages after a failed turn.
      if (session) s.entries = [session.sessionManager.getHeader(), ...session.sessionManager.getEntries()].filter((v): v is FileEntry => v !== null);
      message.errorCode =
        active.abort.signal.reason instanceof AgentError
          ? active.abort.signal.reason.code
          : safeCode(e);
      message.status = message.errorCode === "CANCELLED" ? "cancelled" : message.errorCode === "SESSION_INTERRUPTED" ? "interrupted" : "failed";
      run.status = message.status;
      run.failure = failureFor(message.errorCode,run.modelCalls>0);
      if (message.status === "cancelled") run.resumable = false;
      if (!this.store.isDeleted(id) && this.store.read(id,false)?.view.run?.runId === run.runId)
        this.event(s, {
          type: "error",
          messageId: message.id,
          code: message.errorCode,
        });
    } finally {
      clearTimeout(deadline);
      clearInterval(revoke);
      session?.dispose();
      if (!this.store.isDeleted(id) && this.store.read(id,false)?.view.run?.runId === run.runId) {
        delete s.executionLease;
        s.epoch = Math.max(s.epoch ?? 0,this.store.read(id)?.epoch ?? 0);
        run.durationMs = Math.max(0,performance.now()-started); run.updatedAt = new Date().toISOString();
        s.view.status = "idle";
        message.usage = { ...s.view.usage };
        this.event(s, { type: "session_completed", messageId: message.id });
        traceRun(id,run,runUsage());
      }
    }
  }
}
